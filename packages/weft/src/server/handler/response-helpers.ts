import { copyBytesToArrayBuffer } from '../../core/byte-arrays.ts';
import { encode } from '../../core/codec.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';

export function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function msgpackResponse(body: unknown, status: number = 200): Response {
  return new Response(copyBytesToArrayBuffer(encode(body)), {
    status,
    headers: { 'Content-Type': 'application/msgpack' },
  });
}

export function negotiatedResponse(
  request: Request,
  body: unknown,
  status: number = 200,
): Response {
  const accept = request.headers.get('Accept') ?? '';
  if (accept.includes('application/msgpack')) {
    return msgpackResponse(body, status);
  }
  return jsonResponse(body, status);
}

export function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

export function defaultShapeSuccess(
  value: unknown,
  shape: UnknownRestBinding['success'],
): Response {
  if (shape.kind === 'empty') return new Response(null, { status: shape.status });
  if (shape.kind === 'streaming') {
    // Streaming responses must supply their own `shapeSuccess` — a
    // default here would bundle the async iterable into a JSON body
    // and silently break SSE/binary output. Fail loudly instead.
    throw new Error('streaming RestBinding must provide shapeSuccess');
  }
  return jsonResponse(value, shape.status);
}
