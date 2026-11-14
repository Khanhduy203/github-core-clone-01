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
    const body = encodePktLines([
      '# service=git-upload-pack\n',
      'flush',
      'version 2\n',
      `agent=${AGENT}\n`,
      'ls-refs\n',
      'fetch=shallow thin-pack ofs-delta\n',
      'object-format=sha1\n',
      'flush',
    ]);
    return binaryResult(200, body, UPLOAD_ADVERTISEMENT);
  }
  const refs = sortedRefs(repo);
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const parts: Buffer[] = [encodePktLine('# service=git-upload-pack\n'), pktLineFlush()];
  if (tip === undefined && refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${UPLOAD_V0_CAPS}\n`));
  } else {
    parts.push(encodePktLine(`${tip ?? ZERO_OID} HEAD\u0000${UPLOAD_V0_CAPS}\n`));
    for (const ref of refs) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      const object = repo.objects.get(ref.oid);
      if (ref.name.startsWith('refs/tags/') && object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(forgeLookup(repo), ref.oid);
        if (peeled !== null) parts.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(pktLineFlush());
  return binaryResult(200, Buffer.concat(parts), UPLOAD_ADVERTISEMENT);
}

function advertiseReceivePack(repo: Repo): HandlerResult {
  const refs = sortedRefs(repo);
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const parts: Buffer[] = [encodePktLine('# service=git-receive-pack\n'), pktLineFlush()];
  if (tip === undefined && refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${RECEIVE_V0_CAPS}\n`));
  } else {
    parts.push(encodePktLine(`${tip ?? ZERO_OID} HEAD\u0000${RECEIVE_V0_CAPS}\n`));
    for (const ref of refs) parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
  }
  parts.push(pktLineFlush());
  return binaryResult(200, Buffer.concat(parts), RECEIVE_ADVERTISEMENT);
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
  for (const ref of sortedRefs(repo)) {
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
  const parts = lines.map((line) => encodePktLine(line));
  parts.push(pktLineFlush());
  return binaryResult(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

interface FetchPlan {
  /** Objects to send, in pack order (commits first, then trees, then blobs, tags last). */
  readonly send: GitObject[];
  readonly sendOids: ReadonlySet<string>;
  readonly shallow: string[];
  readonly unshallow: string[];
  readonly acks: string[];
}

function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  deepen: number | null,
): FetchPlan {
  const lookup = forgeLookup(repo);
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
  return { send, sendOids, shallow, unshallow, acks };
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
  const plan = planFetch(repo, wants, haves, clientShallow, deepen);
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
    const ackSection: Buffer[] = [encodePktLine('acknowledgments\n')];
    let ready = false;
    if (plan.acks.length > 0) {
      for (const ack of plan.acks) ackSection.push(encodePktLine(`ACK ${ack}\n`));
      if (!waitForDone) {
        ackSection.push(encodePktLine('ready\n'));
        ready = true;
      }
    } else {
      ackSection.push(encodePktLine('NAK\n'));
    }
    if (!ready) {
      // No "ready": negotiation continues; the response ends here.
      return binaryResult(200, Buffer.concat([...ackSection, pktLineFlush()]), 'application/x-git-upload-pack-result');
    }
    const sections: Buffer[][] = [ackSection];
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      const shallowSection: Buffer[] = [encodePktLine('shallow-info\n')];
      for (const oid of plan.shallow) shallowSection.push(encodePktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) shallowSection.push(encodePktLine(`unshallow ${oid}\n`));
      sections.push(shallowSection);
    }
    sections.push([encodePktLine('packfile\n'), ...sidebandPack(writePack(plan.send))]);
    const parts: Buffer[] = [];
    sections.forEach((section, index) => {
      if (index > 0) parts.push(pktLineDelim());
      parts.push(...section);
    });
    parts.push(pktLineFlush());
    return binaryResult(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
  }
  const sections: Buffer[][] = [];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const shallowSection: Buffer[] = [encodePktLine('shallow-info\n')];
    for (const oid of plan.shallow) shallowSection.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) shallowSection.push(encodePktLine(`unshallow ${oid}\n`));
    sections.push(shallowSection);
  }
  sections.push([encodePktLine('packfile\n'), ...sidebandPack(writePack(plan.send))]);
  const parts: Buffer[] = [];
  sections.forEach((section, index) => {
    if (index > 0) parts.push(pktLineDelim());
    parts.push(...section);
  });
  parts.push(pktLineFlush());
  return binaryResult(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
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
  const plan = planFetch(repo, wants, haves, clientShallow, deepen);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  if (plan.send.length > 0) {
    const pack = writePack(plan.send);
    parts.push(...sidebandPack(pack));
  }
  parts.push(pktLineFlush());
  return binaryResult(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
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
  const inner: Buffer[] = [encodePktLine(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`)];
  for (const result of results) {
    inner.push(encodePktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`));
  }
  inner.push(pktLineFlush());
  const innerBuf = Buffer.concat(inner);
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
