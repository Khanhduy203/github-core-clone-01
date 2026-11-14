// Shared response shape for the HTTP handlers. Handlers are pure functions of
// (forge, request) returning a HandlerResult; app.ts owns the socket plumbing
// and adds the cross-cutting headers (X-GitHub-Request-Id, X-Oauth-Scopes).

export interface HandlerResult {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

export function jsonResult(status: number, value: unknown, extraHeaders?: Readonly<Record<string, string>>): HandlerResult {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify(value), 'utf8'), extraHeaders };
}

export function textResult(status: number, text: string, contentType = 'text/plain; charset=utf-8'): HandlerResult {
  return { status, contentType, body: Buffer.from(text, 'utf8') };
}

export function binaryResult(status: number, body: Buffer, contentType: string): HandlerResult {
  return { status, contentType, body };
}

/** Parse a request body as JSON, returning null on malformed input. */
export function parseJsonBody(body: Buffer): unknown | null {
  if (body.length === 0) return null;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
