import {
  type UnknownRestBinding,
  jsonResponse,
  negotiatedJsonOrBinary,
} from "../../embedded/backchannel/src/internals.ts";
import { encode } from '../../core/codec.ts';

export function negotiatedResponse(
  request: Request,
  body: unknown,
  status: number = 200,
): Response {
  return negotiatedJsonOrBinary(request, body, status, encode);
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
