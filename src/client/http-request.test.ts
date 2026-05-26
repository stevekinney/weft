import { afterEach, describe, expect, it } from 'bun:test';

import { HttpClientError, request } from './http-request.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockResponse(response: Response): void {
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
}

/** Drive `request()` against a mocked response and capture the thrown error. */
async function captureError(response: Response): Promise<HttpClientError> {
  mockResponse(response);
  try {
    // POST so the GET-404→null shortcut in `request()` does not swallow 404s.
    await request('http://example.test', '/thing', {}, { method: 'POST', body: '{}' });
  } catch (error) {
    if (error instanceof HttpClientError) return error;
    throw error;
  }
  throw new Error('expected request() to throw');
}

describe('HttpClientError', () => {
  it('keeps the stable WeftError discriminant', () => {
    const error = new HttpClientError(500, 'boom');
    expect(error.code).toBe('HttpClientError');
    expect(error.name).toBe('HttpClientError');
    expect(error).toBeInstanceOf(Error);
  });

  it('leaves faultCode and category undefined when constructed without options', () => {
    // Mirrors the direct-construct path in http-handle.ts.
    const error = new HttpClientError(404, 'Workflow "x" not found');
    expect(error.status).toBe(404);
    expect(error.faultCode).toBeUndefined();
    expect(error.category).toBeUndefined();
  });

  it('derives category from a provided faultCode', () => {
    const error = new HttpClientError(429, 'slow down', { faultCode: 'RateLimited' });
    expect(error.faultCode).toBe('RateLimited');
    expect(error.category).toBe('resource');
  });
});

describe('request() error-body parsing', () => {
  it('surfaces faultCode and derived category from a structured body', async () => {
    const error = await captureError(
      new Response(JSON.stringify({ error: { code: 'NotFound', message: 'no such workflow' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(error.status).toBe(404);
    expect(error.message).toBe('no such workflow');
    expect(error.faultCode).toBe('NotFound');
    expect(error.category).toBe('application');
    expect(error.code).toBe('HttpClientError');
  });

  it('maps a Timeout fault to the timeout category', async () => {
    const error = await captureError(
      new Response(JSON.stringify({ error: { code: 'Timeout', message: 'deadline exceeded' } }), {
        status: 408,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(error.faultCode).toBe('Timeout');
    expect(error.category).toBe('timeout');
  });

  it('maps a RateLimited fault to the resource category', async () => {
    const error = await captureError(
      new Response(JSON.stringify({ error: { code: 'RateLimited', message: 'too many' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(error.faultCode).toBe('RateLimited');
    expect(error.category).toBe('resource');
  });

  it('extracts the message but no faultCode from a flat string body', async () => {
    const error = await captureError(
      new Response(JSON.stringify({ error: 'plain message' }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(error.message).toBe('plain message');
    expect(error.faultCode).toBeUndefined();
    expect(error.category).toBeUndefined();
  });

  it('falls back to statusText for a non-JSON body', async () => {
    const error = await captureError(
      new Response('<html>nope</html>', { status: 502, statusText: 'Bad Gateway' }),
    );
    expect(error.message).toBe('Bad Gateway');
    expect(error.faultCode).toBeUndefined();
  });

  it('ignores an unrecognized fault code and falls back to statusText', async () => {
    // Inner `message` is present but `code` is not a known FaultCode, so the
    // structured guard rejects it; the flat guard also rejects (error is an
    // object, not a string), leaving the statusText fallback.
    const error = await captureError(
      new Response(JSON.stringify({ error: { code: 'Teapot', message: 'short and stout' } }), {
        status: 418,
        statusText: "I'm a teapot",
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(error.faultCode).toBeUndefined();
    expect(error.category).toBeUndefined();
    expect(error.message).toBe("I'm a teapot");
  });
});
