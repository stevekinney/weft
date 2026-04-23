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

import { dispatchJsonRpc, type DispatchJsonRpcContext } from './json-rpc-dispatch.ts';
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

/** Handle a POST `/jsonrpc` request end-to-end. */
export async function handleJsonRpcHttpRequest(
  request: Request,
  context: JsonRpcHttpContext,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { allow: 'POST' },
    });
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!isJsonContentType(contentType)) {
    return new Response('Unsupported Media Type', { status: 415 });
  }

  const maxBytes = context.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  // Cheap pre-read guard: if content-length is present and over the
  // limit, reject without allocating the buffer.
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return new Response('Payload Too Large', { status: 413 });
    }
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    // Stream error reading the body — treat as transport-level failure.
    return new Response('Bad Request', { status: 400 });
  }

  // Backstop check: clients can lie about content-length (or omit
  // it entirely for chunked encoding), so always verify the actual
  // byte length after reading.
  const byteLength = new TextEncoder().encode(bodyText).length;
  if (byteLength > maxBytes) {
    return new Response('Payload Too Large', { status: 413 });
  }

  const dispatchContext: DispatchJsonRpcContext = {
    registry: context.registry,
    engine: context.engine,
    principal: context.principal,
    transport: 'jsonRpcHttp',
  };

  const result = await dispatchJsonRpc(bodyText, dispatchContext);

  switch (result.kind) {
    case 'notification':
    case 'notification-batch':
      return new Response(null, { status: 204 });
    case 'single':
      return Response.json(result.response, { status: 200 });
    case 'batch':
      return Response.json(result.responses, { status: 200 });
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

/**
 * Accepts `application/json` and `application/json; charset=...`
 * (case-insensitive on the type). Subtypes / vendor-tagged types
 * (`application/vnd.weft+json`) are NOT accepted — callers must use
 * the canonical JSON content type so the OpenRPC / OpenAPI docs
 * remain consistent.
 */
function isJsonContentType(contentType: string): boolean {
  const lowered = contentType.trim().toLowerCase();
  const [type = ''] = lowered.split(';');
  return type.trim() === 'application/json';
}
