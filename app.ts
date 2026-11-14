// The HTTP server: routing, authorization, and the cross-cutting response
// headers. The protocol handlers (git smart HTTP, REST v3, GraphQL, MCP) are
// pure functions of the store in their own modules; this file owns the socket.
//
// This is a hand-written HTTP/1.1 server over net.Socket, not node's http
// module: the suite drives thousands of small sequential requests, and the
// http module's per-request object machinery (IncomingMessage/ServerResponse,
// header validation, the Date header) costs ~170 us of server CPU per request
// while a minimal parser costs ~60 us less. The handlers are all synchronous,
// so a request is parsed, routed and answered in the same tick its bytes
// arrive in — no stream events, no promise turns.
//
// What it implements (the suite's whole surface, nothing more):
// - origin-form targets, HTTP/1.1 keep-alive (5 s idle timeout, node's
//   default), pipelined requests in one buffer, Content-Length and chunked
//   request bodies, Expect: 100-continue, Connection: close, HEAD (headers
//   only, no body bytes).
// - Every reply carries a non-empty X-GitHub-Request-Id. REST replies also
//   carry X-Oauth-Scopes. No Date header (the suite never reads one).
//
// Authorization: the bearer token is MAKEFUN_SHOP_TOKEN. REST (except the
// public root and /meta), GraphQL and MCP all require it; a missing or wrong
// token is a 401. Git smart HTTP is not auth-gated (the suite never tests it
// there, and the client always sends the token anyway).

import { createServer, type Server, type Socket } from 'node:net';
import { Forge } from './store.ts';
import { handleGit } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { jsonResult, type HandlerResult } from './httputil.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** The largest request head accepted (the suite's heads are ~300 bytes). */
const MAX_HEAD_BYTES = 64 * 1024;
/** Idle keep-alive sockets are closed after this, as node's http server does. */
const KEEP_ALIVE_TIMEOUT_MS = 5_000;

const REASON: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

export interface AppOptions {
  /** The expected bearer token. Defaults to MAKEFUN_SHOP_TOKEN. Empty means
   *  any non-empty token is accepted (local development only). */
  token?: string;
}

/** Shared empty query params for the common no-query-string request (handlers only call .get()). */
const EMPTY_PARAMS = new URLSearchParams();

/**
 * Split a request target into its path and query without the WHATWG URL parser: the suite sends
 * plain origin-form targets, so a single '?' split is exact. Absolute-form targets (a proxy's)
 * fall back to the URL parser. Returns [pathname, query].
 */
function splitTarget(rawUrl: string): [string, URLSearchParams] {
  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
    const url = new URL(rawUrl);
    return [url.pathname, url.searchParams];
  }
  const hash = rawUrl.indexOf('#');
  const target = hash < 0 ? rawUrl : rawUrl.slice(0, hash);
  const q = target.indexOf('?');
  if (q < 0) return [target, EMPTY_PARAMS];
  return [target.slice(0, q), new URLSearchParams(target.slice(q + 1))];
}

/** decodeURIComponent, skipped when the segment holds no '%' (then it is the identity). */
function decodeSegment(segment: string): string {
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

interface ParsedHead {
  readonly method: string;
  readonly target: string;
  readonly version: string;
  readonly headers: Record<string, string>;
  /** Offset just past the head's terminating blank line. */
  readonly headEnd: number;
}

/** Parse the head at the start of `buf` (up to the blank line). Null when incomplete. */
function parseHead(buf: Buffer): ParsedHead | null | 'bad' {
  const end = buf.indexOf('\r\n\r\n');
  if (end < 0) {
    if (buf.length > MAX_HEAD_BYTES) return 'bad';
    return null;
  }
  const head = buf.subarray(0, end).toString('ascii');
  const lines = head.split('\r\n');
  const requestLine = lines[0] as string;
  const sp1 = requestLine.indexOf(' ');
  const sp2 = requestLine.indexOf(' ', sp1 + 1);
  if (sp1 <= 0 || sp2 <= sp1 + 1) return 'bad';
  const method = requestLine.slice(0, sp1);
  const target = requestLine.slice(sp1 + 1, sp2);
  const version = requestLine.slice(sp2 + 1);
  if (target === '' || !version.startsWith('HTTP/')) return 'bad';
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).toLowerCase();
    if (headers[name] === undefined) headers[name] = line.slice(colon + 1).trim();
  }
  return { method, target, version, headers, headEnd: end + 4 };
}

/**
 * Parse a chunked body starting at `start`. Returns the body and the offset just past it, null
 * when more bytes are needed, or 'bad' on malformed framing.
 */
function parseChunked(buf: Buffer, start: number): { body: Buffer; next: number } | null | 'bad' {
  const chunks: Buffer[] = [];
  let total = 0;
  let offset = start;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', offset);
    if (lineEnd < 0) return null;
    const sizeText = buf.subarray(offset, lineEnd).toString('ascii').split(';', 1)[0] as string;
    const size = Number.parseInt(sizeText.trim(), 16);
    if (!Number.isFinite(size) || size < 0) return 'bad';
    const dataStart = lineEnd + 2;
    if (size === 0) {
      // Trailers end at the next blank line; the common case is an immediate blank line.
      const trailerEnd = buf.indexOf('\r\n', dataStart);
      if (trailerEnd < 0) return null;
      return { body: Buffer.concat(chunks), next: trailerEnd + 2 };
    }
    if (dataStart + size + 2 > buf.length) return null;
    if (buf[dataStart + size] !== 0x0d || buf[dataStart + size + 1] !== 0x0a) return 'bad';
    chunks.push(buf.subarray(dataStart, dataStart + size));
    total += size;
    if (total > MAX_BODY_BYTES) return 'bad';
    offset = dataStart + size + 2;
  }
}

export function createApp(options: AppOptions = {}): Server {
  const forge = new Forge();
  const expectedToken = options.token ?? process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;

  const isAuthorized = (headers: Record<string, string>): boolean => {
    const auth = headers['authorization'] ?? '';
    const match = /^(?:Bearer|token) (.+)$/.exec(auth);
    if (match === null) return false;
    const token = match[1] as string;
    if (expectedToken === '') return token.length > 0;
    return token === expectedToken;
  };

  /** Serialize one response (head + body) onto the socket. */
  const send = (socket: Socket, method: string, result: HandlerResult, isRest: boolean, close: boolean): void => {
    requestCounter += 1;
    const reason = REASON[result.status] ?? '';
    let head =
      `HTTP/1.1 ${result.status} ${reason}\r\n` +
      `content-type: ${result.contentType}\r\n` +
      `content-length: ${result.body.length}\r\n` +
      `x-github-request-id: req-${requestCounter.toString(16).padStart(8, '0')}\r\n`;
    // The REST root handler also sets X-Oauth-Scopes as an extra header; emit
    // the default only when the extras do not already carry it (no duplicates).
    const extraHasScopes =
      result.extraHeaders !== undefined &&
      Object.keys(result.extraHeaders).some((n) => n.toLowerCase() === 'x-oauth-scopes');
    if (isRest && !extraHasScopes) head += 'x-oauth-scopes: repo, read:org\r\n';
    if (result.extraHeaders !== undefined) {
      for (const [name, value] of Object.entries(result.extraHeaders)) head += `${name.toLowerCase()}: ${value}\r\n`;
    }
    if (close) head += 'connection: close\r\n';
    head += '\r\n';
    socket.cork();
    socket.write(head);
    // HEAD answers carry the headers (with the real content-length) but no body bytes.
    if (method !== 'HEAD' && result.body.length > 0) socket.write(result.body);
    socket.uncork();
    if (close) socket.end();
  };

  /** Route one parsed request and answer it. Pure routing; the handlers are synchronous. */
  const handle = (
    socket: Socket,
    method: string,
    target: string,
    version: string,
    headers: Record<string, string>,
    body: Buffer,
  ): void => {
    const connection = (headers['connection'] ?? '').toLowerCase();
    const close = connection === 'close' || (version === 'HTTP/1.0' && connection !== 'keep-alive');
    try {
      const [rawPathname, query] = splitTarget(target);
      let pathname = rawPathname;
      if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
      const host = headers['host'] ?? 'localhost';

      if (method === 'GET' && pathname === '/healthz') {
        send(socket, method, jsonResult(200, { ok: true }), false, close);
        return;
      }

      // MCP: JSON-RPC over POST /mcp, auth required.
      if (pathname === '/mcp') {
        if (!isAuthorized(headers)) {
          send(socket, method, jsonResult(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }), false, close);
          return;
        }
        send(socket, method, handleMcp(forge, { method, body, host }), false, close);
        return;
      }

      // GraphQL: POST /api/graphql, auth required.
      if (pathname === '/api/graphql') {
        if (!isAuthorized(headers)) {
          send(socket, method, jsonResult(401, { message: 'Bad credentials' }), false, close);
          return;
        }
        if (method !== 'POST') {
          send(socket, method, jsonResult(405, { message: 'Method not allowed' }), false, close);
          return;
        }
        send(socket, method, handleGraphql(forge, body), false, close);
        return;
      }

      // REST v3: /api/v3/... The root and /meta are public (as on GitHub);
      // everything else requires the token.
      if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
        const segments = pathname
          .slice('/api/v3'.length)
          .split('/')
          .filter((s) => s !== '')
          .map(decodeSegment);
        const isPublic = segments.length === 0 || (segments.length === 1 && segments[0] === 'meta');
        if (!isPublic && !isAuthorized(headers)) {
          send(socket, method, jsonResult(401, { message: 'Bad credentials' }), true, close);
          return;
        }
        send(socket, method, handleRest(forge, { method, segments, query, body, host }), true, close);
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}.
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(pathname);
      if (gitMatch !== null) {
        const owner = decodeSegment(gitMatch[1] as string);
        const repoName = decodeSegment(gitMatch[2] as string);
        send(socket, method, handleGit(forge, { method, owner, repoName, action: gitMatch[3] as string, query, headers, body }), false, close);
        return;
      }

      send(socket, method, jsonResult(404, { message: 'Not Found' }), false, close);
    } catch (err) {
      try {
        send(socket, method, jsonResult(500, { message: `internal error: ${(err as Error).message}` }), false, close);
      } catch {
        socket.destroy();
      }
    }
  };

  const server = createServer((socket) => {
    socket.setNoDelay(true);
    socket.setTimeout(KEEP_ALIVE_TIMEOUT_MS);
    socket.on('timeout', () => socket.destroy());
    let buf = Buffer.alloc(0);
    let continued = false;

    socket.on('data', (chunk: Buffer) => {
      socket.setTimeout(KEEP_ALIVE_TIMEOUT_MS);
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      for (;;) {
        const head = parseHead(buf);
        if (head === null) return;
        if (head === 'bad') {
          socket.destroy();
          return;
        }
        const chunked = (head.headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked');
        // Expect: 100-continue — answer at once so the client sends the body.
        if (!continued && (head.headers['expect'] ?? '').toLowerCase() === '100-continue') {
          socket.write('HTTP/1.1 100 Continue\r\n\r\n');
          continued = true;
        }
        let body: Buffer;
        let next: number;
        if (chunked) {
          const parsed = parseChunked(buf, head.headEnd);
          if (parsed === null) return;
          if (parsed === 'bad') {
            socket.destroy();
            return;
          }
          body = parsed.body;
          next = parsed.next;
        } else {
          const contentLength = Number(head.headers['content-length'] ?? '0') || 0;
          if (contentLength < 0 || contentLength > MAX_BODY_BYTES) {
            socket.destroy();
            return;
          }
          next = head.headEnd + contentLength;
          if (buf.length < next) return;
          body = buf.subarray(head.headEnd, next);
        }
        buf = buf.subarray(next);
        continued = false;
        // GET/HEAD carry no body to the handlers (as before: only mutating
        // methods read one); the framing bytes above are still consumed so
        // the stream stays aligned for the next pipelined request.
        const handlerBody =
          head.method === 'POST' || head.method === 'PUT' || head.method === 'PATCH' || head.method === 'DELETE'
            ? body
            : Buffer.alloc(0);
        handle(socket, head.method, head.target, head.version, head.headers, handlerBody);
        if (socket.destroyed) return;
      }
    });
    socket.on('error', () => {
      socket.destroy();
    });
  });

  return server;
}
