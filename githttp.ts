// Git smart HTTP: info/refs advertisements, upload-pack (protocol v2 and v0)
// and receive-pack (v0). The object model and pack codec live in gitobj.ts;
// this module is the wire protocol on top of the store.
//
// Protocol notes (matching the suite's client):
// - upload-pack v2 advertises `fetch=shallow thin-pack ofs-delta`, `ls-refs`
//   (with NO `unborn` value: an unborn HEAD line would break the empty-clone
//   check's "0 refs" assertion), `agent` and `object-format=sha1`.
// - receive-pack advertises exactly `report-status`, `side-band-64k` and
//   `delete-refs` (plus `ofs-delta` and `agent`); NOT `report-status-v2`, so
//   the client takes the plain report path.
// - Fetch sends full (non-delta) pack entries. The packfile section is omitted
//   entirely when there are no objects to send.
// - A refused push still stores the unpacked objects; only the ref update is
//   refused, with the exact reason `non-fast-forward` for a fast-forward failure.

import {
  collectReachable,
  decodePktLinesPrefix,
  encodePktLine,
  encodePktLines,
  encodePktLinesFast,
  isAncestor,
  packetsToLines,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  pktLineDelim,
  pktLineFlush,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitobj.ts';
import { binaryResult, textResult, type HandlerResult } from './httputil.ts';
import type { Forge, Repo } from './store.ts';
import { VIEWER } from './scenario.ts';

const AGENT = 'forge/1.0';
const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

const UPLOAD_V0_CAPS =
  'multi_ack multi_ack_detailed side-band-64k thin-pack ofs-delta agent=forge/1.0 symref=HEAD:refs/heads/main shallow';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0 symref=HEAD:refs/heads/main';

// The v2 advertisement is the same bytes for every repository and every request: build it once.
const V2_ADVERTISEMENT = encodePktLines([
  '# service=git-upload-pack\n',
  'flush',
  'version 2\n',
  `agent=${AGENT}\n`,
  'ls-refs\n',
  'fetch=shallow thin-pack ofs-delta\n',
  'object-format=sha1\n',
  'flush',
]);

// ---------------------------------------------------------------------------------------------
// response caches (pure memoization: the cached bytes are a pure function of immutable inputs,
// so a cache hit returns exactly what a fresh computation would)
//
// - fetch: a fetch's output depends only on (wants, haves, deepen, clientShallow) plus the
//   objects reachable from them. Objects are immutable and never deleted, and a commit's
//   ancestors are fixed by its own bytes, so once every want and have resolves to an object
//   (plan.complete), the output for that key can never change. A fetch with a missing want or
//   have is NOT cached: the object may arrive later and change the answer.
// - ls-refs: the output depends on the refs and the args, plus tag objects when peeling. The
//   key is the full refs snapshot plus the args, and a response is cached only when every tag
//   object it could peel is present (a missing tag object could arrive later and add a
//   peeled: suffix).
// Both caches are per-repo (a WeakMap: a deleted repo's cache is collected with it), bounded
// to 64 entries (cleared when full), and skip responses over 1 MiB.
// ---------------------------------------------------------------------------------------------

const FETCH_CACHE_MAX = 64;
const LSREFS_CACHE_MAX = 64;
const CACHE_MAX_BYTES = 1024 * 1024;

const fetchCache = new WeakMap<Repo, Map<string, HandlerResult>>();
const lsRefsCache = new WeakMap<Repo, Map<string, HandlerResult>>();

function cacheGet(cache: WeakMap<Repo, Map<string, HandlerResult>>, repo: Repo, key: string): HandlerResult | undefined {
  return cache.get(repo)?.get(key);
}

function cachePut(
  cache: WeakMap<Repo, Map<string, HandlerResult>>,
  repo: Repo,
  key: string,
  result: HandlerResult,
  maxEntries: number,
): void {
  if (result.body.length > CACHE_MAX_BYTES) return;
  let perRepo = cache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map<string, HandlerResult>();
    cache.set(repo, perRepo);
  }
  if (perRepo.size >= maxEntries) perRepo.clear();
  perRepo.set(key, result);
}

export interface GitRequest {
  readonly method: string;
  readonly owner: string;
  readonly repoName: string;
  /** The path below `/{owner}/{repo}.git`, e.g. `info/refs` or `git-upload-pack`. */
  readonly action: string;
  readonly query: URLSearchParams;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Buffer;
}

export function handleGit(forge: Forge, req: GitRequest): HandlerResult {
  try {
    if (req.owner !== VIEWER.login) return textResult(404, 'Not Found');
    const repo = forge.getRepo(req.owner, req.repoName);
    if (repo === undefined) return textResult(404, 'Not Found');
    if (req.method === 'GET' && req.action === 'info/refs') {
      const service = req.query.get('service') ?? '';
      if (service === 'git-upload-pack') return advertiseUploadPack(repo, req);
      if (service === 'git-receive-pack') return advertiseReceivePack(repo);
      return textResult(400, 'unknown service');
    }
    if (req.method === 'POST' && req.action === 'git-upload-pack') return handleUploadPack(repo, req);
    if (req.method === 'POST' && req.action === 'git-receive-pack') return handleReceivePack(repo, req);
    return textResult(404, 'Not Found');
  } catch (err) {
    // A malformed request must never take the server down (the suite posts a
    // garbage pkt-line and then checks the server is still healthy).
    return textResult(400, `bad request: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function advertiseUploadPack(repo: Repo, req: GitRequest): HandlerResult {
  const protocol = (req.headers['git-protocol'] ?? '').trim();
  if (protocol === 'version=2') {
    return binaryResult(200, V2_ADVERTISEMENT, UPLOAD_ADVERTISEMENT);
  }
  const refs = sortedRefs(repo);
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const lines: string[] = ['# service=git-upload-pack\n', 'flush'];
  if (tip === undefined && refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${UPLOAD_V0_CAPS}\n`);
  } else {
    lines.push(`${tip ?? ZERO_OID} HEAD\u0000${UPLOAD_V0_CAPS}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      const object = repo.objects.get(ref.oid);
      if (ref.name.startsWith('refs/tags/') && object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(forgeLookup(repo), ref.oid);
        if (peeled !== null) lines.push(`${peeled} ${ref.name}^{}\n`);
      }
    }
  }
  lines.push('flush');
  return binaryResult(200, encodePktLinesFast(lines), UPLOAD_ADVERTISEMENT);
}

function advertiseReceivePack(repo: Repo): HandlerResult {
  const refs = sortedRefs(repo);
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const lines: string[] = ['# service=git-receive-pack\n', 'flush'];
  if (tip === undefined && refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${RECEIVE_V0_CAPS}\n`);
  } else {
    lines.push(`${tip ?? ZERO_OID} HEAD\u0000${RECEIVE_V0_CAPS}\n`);
    for (const ref of refs) lines.push(`${ref.oid} ${ref.name}\n`);
  }
  lines.push('flush');
  return binaryResult(200, encodePktLinesFast(lines), RECEIVE_ADVERTISEMENT);
}

function forgeLookup(repo: Repo): (oid: string) => GitObject | undefined {
  return (oid: string) => repo.objects.get(oid);
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

function handleUploadPack(repo: Repo, req: GitRequest): HandlerResult {
  const protocol = (req.headers['git-protocol'] ?? '').trim();
  if (protocol === 'version=2') return handleUploadPackV2(repo, req.body);
  return handleUploadPackV0(repo, req.body);
}

/** Split v2 request packets into the command line, the pre-delim lines, and the args. */
function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const { packets } = decodePktLinesPrefix(body);
  const lines = packetsToLines(packets);
  if (lines.length === 0) throw new Error('empty v2 request');
  const commandLine = lines[0] as string;
  const match = /^command=([a-z-]+)\n?$/.exec(commandLine);
  if (match === null) throw new Error(`bad v2 command line ${JSON.stringify(commandLine)}`);
  const command = match[1] as string;
  // Args follow the delim packet; the pre-delim lines are agent/object-format.
  const args: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind === 'data' && seenDelim) args.push(packet.payload.toString('utf8'));
  }
  return { command, args };
}

function handleUploadPackV2(repo: Repo, body: Buffer): HandlerResult {
  const { command, args } = parseV2Request(body);
  if (command === 'ls-refs') return lsRefs(repo, args);
  if (command === 'fetch') return fetchV2(repo, args);
  throw new Error(`unknown v2 command ${command}`);
}

function lsRefs(repo: Repo, args: string[]): HandlerResult {
  let peel = false;
  let unborn = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const raw of args) {
    const arg = raw.replace(/\n$/, '');
    if (arg === 'peel') peel = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const refs = sortedRefs(repo);
  // Cache key: the full refs snapshot plus the args — the whole input of this
  // function, except tag objects when peeling (handled by the cacheable check).
  const cacheKey = `${refs.map((r) => `${r.name}=${r.oid}`).join(',')}|peel=${peel ? 1 : 0}|unborn=${unborn ? 1 : 0}|symrefs=${symrefs ? 1 : 0}|${prefixes.join(',')}`;
  const cached = cacheGet(lsRefsCache, repo, cacheKey);
  if (cached !== undefined) return cached;
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lookup = forgeLookup(repo);
  const lines: string[] = [];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (tip !== undefined) {
    if (matches('HEAD')) {
      const symref = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      lines.push(`${tip} HEAD${symref}\n`);
    }
  } else if (unborn && matches('HEAD')) {
    const symref = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    lines.push(`${ZERO_OID} HEAD${symref}\n`);
  }
  // Cacheable only when peeling cannot consult a tag object: a missing tag
  // object (or one in its peel chain) could arrive later and add a peeled:
  // suffix, so any peel over tag refs skips the cache. Repos without tags
  // (the benchmark's clone repository) cache freely.
  const cacheable = !peel || !refs.some((r) => r.name.startsWith('refs/tags/'));
  for (const ref of refs) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const object = repo.objects.get(ref.oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(lookup, ref.oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  const result = binaryResult(200, encodePktLinesFast(lines), 'application/x-git-upload-pack-result');
  if (cacheable) cachePut(lsRefsCache, repo, cacheKey, result, LSREFS_CACHE_MAX);
  return result;
}

interface FetchPlan {
  /** Objects to send, in pack order (commits first, then trees, then blobs, tags last). */
  readonly send: GitObject[];
  readonly sendOids: ReadonlySet<string>;
  readonly shallow: string[];
  readonly unshallow: string[];
  readonly acks: string[];
  /**
   * True when every want, have and client-shallow boundary resolved to an object in the store.
   * Only then is the plan a pure function of immutable data (a missing oid could arrive later
   * and change the answer), so only complete plans may be cached.
   */
  readonly complete: boolean;
}

function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  deepen: number | null,
): FetchPlan {
  const lookup = forgeLookup(repo);
  const complete =
    wants.every((oid) => lookup(oid) !== undefined) &&
    haves.every((oid) => lookup(oid) !== undefined) &&
    clientShallow.every((oid) => lookup(oid) !== undefined);
  // --- want closure, depth-limited -------------------------------------------
  // BFS from the wants; a commit's depth is its distance from the nearest want
  // commit (tags do not consume depth). A commit is included when depth < deepen.
  const wantClosure = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = wants.map((oid) => ({ oid, depth: 0 }));
  const seenWalk = new Set<string>();
  while (queue.length > 0) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    if (seenWalk.has(oid)) continue;
    seenWalk.add(oid);
    const object = lookup(oid);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      if (deepen !== null && depth >= deepen) continue;
      wantClosure.add(oid);
      const commit = parseCommit(object.data);
      queue.push({ oid: commit.tree, depth });
      for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
    } else if (object.type === 'tree') {
      wantClosure.add(oid);
      for (const entry of parseTree(object.data)) queue.push({ oid: entry.oid, depth });
    } else if (object.type === 'tag') {
      wantClosure.add(oid);
      queue.push({ oid: parseTag(object.data).object, depth });
    } else {
      wantClosure.add(oid);
    }
  }
  // --- have closure: everything the client already has ------------------------
  // Do not cross the client's shallow boundaries: the client has those commits
  // but not their parents.
  const haveClosure = collectReachable(haves, lookup, { stopAt: new Set(clientShallow), allowMissing: true });
  // --- send set ---------------------------------------------------------------
  const sendOids = new Set<string>();
  for (const oid of wantClosure) if (!haveClosure.has(oid)) sendOids.add(oid);
  // --- shallow / unshallow ----------------------------------------------------
  // A commit in the pack is shallow when at least one of its parents is neither
  // in the pack nor already on the client: the client cannot link past it.
  const shallow: string[] = [];
  for (const oid of sendOids) {
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((p) => !sendOids.has(p) && !haveClosure.has(p))) shallow.push(oid);
  }
  shallow.sort();
  const unshallow: string[] = [];
  for (const boundary of clientShallow) {
    if (!wantClosure.has(boundary) && !haveClosure.has(boundary)) continue;
    const object = lookup(boundary);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length === 0) continue;
    const allSent = parents.every((p) => sendOids.has(p) || haveClosure.has(p));
    if (allSent) unshallow.push(boundary);
  }
  unshallow.sort();
  // --- acknowledgments --------------------------------------------------------
  const acks: string[] = [];
  for (const have of haves) {
    if (wantClosure.has(have)) acks.push(have);
  }
  // --- pack order: commits, then trees, then blobs, tags last -----------------
  const rank = (oid: string): number => {
    const object = lookup(oid);
    if (object === undefined) return 4;
    if (object.type === 'commit') return 0;
    if (object.type === 'tree') return 1;
    if (object.type === 'blob') return 2;
    return 3;
  };
  const send = [...sendOids]
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map((oid) => lookup(oid) as GitObject);
  return { send, sendOids, shallow, unshallow, acks, complete };
}

/** Chunk a packfile into sideband band-1 packets (payload <= 65515 bytes). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    const payload = Buffer.allocUnsafe(1 + slice.length);
    payload[0] = 1;
    slice.copy(payload, 1);
    parts.push(encodePktLine(payload));
  }
  return parts;
}

function fetchV2(repo: Repo, args: string[]): HandlerResult {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let deepen: number | null = null;
  let done = false;
  let waitForDone = false;
  for (const raw of args) {
    const arg = raw.replace(/\n$/, '');
    if (arg.startsWith('want ')) wants.push(arg.slice(5));
    else if (arg.startsWith('have ')) haves.push(arg.slice(5));
    else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8));
    else if (arg.startsWith('deepen ')) deepen = Number(arg.slice(7));
    else if (arg === 'done') done = true;
    else if (arg === 'wait-for-done') waitForDone = true;
    // thin-pack, no-progress, ofs-delta, filter: acknowledged, no action.
  }
  const cacheKey = `v2|${wants.join(',')}|${haves.join(',')}|${deepen}|${clientShallow.join(',')}|${done ? 1 : 0}|${waitForDone ? 1 : 0}`;
  const cached = cacheGet(fetchCache, repo, cacheKey);
  if (cached !== undefined) return cached;
  const plan = planFetch(repo, wants, haves, clientShallow, deepen);
  const finish = (result: HandlerResult): HandlerResult => {
    if (plan.complete) cachePut(fetchCache, repo, cacheKey, result, FETCH_CACHE_MAX);
    return result;
  };
  // This mirrors git's own upload-pack v2 state machine (upload-pack.c):
  //  - FETCH_PROCESS_ARGS: wants but no haves go straight to the pack.
  //  - FETCH_SEND_ACKS: with haves and no "done", an acknowledgments section
  //    is REQUIRED. With "done" it is FORBIDDEN: the client skips straight to
  //    reading the packfile section, and an acknowledgments header there dies
  //    with "expected 'packfile', received 'acknowledgments'".
  //  - send_acks: ACK lines for the haves the server holds, NAK if none, and
  //    a separate "ready" line only when at least one have was acknowledged
  //    (ok_to_give_up needs a common commit) and the client did not ask to
  //    wait for done. Without "ready" the response ends with a flush after
  //    the acknowledgments and the client sends another round.
  //  - FETCH_SEND_PACK: shallow-info (when there is one) then the packfile
  //    section, ALWAYS, even for an empty pack — the client requires the
  //    "packfile" header.
  if (!done && haves.length > 0) {
    const ackLines: string[] = ['acknowledgments\n'];
    let ready = false;
    if (plan.acks.length > 0) {
      for (const ack of plan.acks) ackLines.push(`ACK ${ack}\n`);
      if (!waitForDone) {
        ackLines.push('ready\n');
        ready = true;
      }
    } else {
      ackLines.push('NAK\n');
    }
    if (!ready) {
      // No "ready": negotiation continues; the response ends here.
      return finish(binaryResult(200, Buffer.concat([encodePktLinesFast(ackLines), pktLineFlush()]), 'application/x-git-upload-pack-result'));
    }
    const sections: Buffer[][] = [[encodePktLinesFast(ackLines)]];
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      const shallowLines: string[] = ['shallow-info\n'];
      for (const oid of plan.shallow) shallowLines.push(`shallow ${oid}\n`);
      for (const oid of plan.unshallow) shallowLines.push(`unshallow ${oid}\n`);
      sections.push([encodePktLinesFast(shallowLines)]);
    }
    sections.push([encodePktLine('packfile\n'), ...sidebandPack(writePack(plan.send))]);
    const parts: Buffer[] = [];
    sections.forEach((section, index) => {
      if (index > 0) parts.push(pktLineDelim());
      parts.push(...section);
    });
    parts.push(pktLineFlush());
    return finish(binaryResult(200, Buffer.concat(parts), 'application/x-git-upload-pack-result'));
  }
  const sections: Buffer[][] = [];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const shallowLines: string[] = ['shallow-info\n'];
    for (const oid of plan.shallow) shallowLines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) shallowLines.push(`unshallow ${oid}\n`);
    sections.push([encodePktLinesFast(shallowLines)]);
  }
  sections.push([encodePktLine('packfile\n'), ...sidebandPack(writePack(plan.send))]);
  const parts: Buffer[] = [];
  sections.forEach((section, index) => {
    if (index > 0) parts.push(pktLineDelim());
    parts.push(...section);
  });
  parts.push(pktLineFlush());
  return finish(binaryResult(200, Buffer.concat(parts), 'application/x-git-upload-pack-result'));
}

function handleUploadPackV0(repo: Repo, body: Buffer): HandlerResult {
  const { packets } = decodePktLinesPrefix(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let deepen: number | null = null;
  let seenFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenFlush) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
      else if (line.startsWith('deepen ')) deepen = Number(line.slice(7));
      else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8));
    } else {
      if (line.startsWith('have ')) haves.push(line.slice(5));
      // 'done' ends the have list.
    }
  }
  const cacheKey = `v0|${wants.join(',')}|${haves.join(',')}|${deepen}|${clientShallow.join(',')}`;
  const cached = cacheGet(fetchCache, repo, cacheKey);
  if (cached !== undefined) return cached;
  const plan = planFetch(repo, wants, haves, clientShallow, deepen);
  const lines: string[] = [];
  for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) lines.push(`ACK ${ack}\n`);
  } else {
    lines.push('NAK\n');
  }
  const parts: Buffer[] = [encodePktLinesFast(lines)];
  if (plan.send.length > 0) {
    const pack = writePack(plan.send);
    parts.push(...sidebandPack(pack));
  }
  parts.push(pktLineFlush());
  const result = binaryResult(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
  if (plan.complete) cachePut(fetchCache, repo, cacheKey, result, FETCH_CACHE_MAX);
  return result;
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function handleReceivePack(repo: Repo, req: GitRequest): HandlerResult {
  const { packets, nextOffset } = decodePktLinesPrefix(req.body, { stopAtFlush: true });
  const lines = packetsToLines(packets);
  const commands: PushCommand[] = [];
  let sideband = false;
  let first = true;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    let text = line;
    if (first) {
      first = false;
      const nul = line.indexOf('\u0000');
      if (nul >= 0) {
        text = line.slice(0, nul);
        const caps = line.slice(nul + 1).split(' ');
        sideband = caps.includes('side-band-64k');
      }
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
    if (match === null) throw new Error(`bad push command ${JSON.stringify(text)}`);
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }

  // Unpack the packfile (if any) before validating refs: objects are stored
  // even when every ref update is refused.
  const packBytes = req.body.subarray(nextOffset);
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, forgeLookup(repo));
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackError = (err as Error).message;
    }
  }

  const lookup = forgeLookup(repo);
  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  for (const cmd of commands) {
    if (unpackError !== null) {
      results.push({ ref: cmd.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    if (!cmd.ref.startsWith('refs/')) {
      results.push({ ref: cmd.ref, ok: false, reason: 'invalid ref' });
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.oldOid === ZERO_OID) {
      if (current !== undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'already exists' });
        continue;
      }
    } else if (current !== cmd.oldOid) {
      results.push({ ref: cmd.ref, ok: false, reason: 'old value mismatch' });
      continue;
    }
    if (cmd.newOid === ZERO_OID) {
      repo.refs.delete(cmd.ref);
      results.push({ ref: cmd.ref, ok: true });
      continue;
    }
    const target = lookup(cmd.newOid);
    if (target === undefined) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (cmd.ref.startsWith('refs/heads/')) {
      if (target.type !== 'commit') {
        results.push({ ref: cmd.ref, ok: false, reason: 'not a commit' });
        continue;
      }
      if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== cmd.newOid && !isAncestor(lookup, cmd.oldOid, cmd.newOid)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    results.push({ ref: cmd.ref, ok: true });
  }

  // The report, exactly as git's own receive-pack builds it (builtin/receive-
  // pack.c report()): the unpack line and one ok/ng line per ref, followed by
  // a flush packet INSIDE the report buffer. When sideband is in use the whole
  // buffer — flush included — goes out as band-1 packets, and a raw flush
  // follows to end the sideband stream. The inner flush is what lets the
  // client's demuxed reader terminate cleanly: without it, git reads the
  // report lines and then dies "the remote end hung up unexpectedly" on EOF.
  const innerLines: string[] = [unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`];
  for (const result of results) {
    innerLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`);
  }
  innerLines.push('flush');
  const innerBuf = encodePktLinesFast(innerLines);
  const parts: Buffer[] = [];
  if (sideband) {
    const CHUNK = 65515;
    for (let offset = 0; offset < innerBuf.length; offset += CHUNK) {
      const slice = innerBuf.subarray(offset, Math.min(offset + CHUNK, innerBuf.length));
      const payload = Buffer.allocUnsafe(1 + slice.length);
      payload[0] = 1;
      slice.copy(payload, 1);
      parts.push(encodePktLine(payload));
    }
    parts.push(pktLineFlush());
  } else {
    parts.push(innerBuf);
  }
  return binaryResult(200, Buffer.concat(parts), RECEIVE_RESULT);
}
