// REST v3 (`/api/v3`): repositories, branches, refs, commits, contents, labels,
// issues, comments and pull requests. All replies are JSON; every reply carries
// X-GitHub-Request-Id (added by app.ts). Errors are `{"message": string}`.
// A repository under any owner other than the viewer is a 404, never a 403.
//
// Shapes mirror GitHub's v3 responses: the suite reads name/private/
// default_branch/description/id off repositories, number/title/body/state/labels
// off issues, head/base refs and shas plus merged/merged_at/merge_commit_sha off
// pull requests, and sha/encoding/content off contents. Extra fields are fine.

import { hashObject, listCommits, parseCommit, parseTree } from './gitobj.ts';
import { jsonResult, parseJsonBody, isRecord, type HandlerResult } from './httputil.ts';
import {
  isPull,
  nowIso,
  type Comment,
  type Forge,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Item,
} from './store.ts';
import { VIEWER, type ScenarioUser } from './scenario.ts';

export interface RestRequest {
  readonly method: string;
  /** Path segments below `/api/v3`, percent-decoded. */
  readonly segments: readonly string[];
  readonly query: URLSearchParams;
  readonly body: Buffer;
  readonly host: string;
}

const notFound = (): HandlerResult => jsonResult(404, { message: 'Not Found' });
const badRequest = (message: string): HandlerResult => jsonResult(400, { message });
const unprocessable = (message: string): HandlerResult => jsonResult(422, { message });

// ---------------------------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------------------------

function userJson(user: ScenarioUser): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    avatar_url: '',
    html_url: `https://github.com/${user.login}`,
    type: 'User',
    site_admin: false,
    name: user.name,
    email: user.email,
  };
}

export function repoJson(repo: Repo, host: string): Record<string, unknown> {
  const base = `http://${host}/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(VIEWER),
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: null,
    language: null,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: base,
    clone_url: `http://${host}/${repo.owner}/${repo.name}.git`,
    git_url: `git://${host}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@${host}:${repo.owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length
      + [...repo.pulls.values()].filter((p) => p.state === 'open').length,
  };
}

function labelJson(label: Label, repo: Repo, host: string): Record<string, unknown> {
  return {
    id: label.id,
    name: label.name,
    color: label.color,
    description: '',
    default: false,
    url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
  };
}

function commentJson(comment: Comment, repo: Repo, host: string): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(VIEWER),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

export function issueJson(issue: Issue, repo: Repo, host: string): Record<string, unknown> {
  const base = `http://${host}/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => labelJson(l, repo, host)),
    user: userJson(VIEWER),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    comments_url: `${base}/issues/${issue.number}/comments`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${base}/issues/${issue.number}`,
  };
}

function pullAsIssueJson(pull: Pull, repo: Repo, host: string): Record<string, unknown> {
  const base = `http://${host}/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    labels: [],
    user: userJson(VIEWER),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    comments: pull.comments.length,
    comments_url: `${base}/issues/${pull.number}/comments`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${base}/issues/${pull.number}`,
    pull_request: {
      url: `${base}/pulls/${pull.number}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
      diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
      patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
      merged_at: pull.mergedAt,
    },
  };
}

export function itemJson(item: Item, repo: Repo, host: string): Record<string, unknown> {
  return isPull(item) ? pullAsIssueJson(item, repo, host) : issueJson(item, repo, host);
}

export function pullJson(pull: Pull, repo: Repo, host: string): Record<string, unknown> {
  const base = `http://${host}/api/v3/repos/${repo.owner}/${repo.name}`;
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? '';
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '';
  const repoRef = { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: userJson(VIEWER) };
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: headSha, user: userJson(VIEWER), repo: repoRef },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha, user: userJson(VIEWER), repo: repoRef },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: null,
    user: userJson(VIEWER),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    comments: pull.comments.length,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${base}/pulls/${pull.number}`,
  };
}

const IDENT = /^(.*) <(.*)> (\d+) [+-]\d{4}$/;

function identJson(raw: string): { name: string; email: string; date: string } {
  const match = IDENT.exec(raw);
  if (match === null) return { name: raw, email: '', date: '' };
  return { name: match[1] as string, email: match[2] as string, date: new Date(Number(match[3]) * 1000).toISOString() };
}

function commitJson(repo: Repo, oid: string, host: string): Record<string, unknown> | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  return {
    sha: oid,
    commit: {
      message: commit.message,
      author: identJson(commit.author),
      committer: identJson(commit.committer),
      tree: { sha: commit.tree },
    },
    author: userJson(VIEWER),
    committer: userJson(VIEWER),
    parents: commit.parents.map((p) => ({ sha: p })),
    url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${oid}`,
  };
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

export function handleRest(forge: Forge, req: RestRequest): HandlerResult {
  try {
    const s = req.segments;
    if (s.length === 0) {
      if (req.method !== 'GET') return notFound();
      return jsonResult(
        200,
        {
          current_user_url: `http://${req.host}/api/v3/user`,
          authorizations_url: `http://${req.host}/api/v3/authorizations`,
          repository_url: `http://${req.host}/api/v3/repos/{owner}/{repo}`,
        },
        { 'X-Oauth-Scopes': 'repo, read:org' },
      );
    }
    if (s[0] === 'meta' && s.length === 1) {
      if (req.method !== 'GET') return notFound();
      return jsonResult(200, { installed_version: '1.0.0' });
    }
    if (s[0] === 'user') {
      if (s.length === 1) {
        if (req.method !== 'GET') return notFound();
        return jsonResult(200, userJson(VIEWER));
      }
      if (s[1] === 'repos' && s.length === 2) {
        if (req.method === 'GET') return listUserRepos(forge, req);
        if (req.method === 'POST') return createUserRepo(forge, req);
      }
      return notFound();
    }
    if (s[0] === 'repos' && s.length >= 3) {
      return handleRepo(forge, req, s[1] as string, s[2] as string, s.slice(3));
    }
    return notFound();
  } catch (err) {
    return jsonResult(500, { message: `internal error: ${(err as Error).message}` });
  }
}

function parseBody(req: RestRequest): Record<string, unknown> | null | 'malformed' {
  if (req.body.length === 0) return {};
  const parsed = parseJsonBody(req.body);
  if (parsed === null) return 'malformed';
  if (!isRecord(parsed)) return 'malformed';
  return parsed;
}

function listUserRepos(forge: Forge, req: RestRequest): HandlerResult {
  const perPage = Math.max(1, Math.min(100, Number(req.query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(req.query.get('page') ?? '1') || 1);
  const all = forge.listReposByOwner(VIEWER.login);
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  const slice = all.slice((page - 1) * perPage, page * perPage);
  const origin = `http://${req.host}/api/v3/user/repos?per_page=${perPage}`;
  const links: string[] = [];
  if (page < totalPages) links.push(`<${origin}&page=${page + 1}>; rel="next"`);
  if (totalPages > 1) links.push(`<${origin}&page=${totalPages}>; rel="last"`);
  if (page > 1) links.push(`<${origin}&page=${page - 1}>; rel="prev"`);
  links.push(`<${origin}&page=1>; rel="first"`);
  return jsonResult(200, slice.map((r) => repoJson(r, req.host)), { Link: links.join(', ') });
}

function createUserRepo(forge: Forge, req: RestRequest): HandlerResult {
  const body = parseBody(req);
  if (body === 'malformed') return badRequest('Invalid JSON body');
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') return unprocessable('name is required');
  const description = typeof body.description === 'string' ? body.description : '';
  const isPrivate = body.private === true;
  const repo = forge.createRepo(VIEWER.login, name, description, isPrivate);
  if (repo === null) return unprocessable('name already exists on this account');
  return jsonResult(201, repoJson(repo, req.host));
}

function handleRepo(forge: Forge, req: RestRequest, owner: string, name: string, rest: readonly string[]): HandlerResult {
  if (owner !== VIEWER.login) return notFound();
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) return notFound();
  if (rest.length === 0) {
    if (req.method === 'GET') return jsonResult(200, repoJson(repo, req.host));
    if (req.method === 'PATCH') {
      const body = parseBody(req);
      if (body === 'malformed') return badRequest('Invalid JSON body');
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      repo.updatedAt = nowIso();
      return jsonResult(200, repoJson(repo, req.host));
    }
    if (req.method === 'DELETE') {
      forge.deleteRepo(owner, name);
      return { status: 204, contentType: 'application/json; charset=utf-8', body: Buffer.alloc(0) };
    }
    return notFound();
  }
  const head = rest[0] as string;
  if (head === 'git' && rest[1] === 'refs') return handleRefs(forge, req, repo, rest.slice(2));
  if (head === 'branches') return handleBranches(forge, req, repo, rest.slice(1));
  if (head === 'commits') return handleCommits(forge, req, repo, rest.slice(1));
  if (head === 'contents') return handleContents(forge, req, repo, rest.slice(1));
  if (head === 'labels') return handleLabels(forge, req, repo, rest.slice(1));
  if (head === 'issues') return handleIssues(forge, req, repo, rest.slice(1));
  if (head === 'pulls') return handlePulls(forge, req, repo, rest.slice(1));
  return notFound();
}

// ---------------------------------------------------------------------------------------------
// git refs and branches
// ---------------------------------------------------------------------------------------------

function refJson(repo: Repo, ref: string, oid: string, host: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  return {
    ref,
    object: {
      sha: oid,
      type: object?.type ?? 'commit',
      url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/git/${object?.type ?? 'commit'}s/${oid}`,
    },
    url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.replace(/^refs\//, '')}`,
  };
}

function handleRefs(forge: Forge, req: RestRequest, repo: Repo, rest: readonly string[]): HandlerResult {
  if (rest.length === 0) {
    if (req.method === 'GET') {
      const out = [...repo.refs.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([ref, oid]) => refJson(repo, ref, oid, req.host));
      return jsonResult(200, out);
    }
    if (req.method === 'POST') {
      const body = parseBody(req);
      if (body === 'malformed') return badRequest('Invalid JSON body');
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || sha === '') return unprocessable('ref and sha are required');
      if (repo.refs.has(ref)) return unprocessable('Reference already exists');
      const object = repo.objects.get(sha);
      if (object === undefined) return unprocessable('Object does not exist');
      repo.refs.set(ref, sha);
      return jsonResult(201, refJson(repo, ref, sha, req.host));
    }
    return notFound();
  }
  const ref = `refs/${rest.join('/')}`;
  if (req.method !== 'GET') return notFound();
  const oid = repo.refs.get(ref);
  if (oid === undefined) return notFound();
  return jsonResult(200, refJson(repo, ref, oid, req.host));
}

function branchJson(repo: Repo, branch: string, oid: string, host: string): Record<string, unknown> {
  return {
    name: branch,
    commit: {
      sha: oid,
      url: `http://${host}/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    },
    protected: false,
  };
}

function handleBranches(_forge: Forge, req: RestRequest, repo: Repo, rest: readonly string[]): HandlerResult {
  if (req.method !== 'GET') return notFound();
  if (rest.length === 0) {
    const out: Record<string, unknown>[] = [];
    for (const [ref, oid] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push(branchJson(repo, ref.slice('refs/heads/'.length), oid, req.host));
    }
    out.sort((a, b) => ((a.name as string) < (b.name as string) ? -1 : 1));
    return jsonResult(200, out);
  }
  const branch = rest.join('/');
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (oid === undefined) return notFound();
  return jsonResult(200, branchJson(repo, branch, oid, req.host));
}

// ---------------------------------------------------------------------------------------------
// commits
// ---------------------------------------------------------------------------------------------

function handleCommits(_forge: Forge, req: RestRequest, repo: Repo, rest: readonly string[]): HandlerResult {
  if (req.method !== 'GET') return notFound();
  if (rest.length === 0) {
    const ref = req.query.get('sha') ?? repo.defaultBranch;
    const tip = _forge.resolveRef(repo, ref);
    if (tip === null) {
      // An unborn default branch lists no commits; an unknown branch is a 404.
      if (req.query.get('sha') === null) return jsonResult(200, []);
      return notFound();
    }
    const commits = listCommits(_forge.lookup(repo), tip)
      .map((c) => commitJson(repo, c.oid, req.host))
      .filter((c) => c !== null);
    return jsonResult(200, commits);
  }
  if (rest.length === 1) {
    const json = commitJson(repo, rest[0] as string, req.host);
    if (json === null) return notFound();
    return jsonResult(200, json);
  }
  return notFound();
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function lookupPath(
  repo: Repo,
  commitOid: string,
  path: string,
): { kind: 'file'; oid: string; mode: string } | { kind: 'dir'; oid: string } | null {
  const commit = repo.objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return null;
  const rootTree = parseCommit(commit.data).tree;
  if (path === '') return { kind: 'dir', oid: rootTree };
  const parts = path.split('/');
  let treeOid = rootTree;
  for (let i = 0; i < parts.length; i += 1) {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((e) => e.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) {
      return entry.mode === '40000' ? { kind: 'dir', oid: entry.oid } : { kind: 'file', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  return null;
}

function handleContents(forge: Forge, req: RestRequest, repo: Repo, rest: readonly string[]): HandlerResult {
  const path = rest.join('/');
  if (req.method === 'GET') {
    const ref = req.query.get('ref') ?? repo.defaultBranch;
    const tip = forge.resolveRef(repo, ref);
    if (tip === null) return notFound();
    const found = lookupPath(repo, tip, path);
    if (found === null) return notFound();
    if (found.kind === 'file') {
      const blob = repo.objects.get(found.oid);
      if (blob === undefined) return notFound();
      return jsonResult(200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: path.split('/').pop() ?? path,
        path,
        sha: found.oid,
        content: blob.data.toString('base64'),
        url: `http://${req.host}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${ref}/${path}`,
      });
    }
    const tree = repo.objects.get(found.oid);
    if (tree === undefined) return notFound();
    const entries = parseTree(tree.data).map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
      name: entry.name,
      path: path === '' ? entry.name : `${path}/${entry.name}`,
      sha: entry.oid,
      url: `http://${req.host}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path === '' ? entry.name : `${path}/${entry.name}`}`,
    }));
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    return jsonResult(200, entries);
  }
  if (req.method === 'PUT' || req.method === 'DELETE') {
    const body = parseBody(req);
    if (body === 'malformed') return badRequest('Invalid JSON body');
    const message = typeof body.message === 'string' ? body.message : '';
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    let parentOid = forge.branchTip(repo, branch);
    if (parentOid === null && branch !== repo.defaultBranch) {
      // A new branch starts from the default branch's tip (or unborn).
      parentOid = forge.branchTip(repo, repo.defaultBranch);
    }
    const current = parentOid === null ? null : lookupPath(repo, parentOid, path);
    if (req.method === 'PUT') {
      if (typeof body.content !== 'string') return unprocessable('content is required');
      let content: Buffer;
      try {
        content = Buffer.from(body.content, 'base64');
      } catch {
        return unprocessable('content is not valid base64');
      }
      const blobSha = hashObject('blob', content);
      if (current !== null) {
        if (current.kind === 'dir') return unprocessable('path is a directory');
        if (typeof body.sha === 'string' && body.sha !== current.oid) {
          return jsonResult(409, { message: 'sha does not match the current blob' });
        }
        if (typeof body.sha !== 'string') return unprocessable('sha is required to update a file');
      }
      const { sha } = forge.commitFiles(repo, branch, message, new Map([[path, content]]), parentOid);
      return jsonResult(current === null ? 201 : 200, {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: blobSha,
          size: content.length,
          encoding: 'base64',
          content: content.toString('base64'),
        },
        commit: { sha, message, author: userJson(VIEWER), committer: userJson(VIEWER) },
      });
    }
    // DELETE
    if (current === null || current.kind === 'dir') return notFound();
    if (typeof body.sha === 'string' && body.sha !== current.oid) {
      return jsonResult(409, { message: 'sha does not match the current blob' });
    }
    const { sha } = forge.commitFiles(repo, branch, message, new Map([[path, null]]), parentOid);
    return jsonResult(200, { commit: { sha, message, author: userJson(VIEWER), committer: userJson(VIEWER) } });
  }
  return notFound();
}

// ---------------------------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------------------------

function handleLabels(_forge: Forge, req: RestRequest, repo: Repo, rest: readonly string[]): HandlerResult {
  if (rest.length !== 0) return notFound();
  if (req.method === 'GET') {
    return jsonResult(200, [...repo.labels.values()].map((l) => labelJson(l, repo, req.host)));
  }
  if (req.method === 'POST') {
    const body = parseBody(req);
    if (body === 'malformed') return badRequest('Invalid JSON body');
    const name = typeof body.name === 'string' ? body.name : '';
    const color = typeof body.color === 'string' ? body.color : 'ffffff';
    if (name === '') return unprocessable('name is required');
    if (repo.labels.has(name)) return unprocessable('Label already exists');
    const label = _forge.createLabel(repo, name, color);
    return jsonResult(201, labelJson(label, repo, req.host));
  }
  return notFound();
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

function parseNumber(segment: string): number | null {
  if (!/^\d+$/.test(segment)) return null;
  return Number(segment);
}

function handleIssues(forge: Forge, req: RestRequest, repo: Repo, rest: readonly string[]): HandlerResult {
  if (rest.length === 0) {
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const direction = req.query.get('direction') ?? 'desc';
      const perPage = Math.max(1, Math.min(100, Number(req.query.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(req.query.get('page') ?? '1') || 1);
      const items: Item[] = [...repo.issues.values(), ...repo.pulls.values()];
      const filtered = items.filter((i) => state === 'all' || i.state === state);
      filtered.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const slice = filtered.slice((page - 1) * perPage, page * perPage);
      return jsonResult(200, slice.map((i) => itemJson(i, repo, req.host)));
    }
    if (req.method === 'POST') {
      const body = parseBody(req);
      if (body === 'malformed') return badRequest('Invalid JSON body');
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') return unprocessable('title is required');
      const issueBody = typeof body.body === 'string' ? body.body : '';
      const labelNames = Array.isArray(body.labels)
        ? body.labels.filter((l): l is string => typeof l === 'string')
        : [];
      const created = forge.createIssue(repo, title, issueBody, labelNames);
      if ('error' in created) return unprocessable(created.error);
      return jsonResult(201, issueJson(created, repo, req.host));
    }
    return notFound();
  }
  const number = parseNumber(rest[0] as string);
  if (number === null) return notFound();
  const item = forge.getItem(repo, number);
  if (item === undefined) return notFound();
  if (rest.length === 1) {
    if (req.method === 'GET') return jsonResult(200, itemJson(item, repo, req.host));
    if (req.method === 'PATCH') {
      const body = parseBody(req);
      if (body === 'malformed') return badRequest('Invalid JSON body');
      if (typeof body.title === 'string') item.title = body.title;
      if (typeof body.body === 'string') item.body = body.body;
      if (body.state === 'open' || body.state === 'closed') {
        item.state = body.state;
        item.closedAt = body.state === 'closed' ? nowIso() : null;
      }
      item.updatedAt = nowIso();
      return jsonResult(200, itemJson(item, repo, req.host));
    }
    return notFound();
  }
  if (rest[1] === 'comments' && rest.length === 2) {
    if (req.method === 'GET') {
      return jsonResult(200, item.comments.map((c) => commentJson(c, repo, req.host)));
    }
    if (req.method === 'POST') {
      const body = parseBody(req);
      if (body === 'malformed') return badRequest('Invalid JSON body');
      const text = typeof body.body === 'string' ? body.body : '';
      if (text === '') return unprocessable('body is required');
      const comment = forge.addComment(item, text);
      return jsonResult(201, commentJson(comment, repo, req.host));
    }
  }
  return notFound();
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

function handlePulls(forge: Forge, req: RestRequest, repo: Repo, rest: readonly string[]): HandlerResult {
  if (rest.length === 0) {
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const pulls = [...repo.pulls.values()].filter((p) => state === 'all' || p.state === state);
      pulls.sort((a, b) => b.seq - a.seq);
      return jsonResult(200, pulls.map((p) => pullJson(p, repo, req.host)));
    }
    if (req.method === 'POST') {
      const body = parseBody(req);
      if (body === 'malformed') return badRequest('Invalid JSON body');
      const title = typeof body.title === 'string' ? body.title : '';
      const head = typeof body.head === 'string' ? stripOwnerPrefix(body.head) : '';
      const base = typeof body.base === 'string' ? stripOwnerPrefix(body.base) : '';
      if (title === '' || head === '' || base === '') return unprocessable('title, head and base are required');
      const pullBody = typeof body.body === 'string' ? body.body : '';
      const created = forge.createPull(repo, title, pullBody, head, base);
      if ('error' in created) return unprocessable(created.error);
      return jsonResult(201, pullJson(created, repo, req.host));
    }
    return notFound();
  }
  const number = parseNumber(rest[0] as string);
  if (number === null) return notFound();
  const pull = repo.pulls.get(number);
  if (pull === undefined) return notFound();
  if (rest.length === 1) {
    if (req.method !== 'GET') return notFound();
    return jsonResult(200, pullJson(pull, repo, req.host));
  }
  if (rest[1] === 'files' && rest.length === 2) {
    if (req.method !== 'GET') return notFound();
    const files = forge.prFiles(repo, pull).map((f) => ({
      sha: '',
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
    }));
    return jsonResult(200, files);
  }
  if (rest[1] === 'merge' && rest.length === 2) {
    if (req.method !== 'PUT') return notFound();
    const body = parseBody(req);
    if (body === 'malformed') return badRequest('Invalid JSON body');
    if (pull.state !== 'open') return jsonResult(405, { message: 'Pull request is not open' });
    const method = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
    const result = forge.mergePull(repo, pull, method);
    if ('conflict' in result) return jsonResult(405, { message: 'Pull request has conflicts' });
    if ('error' in result) return unprocessable(result.error);
    return jsonResult(200, { merged: true, sha: result.sha, message: 'Pull request successfully merged' });
  }
  return notFound();
}
