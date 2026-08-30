import { afterEach, describe, expect, test } from 'bun:test';

import { probeHealth } from './health-probe.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('probeHealth', () => {
  test('resolves when /v1/health responds ok', async () => {
    let requestedUrl: string | undefined;
    let requestedHeaders: HeadersInit | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedHeaders = init?.headers;
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    }) as typeof fetch;

    await expect(
      probeHealth({ baseUrl: 'http://localhost:7233', headers: { 'x-api-key': 'secret' } }),
    ).resolves.toBe(true);

    expect(requestedUrl).toBe('http://localhost:7233/v1/health');
    expect(requestedHeaders).toEqual({ 'x-api-key': 'secret' });
  });

  test('throws when /v1/health responds with a non-ok status', async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response('', { status: 503 })) as typeof fetch;

    await expect(probeHealth({ baseUrl: 'http://localhost:7233', headers: {} })).rejects.toThrow(
      '503',
    );
  });

  test('propagates a network failure', async () => {
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;

    await expect(probeHealth({ baseUrl: 'http://localhost:7233', headers: {} })).rejects.toThrow(
      'Failed to fetch',
    );
  });
});
