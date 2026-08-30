import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

import { createHttpClientStorage } from './http-client-storage.ts';

afterEach(() => {
  mock.restore();
});

function fetchImplementation(
  implementation: (...arguments_: Parameters<typeof fetch>) => Promise<Response>,
): typeof fetch {
  return Object.assign(implementation, { preconnect: fetch.preconnect });
}

describe('HTTP client storage facade', () => {
  it('uploads bytes backed by shared memory', async () => {
    let requestBody: BodyInit | null | undefined;
    spyOn(globalThis, 'fetch').mockImplementation(
      fetchImplementation(async (_input, init) => {
        requestBody = init?.body;
        return new Response(null, { status: 204 });
      }),
    );
    const bytes = new Uint8Array(new SharedArrayBuffer(3));
    bytes.set([1, 2, 3]);

    await createHttpClientStorage('https://weft.example', {}).put('shared', bytes);

    expect(requestBody).toBeInstanceOf(Blob);
    expect(Array.from(new Uint8Array(await (requestBody as Blob).arrayBuffer()))).toEqual(
      Array.from(bytes),
    );
  });

  it('encodes delete batches and defined scan options', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    spyOn(globalThis, 'fetch').mockImplementation(
      fetchImplementation(async (input, init) => {
        const url =
          input instanceof Request
            ? input.url
            : typeof input === 'string'
              ? input
              : input.toString();
        requests.push({ url, init });
        return url.includes('/storage?') ? new Response(null, { status: 204 }) : Response.json({});
      }),
    );
    const storage = createHttpClientStorage('https://weft.example', {});

    await storage.batch([{ type: 'delete', key: 'delete-me' }]);
    await expect(
      Array.fromAsync(storage.scan('prefix/', { reverse: false, limit: 3 })),
    ).resolves.toEqual([]);

    expect(requests[0]?.init?.body).toBe(
      JSON.stringify({ operations: [{ type: 'delete', key: 'delete-me' }] }),
    );
    expect(requests[1]?.url).toBe(
      'https://weft.example/v1/storage?prefix=prefix%2F&reverse=false&limit=3',
    );
  });

  it('rejects invalid NDJSON and preserves that failure when reader cancellation also fails', async () => {
    const invalidStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"key":1,"value":"AA=="}\n'));
      },
      cancel() {
        throw new Error('cancel failed');
      },
    });
    spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(invalidStream, {
        headers: { 'content-type': 'application/x-ndjson' },
      }),
    );
    const storage = createHttpClientStorage('https://weft.example', {});

    await expect(Array.fromAsync(storage.scan('prefix'))).rejects.toThrow(
      'HttpClient storage scan response contained an invalid NDJSON entry.',
    );
  });

  it('rejects scan responses above the byte cap before decoding the chunk', async () => {
    // Test-only stream chunk: the byte limit is checked before TextDecoder sees
    // the value, so a structural byteLength avoids allocating a 64 MiB fixture.
    const oversizedChunk = { byteLength: 64 * 1024 * 1024 + 1 } as Uint8Array;
    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversizedChunk);
      },
    });
    spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(oversizedStream, {
        headers: { 'content-type': 'application/x-ndjson' },
      }),
    );
    const storage = createHttpClientStorage('https://weft.example', {});

    await expect(Array.fromAsync(storage.scan('prefix'))).rejects.toThrow(
      'HttpClient storage scan response exceeded the maximum allowed size.',
    );
  });

  it('rejects malformed conditional-batch responses', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ applied: 'yes' }));
    const storage = createHttpClientStorage('https://weft.example', {});

    await expect(storage.conditionalBatch([], [])).rejects.toThrow(
      'HttpClient storage conditional batch response must include a boolean "applied" field.',
    );
  });
});
