import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

import type { ClientRestOperationBinding } from '../cli/operation-client-runtime.ts';
import { httpClientCatalogTransport, httpClientOperationTransport } from './http-operations.ts';
import { HttpClientError } from './http-request.ts';

const binding: ClientRestOperationBinding = {
  method: 'POST',
  path: '/things/:identifier',
  inputSources: {
    id: { kind: 'path', pathParam: 'identifier' },
    filter: { kind: 'query', queryParam: 'filter' },
    trace: { kind: 'header', headerName: 'x-trace-id' },
    value: { kind: 'body-field', bodyField: 'value' },
  },
  success: { kind: 'empty', status: 204 },
};

afterEach(() => {
  mock.restore();
});

describe('generated REST operation transport', () => {
  it('projects path, query, header, JSON body, and 204 response metadata', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImplementation: typeof fetch = Object.assign(
      async (...arguments_: Parameters<typeof fetch>) => {
        const [input, init] = arguments_;
        capturedUrl = input instanceof Request ? input.url : input.toString();
        capturedInit = init;
        return new Response(null, { status: 204 });
      },
      { preconnect: fetch.preconnect },
    );
    spyOn(globalThis, 'fetch').mockImplementation(fetchImplementation);
    const transport = httpClientOperationTransport(
      'https://weft.example',
      { authorization: 'Bearer token' },
      { 'weft.test.metadata': binding },
    );

    await expect(
      transport('weft.test.metadata', {
        id: 'path/with space',
        filter: 'waiting',
        trace: 'trace-1',
        value: { ok: true },
      }),
    ).resolves.toBeUndefined();

    expect(capturedUrl).toBe('https://weft.example/v1/things/path%2Fwith%20space?filter=waiting');
    expect(capturedInit?.method).toBe('POST');
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer token');
    expect(headers.get('x-trace-id')).toBe('trace-1');
    expect(headers.get('content-type')).toBe('application/json');
    expect(capturedInit?.body).toBe(JSON.stringify({ value: { ok: true } }));
  });

  it('preserves HttpClientError shaping for REST metadata calls', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ error: 'denied' }, { status: 403, statusText: 'Forbidden' }),
    );
    const transport = httpClientOperationTransport(
      'https://weft.example',
      {},
      {
        'weft.test.metadata': binding,
      },
    );

    const caught = await transport('weft.test.metadata', {
      id: 'item',
      trace: 'trace-1',
      value: null,
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(HttpClientError);
    if (!(caught instanceof HttpClientError)) throw new Error('unreachable');
    expect(caught.status).toBe(403);
    expect(caught.message).toBe('denied');
  });

  it('rejects object query values instead of sending ambiguous stringification', async () => {
    const transport = httpClientOperationTransport(
      'https://weft.example',
      {},
      { 'weft.test.metadata': binding },
    );

    const caught = await transport('weft.test.metadata', {
      id: 'item',
      filter: { unsupported: true },
      value: null,
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(HttpClientError);
    if (!(caught instanceof HttpClientError)) throw new Error('unreachable');
    expect(caught.status).toBe(400);
    expect(caught.message).toContain('requires a string, number, or boolean "filter" field');
  });

  it('rejects malformed catalog responses as HttpClientError', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not json', { status: 502 }));

    await expect(
      httpClientCatalogTransport('https://weft.example', {})('weft.test.catalog', {}),
    ).rejects.toMatchObject({
      status: 502,
      message: 'HTTP 502 from https://weft.example/jsonrpc',
    });
  });

  it('rejects non-object input and missing path fields before sending a request', async () => {
    const transport = httpClientOperationTransport(
      'https://weft.example',
      {},
      { 'weft.test.metadata': binding },
    );

    await expect(transport('weft.test.metadata', null)).rejects.toMatchObject({
      status: 400,
      message: 'Operation weft.test.metadata input must be an object.',
    });
    await expect(transport('weft.test.metadata', { value: null })).rejects.toMatchObject({
      status: 400,
      message: 'Operation weft.test.metadata requires a non-empty string "id" field.',
    });
  });

  it('projects repeating query parameters and a direct JSON body', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImplementation: typeof fetch = Object.assign(
      async (...arguments_: Parameters<typeof fetch>) => {
        const [input, init] = arguments_;
        capturedUrl = input instanceof Request ? input.url : input.toString();
        capturedInit = init;
        return Response.json({ ok: true });
      },
      { preconnect: fetch.preconnect },
    );
    spyOn(globalThis, 'fetch').mockImplementation(fetchImplementation);
    const directBodyBinding: ClientRestOperationBinding = {
      method: 'POST',
      path: '/search',
      inputSources: {
        tags: { kind: 'query', queryParam: 'tag', repeating: true },
        payload: { kind: 'body', mediaType: 'application/json' },
      },
      success: { kind: 'json', status: 200 },
    };
    const transport = httpClientOperationTransport(
      'https://weft.example',
      {},
      { 'weft.test.search': directBodyBinding },
    );

    await expect(
      transport('weft.test.search', {
        tags: ['one', 2, true],
        payload: { query: 'value' },
      }),
    ).resolves.toEqual({ ok: true });

    expect(capturedUrl).toBe('https://weft.example/v1/search?tag=one&tag=2&tag=true');
    expect(new Headers(capturedInit?.headers).get('content-type')).toBe('application/json');
    expect(capturedInit?.body).toBe(JSON.stringify({ query: 'value' }));
  });
});
