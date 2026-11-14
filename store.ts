// The forge's in-memory store: repositories, git objects and refs, issues,
// pull requests, labels and comments.
//
// Determinism: every timestamp in the store comes from a logical clock — a
// fixed base epoch plus a monotonic counter — never from Date.now(). The same
// request sequence therefore produces the same bytes in live and replay runs,
// which is what the trial's byte-identical state-export check requires. (Git
// commit timestamps use the same clock, so commit SHAs are deterministic too.)
// Issue and PR numbers share one counter per repository, as on GitHub.

import {
  buildCommit,
  buildTree,
  flattenTree,
  hashObject,
  isObjectId,
  mergeBase,
  parseCommit,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';
import { VIEWER } from './scenario.ts';

// 2026-11-14T00:00:00Z — the competition's opening day, as a fixed base epoch.
const CLOCK_BASE = 1794614400;

let tick = 0;

/** The next logical timestamp, in Unix seconds. */
export function nowSec(): number {
  tick += 1;
  return CLOCK_BASE + tick;
}

/** The next logical timestamp, as an ISO-8601 string. */
export function nowIso(): string {
  return new Date(nowSec() * 1000).toISOString();
}

export interface Label {
  readonly id: number;
  readonly name: string;
  readonly color: string;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly authorLogin: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  readonly repoDbId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  readonly comments: Comment[];
  readonly seq: number;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  readonly authorLogin: string;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  readonly repoDbId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly headRef: string;
  readonly baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly comments: Comment[];
  readonly seq: number;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  readonly authorLogin: string;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly seq: number;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, Pull>;
  readonly labels: Map<string, Label>;
  nextNumber: number;
}

export type Item = Issue | Pull;

export function isPull(item: Item): item is Pull {
  return 'headRef' in item;
}

let nextRepoId = 1;
let nextItemId = 1;
let nextCommentId = 1;
let nextLabelId = 1;
let nextRepoSeq = 0;

export class Forge {
  readonly repos = new Map<string, Repo>();

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.repoKey(owner, name))) return null;
    const createdAt = nowIso();
    const repo: Repo = {
      id: nextRepoId,
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt,
      updatedAt: createdAt,
      seq: nextRepoSeq,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
    };
    nextRepoId += 1;
    nextRepoSeq += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  /** Look an object up in a repo. Bound per repo for the git layer. */
  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** Resolve a ref name (branch, or a raw commit oid) to a commit oid, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (ref === 'HEAD') {
      return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) return tag;
    if (isObjectId(ref)) {
      const object = repo.objects.get(ref);
      if (object !== undefined && object.type === 'commit') return ref;
    }
    return null;
  }

  /** The tip of a branch, or null when the branch does not exist. */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing !== undefined) return existing;
    const label: Label = { id: nextLabelId, name, color };
    nextLabelId += 1;
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): Issue | { error: string } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (label === undefined) return { error: `Label does not exist: ${name}` };
      labels.push(label);
    }
    const createdAt = nowIso();
    const issue: Issue = {
      id: nextItemId,
      number: repo.nextNumber,
      repoDbId: repo.id,
      title,
      body,
      state: 'open',
      labels,
      comments: [],
      seq: repo.nextNumber,
      createdAt,
      updatedAt: createdAt,
      closedAt: null,
      authorLogin: VIEWER.login,
    };
    nextItemId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | { error: string } {
    if (this.branchTip(repo, headRef) === null) return { error: `Head branch does not exist: ${headRef}` };
    if (this.branchTip(repo, baseRef) === null) return { error: `Base branch does not exist: ${baseRef}` };
    const createdAt = nowIso();
    const pull: Pull = {
      id: nextItemId,
      number: repo.nextNumber,
      repoDbId: repo.id,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      comments: [],
      seq: repo.nextNumber,
      createdAt,
      updatedAt: createdAt,
      closedAt: null,
      authorLogin: VIEWER.login,
    };
    nextItemId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  addComment(item: Item, body: string): Comment {
    const createdAt = nowIso();
    const comment: Comment = { id: nextCommentId, body, authorLogin: VIEWER.login, createdAt, updatedAt: createdAt };
    nextCommentId += 1;
    item.comments.push(comment);
    return comment;
  }

  /** An issue or PR by number (they share the number space). */
  getItem(repo: Repo, number: number): Item | undefined {
    return repo.issues.get(number) ?? repo.pulls.get(number);
  }

  // -------------------------------------------------------------------------------------------
  // git writes (contents API and merges)
  // -------------------------------------------------------------------------------------------

  /** Store an object, returning its oid. */
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /**
   * Build the nested tree objects for a flat path -> blob map, storing every new
   * tree, and return the root tree's oid.
   */
  buildTrees(repo: Repo, flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
    const buildDir = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Set<string>();
      for (const [path, file] of flat) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) entries.push({ mode: file.mode, name: rest, oid: file.oid });
        else dirs.add(rest.slice(0, slash));
      }
      for (const dir of dirs) {
        entries.push({ mode: '40000', name: dir, oid: buildDir(`${prefix}${dir}/`) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return buildDir('');
  }

  /**
   * Commit a set of file changes on `branch`: `changes` maps a path to new blob
   * bytes, or null to delete the path. `parentOid` is the branch tip, or null to
   * create the first commit on an unborn branch. Returns the new commit's oid.
   */
  commitFiles(
    repo: Repo,
    branch: string,
    message: string,
    changes: ReadonlyMap<string, Buffer | null>,
    parentOid: string | null,
  ): { sha: string; tree: string } {
    const lookup = this.lookup(repo);
    const flat = new Map<string, { oid: string; mode: string }>();
    if (parentOid !== null) {
      const parent = repo.objects.get(parentOid);
      if (parent !== undefined && parent.type === 'commit') {
        for (const [path, file] of flattenTree(lookup, parseCommit(parent.data).tree)) flat.set(path, file);
      }
    }
    for (const [path, content] of changes) {
      if (content === null) flat.delete(path);
      else flat.set(path, { oid: this.putObject(repo, 'blob', content), mode: '100644' });
    }
    const tree = this.buildTrees(repo, flat);
    const identity = `${VIEWER.name} <${VIEWER.email}>`;
    const commit = buildCommit({
      tree,
      parents: parentOid === null ? [] : [parentOid],
      message,
      author: identity,
      committer: identity,
      timestamp: nowSec(),
    });
    const sha = this.putObject(repo, 'commit', commit);
    repo.refs.set(`refs/heads/${branch}`, sha);
    repo.updatedAt = nowIso();
    return { sha, tree };
  }

  // -------------------------------------------------------------------------------------------
  // pull request merge and diff
  // -------------------------------------------------------------------------------------------

  /** The merge base of a pull request's head and base tips, or null when unmerged histories. */
  prMergeBase(repo: Repo, pull: Pull): string | null {
    const head = this.branchTip(repo, pull.headRef);
    const base = this.branchTip(repo, pull.baseRef);
    if (head === null || base === null) return null;
    return mergeBase(this.lookup(repo), head, base);
  }

  /** The paths a pull request changes, against its merge base. */
  prFiles(repo: Repo, pull: Pull): FileChange[] {
    const head = this.branchTip(repo, pull.headRef);
    if (head === null) return [];
    const base = this.prMergeBase(repo, pull);
    const lookup = this.lookup(repo);
    const headCommit = repo.objects.get(head);
    if (headCommit === undefined || headCommit.type !== 'commit') return [];
    const headFlat = flattenTree(lookup, parseCommit(headCommit.data).tree);
    let baseFlat = new Map<string, { oid: string; mode: string }>();
    if (base !== null) {
      const baseCommit = repo.objects.get(base);
      if (baseCommit !== undefined && baseCommit.type === 'commit') {
        baseFlat = flattenTree(lookup, parseCommit(baseCommit.data).tree);
      }
    }
    return diffFlats(repo, baseFlat, headFlat);
  }

  /**
   * The three-way merge computation, without writing anything: the merged file
   * map, or a conflict/error. Shared by mergePull and the GraphQL `mergeable`
   * field so the two can never disagree.
   */
  computeMerge(
    repo: Repo,
    pull: Pull,
  ):
    | { ok: true; merged: Map<string, { oid: string; mode: string }>; base: string; head: string }
    | { ok: false; reason: 'conflict' | 'error' } {
    const head = this.branchTip(repo, pull.headRef);
    const base = this.branchTip(repo, pull.baseRef);
    if (head === null || base === null) return { ok: false, reason: 'error' };
    const lookup = this.lookup(repo);
    const baseOid = mergeBase(lookup, head, base);
    const baseCommit = repo.objects.get(base);
    const headCommit = repo.objects.get(head);
    if (baseCommit === undefined || headCommit === undefined) return { ok: false, reason: 'error' };
    const baseFlat = flattenTree(lookup, parseCommit(baseCommit.data).tree);
    const headFlat = flattenTree(lookup, parseCommit(headCommit.data).tree);
    let mergeBaseFlat = new Map<string, { oid: string; mode: string }>();
    if (baseOid !== null) {
      const mbCommit = repo.objects.get(baseOid);
      if (mbCommit !== undefined && mbCommit.type === 'commit') {
        mergeBaseFlat = flattenTree(lookup, parseCommit(mbCommit.data).tree);
      }
    }
    // Three-way merge at file granularity: a path changed on both sides to
    // different contents is a conflict; anything else takes the changed side.
    const merged = new Map<string, { oid: string; mode: string }>(baseFlat);
    const paths = new Set<string>([...mergeBaseFlat.keys(), ...headFlat.keys(), ...baseFlat.keys()]);
    for (const path of paths) {
      const mb = mergeBaseFlat.get(path);
      const h = headFlat.get(path);
      const b = baseFlat.get(path);
      const headChanged = (h?.oid ?? null) !== (mb?.oid ?? null);
      const baseChanged = (b?.oid ?? null) !== (mb?.oid ?? null);
      if (headChanged && baseChanged && (h?.oid ?? null) !== (b?.oid ?? null)) return { ok: false, reason: 'conflict' };
      if (headChanged) {
        if (h === undefined) merged.delete(path);
        else merged.set(path, h);
      }
    }
    return { ok: true, merged, base, head };
  }

  /** Whether a pull request can merge: MERGEABLE, CONFLICTING, or UNKNOWN (closed or uncomputable). */
  prMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const computed = this.computeMerge(repo, pull);
    if (!computed.ok) return computed.reason === 'conflict' ? 'CONFLICTING' : 'UNKNOWN';
    return 'MERGEABLE';
  }

  /**
   * Merge a pull request. Returns the merge commit's sha, or `{ conflict: true }`
   * when the same file changed differently on both sides since the merge base,
   * or `{ error }` when the branches are missing.
   */
  mergePull(repo: Repo, pull: Pull, method: string): { sha: string } | { conflict: true } | { error: string } {
    if (pull.state !== 'open') return { error: 'Pull request is not open' };
    const computed = this.computeMerge(repo, pull);
    if (!computed.ok) {
      return computed.reason === 'conflict' ? { conflict: true } : { error: 'Head or base branch does not exist' };
    }
    const { merged, base, head } = computed;
    const tree = this.buildTrees(repo, merged);
    const identity = `${VIEWER.name} <${VIEWER.email}>`;
    const isMergeCommit = method === 'merge';
    const message = isMergeCommit
      ? `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`
      : `${pull.title} (#${pull.number})${pull.body !== '' ? `\n\n${pull.body}` : ''}`;
    const commit = buildCommit({
      tree,
      parents: isMergeCommit ? [base, head] : [base],
      message,
      author: identity,
      committer: identity,
      timestamp: nowSec(),
    });
    const sha = this.putObject(repo, 'commit', commit);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    const mergedAt = nowIso();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = mergedAt;
    pull.mergeCommitSha = sha;
    pull.closedAt = mergedAt;
    pull.updatedAt = mergedAt;
    repo.updatedAt = mergedAt;
    return { sha };
  }
}

export interface FileChange {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

function splitLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Count added/removed lines between two texts via LCS (with a size cap fallback). */
function lineDiff(before: string, after: string): { additions: number; deletions: number } {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > 2000 || b.length > 2000) {
    // Too large for an O(n*m) table: report the whole-file counts. Status is
    // decided by oid inequality, so this only affects the counters.
    return { additions: b.length, deletions: a.length };
  }
  // LCS length, computed with two rows.
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = 0;
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  const lcs = prev[b.length] as number;
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

function diffFlats(
  repo: Repo,
  before: ReadonlyMap<string, { oid: string; mode: string }>,
  after: ReadonlyMap<string, { oid: string; mode: string }>,
): FileChange[] {
  const out: FileChange[] = [];
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  for (const path of paths) {
    const b = before.get(path);
    const a = after.get(path);
    if (b !== undefined && a !== undefined && b.oid === a.oid) continue;
    if (b === undefined && a !== undefined) {
      const blob = repo.objects.get(a.oid);
      const additions = blob === undefined ? 1 : Math.max(1, splitLines(blob.data.toString('utf8')).length);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b !== undefined && a === undefined) {
      const blob = repo.objects.get(b.oid);
      const deletions = blob === undefined ? 1 : Math.max(1, splitLines(blob.data.toString('utf8')).length);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b !== undefined && a !== undefined) {
      const beforeBlob = repo.objects.get(b.oid);
      const afterBlob = repo.objects.get(a.oid);
      const counts = lineDiff(
        beforeBlob === undefined ? '' : beforeBlob.data.toString('utf8'),
        afterBlob === undefined ? '' : afterBlob.data.toString('utf8'),
      );
      out.push({
        filename: path,
        status: 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      });
    }
  }
  out.sort((x, y) => (x.filename < y.filename ? -1 : x.filename > y.filename ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------------------------
// global ids (GitHub-style base64, opaque and stable)
// ---------------------------------------------------------------------------------------------

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

export function repoGid(dbId: number): string {
  return b64(`Repository:${dbId}`);
}

export function issueGid(repoDbId: number, number: number): string {
  return b64(`Issue:${repoDbId}:${number}`);
}

export function pullGid(repoDbId: number, number: number): string {
  return b64(`PullRequest:${repoDbId}:${number}`);
}

export function commentGid(repoDbId: number, commentId: number): string {
  return b64(`IssueComment:${repoDbId}:${commentId}`);
}

export type DecodedGid =
  | { kind: 'Repository'; repoDbId: number }
  | { kind: 'Issue'; repoDbId: number; number: number }
  | { kind: 'PullRequest'; repoDbId: number; number: number }
  | { kind: 'IssueComment'; repoDbId: number; commentId: number };

export function decodeGid(id: string): DecodedGid | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  if (parts[0] === 'Repository' && parts.length === 2) {
    const repoDbId = Number(parts[1]);
    if (Number.isInteger(repoDbId)) return { kind: 'Repository', repoDbId };
  }
  if (parts[0] === 'Issue' && parts.length === 3) {
    const repoDbId = Number(parts[1]);
    const number = Number(parts[2]);
    if (Number.isInteger(repoDbId) && Number.isInteger(number)) return { kind: 'Issue', repoDbId, number };
  }
  if (parts[0] === 'PullRequest' && parts.length === 3) {
    const repoDbId = Number(parts[1]);
    const number = Number(parts[2]);
    if (Number.isInteger(repoDbId) && Number.isInteger(number)) return { kind: 'PullRequest', repoDbId, number };
  }
  if (parts[0] === 'IssueComment' && parts.length === 3) {
    const repoDbId = Number(parts[1]);
    const commentId = Number(parts[2]);
    if (Number.isInteger(repoDbId) && Number.isInteger(commentId)) return { kind: 'IssueComment', repoDbId, commentId };
  }
  return null;
}
