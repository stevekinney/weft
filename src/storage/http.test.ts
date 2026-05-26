import { describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import { handleRequest } from '../server/handler.ts';
import { principalFromApiKey } from '../server/principal.ts';
import { HTTPStorage } from './http.ts';
import { MemoryStorage } from './memory.ts';
import { assertCapabilitiesShape } from './storage-adapter.test-support.ts';

describe('HTTPStorage capabilities()', () => {
  it('reports the conservative remote-client floor, conditionalBatch false by default', () => {
    const storage = new HTTPStorage({ baseUrl: 'https://example.test/api/' });
    assertCapabilitiesShape(storage);
    expect(storage.capabilities()).toEqual({
      readAfterWrite: 'eventual',
      scanConsistency: 'best-effort',
      atomicBatch: true,
      conditionalBatch: false,
      boundedRangeDelete: false,
    });
  });

  it('opts into conditionalBatch when the operator declares verified remote support', () => {
    const storage = new HTTPStorage({
      baseUrl: 'https://example.test/api/',
      remoteConditionalBatch: true,
    });
    expect(storage.capabilities().conditionalBatch).toBe(true);
  });
});

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decode(value: Uint8Array | null): string | null {
  return value === null ? null : new TextDecoder().decode(value);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const value of iterable) results.push(value);
  return results;
}

function base64(value: string): string {
  return btoa(value);
}

type FetchHandler = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

function installFetch(handler: FetchHandler): () => void {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(handler, { preconnect: previousFetch.preconnect });
  return () => {
    globalThis.fetch = previousFetch;
  };
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.href;
  return input;
}

function adminStorageOptions() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({
        subject: 'http-storage-test',
        scopes: ['storage:read', 'storage:write', 'storage:admin'],
      }),
    },
  };
}

describe('HTTPStorage', () => {
  it('reads bytes and maps 404 to null', async () => {
    const restoreFetch = installFetch(async (input) => {
      const url = new URL(fetchInputUrl(input));
      if (url.pathname.endsWith('/missing')) return new Response(null, { status: 404 });
      return new Response(encode('value'), { status: 200 });
    });
    try {
      const storage = new HTTPStorage({ baseUrl: 'https://example.test/api/' });

      expect(decode(await storage.get('key'))).toBe('value');
      expect(await storage.get('missing')).toBeNull();
    } finally {
      restoreFetch();
    }
  });

  it('encodes batch operations as JSON with base64 values', async () => {
    const requests: Request[] = [];
    const restoreFetch = installFetch(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return new Response(null, { status: 204 });
    });
    try {
      const storage = new HTTPStorage({
        baseUrl: 'https://example.test/weft/',
        headers: { authorization: 'Bearer token' },
      });
      await storage.batch([
        { type: 'put', key: 'a', value: encode('one') },
        { type: 'delete', key: 'b' },
      ]);

      expect(requests[0]?.url).toBe('https://example.test/weft/v1/storage/-/batch');
      expect(requests[0]?.headers.get('authorization')).toBe('Bearer token');
      expect(await requests[0]?.json()).toEqual({
        operations: [
          { type: 'put', key: 'a', value: base64('one') },
          { type: 'delete', key: 'b' },
        ],
      });
    } finally {
      restoreFetch();
    }
  });

  it('writes octet-stream payloads, deletes keys, and scopes prefixes', async () => {
    const requests: Request[] = [];
    const restoreFetch = installFetch(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === 'GET') {
        const key = decodeURIComponent(new URL(request.url).pathname.split('/').pop() ?? '');
        return new Response(encode(`value:${key}`), { status: 200 });
      }
      return new Response(null, { status: 204 });
    });
    try {
      const storage = new HTTPStorage({ baseUrl: 'https://example.test/root' });
      await storage.put('plain:key', encode('value'));
      await storage.delete('plain:key');

      const scoped = storage.scoped('scope:');
      await scoped.put('workflow', encode('scoped'));
      expect(decode(await scoped.get('workflow'))).toBe('value:scope:workflow');

      expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        'PUT https://example.test/root/v1/storage/plain%3Akey',
        'DELETE https://example.test/root/v1/storage/plain%3Akey',
        'PUT https://example.test/root/v1/storage/scope%3Aworkflow',
        'GET https://example.test/root/v1/storage/scope%3Aworkflow',
      ]);
      expect(requests[0]?.headers.get('content-type')).toBe('application/octet-stream');
      expect(await requests[0]?.text()).toBe('value');
      expect(await requests[2]?.text()).toBe('scoped');

      storage[Symbol.dispose]();
    } finally {
      restoreFetch();
    }
  });

  it('streams scan results from NDJSON', async () => {
    const restoreFetch = installFetch(
      async () =>
        new Response(
          `${JSON.stringify({ key: 'wf:a', value: base64('a') })}\n${JSON.stringify({
            key: 'wf:b',
            value: base64('b'),
          })}\n`,
          { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
        ),
    );
    try {
      const storage = new HTTPStorage({ baseUrl: 'https://example.test' });
      const entries = await collect(storage.scan('wf:'));

      expect(entries.map(([key, value]) => [key, decode(value)])).toEqual([
        ['wf:a', 'a'],
        ['wf:b', 'b'],
      ]);
    } finally {
      restoreFetch();
    }
  });

  it('streams scan results incrementally from response chunks', async () => {
    let releaseSecondChunk!: () => void;
    const secondChunkGate = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve;
    });
    const restoreFetch = installFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encode(`${JSON.stringify({ key: 'wf:a', value: base64('a') })}\n`),
              );
            },
            async pull(controller) {
              await secondChunkGate;
              controller.enqueue(
                encode(`${JSON.stringify({ key: 'wf:b', value: base64('b') })}\n`),
              );
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
        ),
    );
    try {
      const storage = new HTTPStorage({ baseUrl: 'https://example.test' });
      const iterator = storage.scan('wf:')[Symbol.asyncIterator]();

      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(first.value?.[0]).toBe('wf:a');

      releaseSecondChunk();
      const second = await iterator.next();
      expect(second.done).toBe(false);
      expect(second.value?.[0]).toBe('wf:b');
    } finally {
      restoreFetch();
    }
  });

  it('cancels and releases the NDJSON reader when scan iteration stops early', async () => {
    let cancelCalled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode(`${JSON.stringify({ key: 'wf:a', value: base64('a') })}\n`));
      },
      cancel() {
        cancelCalled = true;
      },
    });
    const restoreFetch = installFetch(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'application/x-ndjson' },
        }),
    );
    try {
      const storage = new HTTPStorage({ baseUrl: 'https://example.test' });

      for await (const [key, value] of storage.scan('wf:')) {
        expect(key).toBe('wf:a');
        expect(decode(value)).toBe('a');
        break;
      }

      expect(cancelCalled).toBe(true);
      expect(stream.locked).toBe(false);
    } finally {
      restoreFetch();
    }
  });

  it('returns the conditional batch result', async () => {
    const requests: Request[] = [];
    const restoreFetch = installFetch(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({
        applied: false,
      });
    });
    try {
      const storage = new HTTPStorage({ baseUrl: 'https://example.test' });

      expect(
        await storage.conditionalBatch?.(
          [{ key: 'a', expectedValue: encode('old') }],
          [{ type: 'put', key: 'a', value: encode('new') }],
        ),
      ).toBe(false);
      expect(requests[0]?.url).toBe('https://example.test/v1/storage/-/conditional-batch');
    } finally {
      restoreFetch();
    }
  });

  it('talks to the real storage REST handlers end to end', async () => {
    const rawStorage = new MemoryStorage();
    const engine = new Engine({ storage: rawStorage });
    const restoreFetch = installFetch((input, init) =>
      handleRequest(new Request(input, init), engine, adminStorageOptions()),
    );
    try {
      const storage = new HTTPStorage({ baseUrl: 'http://localhost' });

      await storage.put('wf:a', encode('a'));
      await storage.batch([
        { type: 'put', key: 'wf:b', value: encode('b') },
        { type: 'delete', key: 'missing' },
      ]);

      expect(decode(await storage.get('wf:a'))).toBe('a');
      const scannedEntries = await collect(storage.scan('wf:'));
      expect(scannedEntries.map(([key, value]) => [key, decode(value)])).toEqual([
        ['wf:a', 'a'],
        ['wf:b', 'b'],
      ]);
      expect(
        await storage.conditionalBatch?.(
          [{ key: 'wf:b', expectedValue: encode('b') }],
          [
            { type: 'put', key: 'wf:c', value: encode('c') },
            { type: 'delete', key: 'wf:a' },
          ],
        ),
      ).toBe(true);
      expect(await storage.get('wf:a')).toBeNull();
      expect(decode(await storage.get('wf:c'))).toBe('c');
    } finally {
      restoreFetch();
    }
  });

  it('derives has/keys/count/deletePrefix from scan and batch end to end', async () => {
    const rawStorage = new MemoryStorage();
    const engine = new Engine({ storage: rawStorage });
    const restoreFetch = installFetch((input, init) =>
      handleRequest(new Request(input, init), engine, adminStorageOptions()),
    );
    try {
      const storage = new HTTPStorage({ baseUrl: 'http://localhost' });

      await storage.batch([
        { type: 'put', key: 'wf:a', value: encode('a') },
        { type: 'put', key: 'wf:b', value: encode('b') },
        { type: 'put', key: 'wfx', value: encode('adjacent') },
        { type: 'put', key: 'other', value: encode('c') },
      ]);

      expect(await storage.has('wf:a')).toBe(true);
      expect(await storage.has('wf:missing')).toBe(false);

      expect(await collect(storage.keys('wf:'))).toEqual(['wf:a', 'wf:b']);
      expect(await collect(storage.keys('wf:', { reverse: true }))).toEqual(['wf:b', 'wf:a']);
      expect(await collect(storage.keys('wf:', { limit: 1 }))).toEqual(['wf:a']);

      expect(await storage.count('wf:')).toBe(2);
      expect(await storage.count('missing:')).toBe(0);

      // deletePrefix removes exactly the matching keys; nearby keys survive.
      expect(await storage.deletePrefix('wf:')).toBe(2);
      expect(await storage.get('wf:a')).toBeNull();
      expect(await storage.get('wf:b')).toBeNull();
      expect(decode(await storage.get('wfx'))).toBe('adjacent');
      expect(decode(await storage.get('other'))).toBe('c');
      expect(await storage.deletePrefix('missing:')).toBe(0);
    } finally {
      restoreFetch();
    }
  });

  it('surfaces 403 for unscoped non-admin REST storage access', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const restoreFetch = installFetch((input, init) =>
      handleRequest(new Request(input, init), engine, {
        authContext: {
          method: 'api-key' as const,
          principal: principalFromApiKey({
            subject: 'http-storage-unscoped-test',
            scopes: ['storage:read'],
          }),
        },
      }),
    );
    try {
      const storage = new HTTPStorage({ baseUrl: 'http://localhost' });

      await expect(storage.get('wf:key')).rejects.toThrow('returned 403');
    } finally {
      restoreFetch();
    }
  });
});
