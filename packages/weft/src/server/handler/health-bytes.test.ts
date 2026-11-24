import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { describe, expect, it } from 'bun:test';

import { createOperationHandler } from "../../embedded/backchannel/src/index.ts";
import { encode } from '../../core/codec.ts';
import { Engine } from '../../core/engine.ts';
import { handleRequest } from './index.ts';

/** MessagePack for `{ "status": "ok" }`: a one-entry map, the key `status`, the value `ok`. */
const HEALTH_BYTES = Uint8Array.of(
  0x81,
  0xa6,
  0x73,
  0x74,
  0x61,
  0x74,
  0x75,
  0x73,
  0xa2,
  0x6f,
  0x6b,
);

const acceptsMessagePack = { headers: { Accept: 'application/msgpack' } };

async function bytesOf(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

describe('GET /v1/health that accepts application/msgpack', () => {
  it('answers Weft-hosted requests with the MessagePack bytes of the status', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const response = await handleRequest(
      new Request('http://localhost/v1/health', acceptsMessagePack),
      engine,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/msgpack');
    expect(await bytesOf(response)).toEqual(HEALTH_BYTES);
  });

  it('answers the engine-independent handler with the same bytes when it is given an encoder', async () => {
    const handler = createOperationHandler({ operations: [], host: {}, encodeBinary: encode });
    const response = await handler(new Request('http://localhost/v1/health', acceptsMessagePack));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/msgpack');
    expect(await bytesOf(response)).toEqual(HEALTH_BYTES);
  });

  it('answers the engine-independent handler with JSON when it has no encoder', async () => {
    const handler = createOperationHandler({ operations: [], host: {} });
    const response = await handler(new Request('http://localhost/v1/health', acceptsMessagePack));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await response.json()).toEqual({ status: 'ok' });
  });
});
