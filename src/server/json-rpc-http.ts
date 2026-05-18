/**
 * POST `/jsonrpc` HTTP transport adapter.
 *
 * Takes an incoming `Request`, validates the method + content-type +
 * body size, reads the body (bounded), and delegates dispatch to
 * `dispatchJsonRpc`. Maps the dispatcher's `DispatchJsonRpcResult`
 * onto an HTTP `Response` per JSON-RPC 2.0 spec conventions:
 *
 *   - single non-notification → HTTP 200 + JSON body
 *   - single notification → HTTP 204 No Content
 *   - batch with ≥1 response → HTTP 200 + JSON array body
 *   - all-notification batch → HTTP 204 No Content
 *
 * Note: body-level errors (parse-error, invalid-request) come back in
 * the JSON-RPC error envelope with `id: null` at HTTP 200 per spec.
 * HTTP 4xx/5xx are reserved for transport-level concerns (wrong
 * method, wrong content-type, body too large, server crash).
 *
 * The pre-read content-length guard rejects oversize bodies before
 * allocating a buffer. The post-read size check is the backstop when
 * the client omits content-length or lies.
 */

import {
  dispatchJsonRpc,
  type DispatchJsonRpcContext,
  type DispatchJsonRpcResult,
} from './json-rpc-dispatch.ts';
import type { OperationRegistry } from './operation-catalog.ts';
import type { Principal } from './principal.ts';

/** 1 MB default — large enough for batched JSON-RPC, small enough to bound memory. */
const DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024;

export type JsonRpcHttpContext = {
  readonly registry: OperationRegistry;
  readonly engine: unknown;
  readonly principal: Principal;
  /** Hard cap on request body size. Defaults to 1 MB. */
  readonly maxBodyBytes?: number;
};

/**
 * `Cache-Control: no-store` is applied to EVERY response from this
 * adapter — including 4xx transport-level rejections — because any
 * cached `/jsonrpc` response is a correctness hazard. The JSON-RPC
 * contract is strictly request-response, and a cached 413 or 415
 * served to a different client could mask a legitimate request.
 */
const CACHE_CONTROL_HEADERS = { 'cache-control': 'no-store' } as const;

function textResponse(body: string, status: number, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set('cache-control', 'no-store');
  return new Response(body, { status, headers });
}

/** Handle a POST `/jsonrpc` request end-to-end. */
export async function handleJsonRpcHttpRequest(
  request: Request,
  context: JsonRpcHttpContext,
): Promise<Response> {
  const methodRejection = guardMethod(request);
  if (methodRejection !== null) return methodRejection;

  const contentTypeRejection = guardContentType(request);
  if (contentTypeRejection !== null) return contentTypeRejection;

  const maxBytes = context.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const contentLengthRejection = guardContentLength(
    request.headers.get('content-length'),
    maxBytes,
  );
  if (contentLengthRejection !== null) return contentLengthRejection;

  // Stream-bounded body read. Pulls chunks and enforces `maxBytes`
  // as the hard ceiling so a lying or missing content-length header
  // cannot force an unbounded allocation.
  let bodyBytes: Uint8Array;
  try {
    bodyBytes = await readBodyBounded(request, maxBytes);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return textResponse('Payload Too Large', 413);
    // Stream error reading the body — treat as transport-level failure.
    return textResponse('Bad Request', 400);
  }
  const bodyText = new TextDecoder('utf-8').decode(bodyBytes);

  const dispatchContext: DispatchJsonRpcContext = {
    registry: context.registry,
    engine: context.engine,
    principal: context.principal,
    transport: 'jsonRpcHttp',
  };

  const result = await dispatchJsonRpc(bodyText, dispatchContext);
  return dispatchResultToResponse(result);
}

function guardMethod(request: Request): Response | null {
  if (request.method === 'POST') return null;
  return textResponse('Method Not Allowed', 405, { allow: 'POST' });
}

function guardContentType(request: Request): Response | null {
  const contentType = request.headers.get('content-type') ?? '';
  if (isJsonContentType(contentType)) return null;
  return textResponse('Unsupported Media Type', 415);
}

/**
 * Pre-read content-length guard. Validates a canonical non-negative
 * base-10 integer. Invalid/negative/fractional values → 400 (malformed
 * request). A valid-but-oversize declaration → 413 before any body
 * buffer is allocated.
 */
function guardContentLength(header: string | null, maxBytes: number): Response | null {
  if (header === null) return null;
  if (!CONTENT_LENGTH_PATTERN.test(header)) return textResponse('Bad Request', 400);
  const declared = Number(header);
  if (!Number.isSafeInteger(declared) || declared < 0) return textResponse('Bad Request', 400);
  if (declared > maxBytes) return textResponse('Payload Too Large', 413);
  return null;
}

function dispatchResultToResponse(result: DispatchJsonRpcResult): Response {
  switch (result.kind) {
    case 'notification':
    case 'notification-batch':
      return new Response(null, { status: 204, headers: CACHE_CONTROL_HEADERS });
    case 'single':
      return Response.json(result.response, { status: 200, headers: CACHE_CONTROL_HEADERS });
    case 'batch':
      return Response.json(result.responses, { status: 200, headers: CACHE_CONTROL_HEADERS });
  }
}

/**
 * Canonical base-10 non-negative integer. Rejects empty strings,
 * leading zeros on multi-digit values, signs, decimal points, and
 * scientific notation.
 */
const CONTENT_LENGTH_PATTERN = /^(0|[1-9]\d*)$/;

/**
 * Accepts `application/json` and `application/json; charset=...`
 * (case-insensitive on the type). Subtypes / vendor-tagged types
 * (`application/vnd.weft+json`) are NOT accepted — callers must use
 * the canonical JSON content type so the OpenRPC / OpenAPI documentation
 * remain consistent.
 */
function isJsonContentType(contentType: string): boolean {
  const lowered = contentType.trim().toLowerCase();
  const [type = ''] = lowered.split(';');
  return type.trim() === 'application/json';
}

class BodyTooLargeError extends Error {
  constructor() {
    super('body exceeds max bytes');
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Read the request body in chunks and enforce `maxBytes + 1` as a
 * hard ceiling BEFORE the full body is buffered. This prevents a
 * lying / missing `content-length` header from forcing an unbounded
 * allocation via `request.text()`.
 *
 * Returns the concatenated bytes; caller decodes with `TextDecoder`.
 * Throws `BodyTooLargeError` on overflow — caller maps to 413.
 */
async function readBodyBounded(request: Request, maxBytes: number): Promise<Uint8Array> {
  const body = request.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Abort the stream as soon as we exceed the limit.
        await reader.cancel();
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  // Concatenate.
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
