// MCP (`POST /mcp`): JSON-RPC 2.0 over streamable HTTP, stateless, no session id.
//
// Both eras are implemented: the modern `server/discover` handshake (protocol
// 2026-07-28, which the suite prefers) and the legacy `initialize` +
// `notifications/initialized` fallback. The tool list is a module-level
// constant, so `tools/list` is byte-identical across calls. Every tool result
// carries both `content` (a JSON text part) and `structuredContent` (the same
// object), because the suite reads both. Tools act on the same store as REST,
// so an MCP-created repository or issue reads back over REST with stable ids.

import { jsonResult, parseJsonBody, isRecord, type HandlerResult } from './httputil.ts';
import { type Forge, type Item, type Repo } from './store.ts';
import { issueJson, itemJson, pullJson, repoJson } from './rest.ts';
import { VIEWER } from './scenario.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, { readonly type: string; readonly description?: string }>>;
    readonly required: readonly string[];
  };
}

function str(description: string): { type: string; description: string } {
  return { type: 'string', description };
}

function bool(description: string): { type: string; description: string } {
  return { type: 'boolean', description };
}

function int(description: string): { type: string; description: string } {
  return { type: 'integer', description };
}

// Canonical github-mcp-server names and argument names; the suite maps its
// semantic arguments onto these property names, so keep them exact.
const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('The name of the repository.'),
        description: str('A short description of the repository.'),
        private: bool('Whether the repository is private.'),
        owner: str('The owner of the repository (the authenticated user).'),
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: str('The repository owner.'), repo: str('The repository name.') },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner.'),
        repo: str('The repository name.'),
        title: str('The title of the issue.'),
        body: str('The body of the issue.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner.'),
        repo: str('The repository name.'),
        state: str('Filter by state: open, closed, or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get an issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner.'),
        repo: str('The repository name.'),
        issue_number: int('The issue number.'),
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner.'),
        repo: str('The repository name.'),
        title: str('The title of the pull request.'),
        head: str('The head branch.'),
        base: str('The base branch.'),
        body: str('The body of the pull request.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with the squash method.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner.'),
        repo: str('The repository name.'),
        pull_number: int('The pull request number.'),
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner.'),
        repo: str('The repository name.'),
        state: str('Filter by state: open, closed, or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
];

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown): HandlerResult {
  return jsonResult(200, { jsonrpc: '2.0', id, result });
}

function rpcError(id: JsonRpcId, code: number, message: string, httpStatus = 200): HandlerResult {
  return jsonResult(httpStatus, { jsonrpc: '2.0', id, error: { code, message } });
}

function toolResult(payload: unknown): Record<string, unknown> {
  const text = JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export interface McpRequest {
  readonly method: string;
  readonly body: Buffer;
  readonly host: string;
}

export function handleMcp(forge: Forge, req: McpRequest): HandlerResult {
  if (req.method !== 'POST') return jsonResult(405, { message: 'Method not allowed' });
  const parsed = parseJsonBody(req.body);
  if (parsed === null) {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (!isRecord(parsed)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const id = (parsed.id as JsonRpcId | undefined) ?? null;
  const hasId = parsed.id !== undefined && parsed.id !== null;
  const method = parsed.method;
  if (typeof method !== 'string') {
    if (!hasId) return { status: 202, contentType: 'application/json; charset=utf-8', body: Buffer.alloc(0) };
    return rpcError(id, -32600, 'Invalid Request');
  }
  if (method.startsWith('notifications/')) {
    return { status: 202, contentType: 'application/json; charset=utf-8', body: Buffer.alloc(0) };
  }
  const params = isRecord(parsed.params) ? (parsed.params as Record<string, unknown>) : {};

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    return callTool(forge, req.host, id, params);
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

function required(args: Record<string, unknown>, name: string): unknown {
  const value = args[name];
  if (value === undefined || value === null || value === '') return undefined;
  return value;
}

function callTool(forge: Forge, host: string, id: JsonRpcId, params: Record<string, unknown>): HandlerResult {
  const name = params.name;
  if (typeof name !== 'string') return rpcError(id, -32602, 'Tool name is required');
  const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`);
  for (const prop of tool.inputSchema.required) {
    if (required(args, prop) === undefined) {
      return rpcError(id, -32602, `Missing required argument: ${prop}`);
    }
  }

  const owner = args.owner as string | undefined;
  const repoName = args.repo as string | undefined;
  const getRepo = (): Repo | null => {
    if (owner !== VIEWER.login) return null;
    return forge.getRepo(owner, repoName as string) ?? null;
  };

  switch (name) {
    case 'create_repo': {
      const repo = forge.createRepo(
        VIEWER.login,
        args.name as string,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      if (repo === null) return rpcResult(id, toolError('Repository already exists'));
      return rpcResult(id, toolResult(repoJson(repo, host)));
    }
    case 'get_repo': {
      const repo = getRepo();
      if (repo === null) return rpcResult(id, toolError('Repository not found'));
      return rpcResult(id, toolResult(repoJson(repo, host)));
    }
    case 'create_issue': {
      const repo = getRepo();
      if (repo === null) return rpcResult(id, toolError('Repository not found'));
      const created = forge.createIssue(repo, args.title as string, typeof args.body === 'string' ? args.body : '', []);
      if ('error' in created) return rpcResult(id, toolError(created.error));
      return rpcResult(id, toolResult(issueJson(created, repo, host)));
    }
    case 'list_issues': {
      const repo = getRepo();
      if (repo === null) return rpcResult(id, toolError('Repository not found'));
      const state = typeof args.state === 'string' ? args.state : 'open';
      const items: Item[] = [...repo.issues.values(), ...repo.pulls.values()];
      const filtered = items.filter((i) => state === 'all' || i.state === state);
      filtered.sort((a, b) => b.seq - a.seq);
      return rpcResult(id, toolResult(filtered.map((i) => itemJson(i, repo, host))));
    }
    case 'get_issue': {
      const repo = getRepo();
      if (repo === null) return rpcResult(id, toolError('Repository not found'));
      const item = forge.getItem(repo, Number(args.issue_number));
      if (item === undefined) return rpcResult(id, toolError('Issue not found'));
      return rpcResult(id, toolResult(itemJson(item, repo, host)));
    }
    case 'create_pull_request': {
      const repo = getRepo();
      if (repo === null) return rpcResult(id, toolError('Repository not found'));
      const created = forge.createPull(
        repo,
        args.title as string,
        typeof args.body === 'string' ? args.body : '',
        args.head as string,
        args.base as string,
      );
      if ('error' in created) return rpcResult(id, toolError(created.error));
      return rpcResult(id, toolResult(pullJson(created, repo, host)));
    }
    case 'merge_pull_request': {
      const repo = getRepo();
      if (repo === null) return rpcResult(id, toolError('Repository not found'));
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return rpcResult(id, toolError('Pull request not found'));
      if (pull.state !== 'open') return rpcResult(id, toolError('Pull request is not open'));
      const result = forge.mergePull(repo, pull, 'squash');
      if ('conflict' in result) return rpcResult(id, toolError('Pull request has conflicts'));
      if ('error' in result) return rpcResult(id, toolError(result.error));
      return rpcResult(id, toolResult({ ...pullJson(pull, repo, host), sha: result.sha }));
    }
    case 'list_pull_requests': {
      const repo = getRepo();
      if (repo === null) return rpcResult(id, toolError('Repository not found'));
      const state = typeof args.state === 'string' ? args.state : 'open';
      const pulls = [...repo.pulls.values()].filter((p) => state === 'all' || p.state === state);
      pulls.sort((a, b) => b.seq - a.seq);
      return rpcResult(id, toolResult(pulls.map((p) => pullJson(p, repo, host))));
    }
    default:
      return rpcError(id, -32602, `Unknown tool: ${name}`);
  }
}
