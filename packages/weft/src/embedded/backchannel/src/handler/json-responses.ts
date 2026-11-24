/**
 * The JSON, error and content-negotiated responses a handler builds, with no codec of its own: a
 * host that serves a binary encoding passes the encoder.
 *
 * @module server/handler/json-responses
 */

import { copyBytesToArrayBuffer } from '../byte-arrays.ts';

/** Builds a JSON response with the given body and status, 200 by default. */
export function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Builds a JSON error response with the given message and status. */
export function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

/**
 * Answer as `application/msgpack` when the request accepts it and the host supplied an encoder,
 * and as JSON otherwise.
 */
export function negotiatedJsonOrBinary(
  request: Request,
  body: unknown,
  status: number,
  encodeBinary: ((value: unknown) => Uint8Array) | undefined,
): Response {
  const accept = request.headers.get('Accept') ?? '';
  if (encodeBinary !== undefined && accept.includes('application/msgpack')) {
    return new Response(copyBytesToArrayBuffer(encodeBinary(body)), {
      status,
      headers: { 'Content-Type': 'application/msgpack' },
    });
  }
  return jsonResponse(body, status);
}
