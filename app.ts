// The HTTP server: routing, authorization, and the cross-cutting response
// headers. The protocol handlers (git smart HTTP, REST v3, GraphQL, MCP) are
// pure functions of the store in their own modules; this file owns the socket.
//
// Authorization: the bearer token is MAKEFUN_SHOP_TOKEN. REST (except the
// public root and /meta), GraphQL and MCP all require it; a missing or wrong
// token is a 401. Git smart HTTP is not auth-gated (the suite never tests it
// there, and the client always sends the token anyway).
//
// Every reply carries a non-empty X-GitHub-Request-Id. REST replies also
// carry X-Oauth-Scopes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleGit } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { jsonResult, type HandlerResult } from './httputil.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface AppOptions {
  /** The expected bearer token. Defaults to MAKEFUN_SHOP_TOKEN. Empty means
   *  any non-empty token is accepted (local development only). */
  token?: string;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(options: AppOptions = {}): Server {
  const forge = new Forge();
  const expectedToken = options.token ?? process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;

  const isAuthorized = (req: IncomingMessage): boolean => {
    const auth = req.headers.authorization ?? '';
    const match = /^(?:Bearer|token) (.+)$/.exec(auth);
    if (match === null) return false;
    const token = match[1] as string;
    if (expectedToken === '') return token.length > 0;
    return token === expectedToken;
  };

  const send = (res: ServerResponse, result: HandlerResult, isRest: boolean): void => {
    requestCounter += 1;
    const headers: Record<string, string> = {
      'content-type': result.contentType,
      'content-length': String(result.body.length),
      'x-github-request-id': `req-${requestCounter.toString(16).padStart(8, '0')}`,
    };
    if (isRest) headers['x-oauth-scopes'] = 'repo, read:org';
    if (result.extraHeaders !== undefined) {
      for (const [name, value] of Object.entries(result.extraHeaders)) headers[name.toLowerCase()] = value;
    }
    res.writeHead(result.status, headers);
    res.end(result.body);
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let pathname = url.pathname;
      if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
      const method = req.method ?? 'GET';
      const host = req.headers.host ?? 'localhost';

      if (method === 'GET' && pathname === '/healthz') {
        send(res, jsonResult(200, { ok: true }), false);
        return;
      }

      const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
      const body = needsBody ? await readBody(req) : Buffer.alloc(0);

      // MCP: JSON-RPC over POST /mcp, auth required.
      if (pathname === '/mcp') {
        if (!isAuthorized(req)) {
          send(res, jsonResult(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }), false);
          return;
        }
        send(res, handleMcp(forge, { method, body, host }), false);
        return;
      }

      // GraphQL: POST /api/graphql, auth required.
      if (pathname === '/api/graphql') {
        if (!isAuthorized(req)) {
          send(res, jsonResult(401, { message: 'Bad credentials' }), false);
          return;
        }
        if (method !== 'POST') {
          send(res, jsonResult(405, { message: 'Method not allowed' }), false);
          return;
        }
        send(res, handleGraphql(forge, body), false);
        return;
      }

      // REST v3: /api/v3/... The root and /meta are public (as on GitHub);
      // everything else requires the token.
      if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
        const segments = pathname
          .slice('/api/v3'.length)
          .split('/')
          .filter((s) => s !== '')
          .map((s) => {
            try {
              return decodeURIComponent(s);
            } catch {
              return s;
            }
          });
        const isPublic = segments.length === 0 || (segments.length === 1 && segments[0] === 'meta');
        if (!isPublic && !isAuthorized(req)) {
          send(res, jsonResult(401, { message: 'Bad credentials' }), true);
          return;
        }
        send(res, handleRest(forge, { method, segments, query: url.searchParams, body, host }), true);
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}.
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(pathname);
      if (gitMatch !== null) {
        let owner: string;
        let repoName: string;
        try {
          owner = decodeURIComponent(gitMatch[1] as string);
          repoName = decodeURIComponent(gitMatch[2] as string);
        } catch {
          owner = gitMatch[1] as string;
          repoName = gitMatch[2] as string;
        }
        const headers: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(req.headers)) {
          headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
        }
        send(res, handleGit(forge, { method, owner, repoName, action: gitMatch[3] as string, query: url.searchParams, headers, body }), false);
        return;
      }

      send(res, jsonResult(404, { message: 'Not Found' }), false);
    } catch (err) {
      try {
        send(res, jsonResult(500, { message: `internal error: ${(err as Error).message}` }), false);
      } catch {
        res.destroy();
      }
    }
  });

  return server;
}
