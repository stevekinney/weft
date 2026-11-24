import { describe, expect, it } from 'bun:test';

import { createJsonRequest } from './http-request.test-support.ts';

describe('createJsonRequest', () => {
  it('builds a bodiless request without a content-type header when no body is given', async () => {
    const request = createJsonRequest({ method: 'GET', path: '/v1/workflows' });

    expect(request.method).toBe('GET');
    expect(request.url).toBe('http://localhost/v1/workflows');
    expect(request.headers.get('content-type')).toBeNull();
    expect(request.body).toBeNull();
  });

  it('frames a supplied body as JSON with a content-type header', async () => {
    const request = createJsonRequest({ method: 'POST', path: '/v1/workflows', body: { a: 1 } });

    expect(request.headers.get('content-type')).toBe('application/json');
    expect(await request.json()).toEqual({ a: 1 });
  });
});
