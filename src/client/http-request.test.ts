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

  it('leaves faultCode, category, and weftCode undefined when constructed without options', () => {
    // Mirrors the direct-construct path in http-handle.ts.
    const error = new HttpClientError(404, 'Workflow "x" not found');
    expect(error.status).toBe(404);
    expect(error.faultCode).toBeUndefined();
    expect(error.category).toBeUndefined();
    expect(error.weftCode).toBeUndefined();
  });

  it('derives category from a provided faultCode', () => {
    const error = new HttpClientError(503, 'overflow', { faultCode: 'SubscriptionOverflow' });
    expect(error.faultCode).toBe('SubscriptionOverflow');
    expect(error.category).toBe('resource');
  });

  it('carries a provided weftCode (#465)', () => {
    const error = new HttpClientError(404, 'not found', { weftCode: 'WorkflowNotFoundError' });
    expect(error.weftCode).toBe('WorkflowNotFoundError');
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

  it('maps a SubscriptionOverflow fault to the resource category', async () => {
    const error = await captureError(
      new Response(
        JSON.stringify({ error: { code: 'SubscriptionOverflow', message: 'too many' } }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    expect(error.faultCode).toBe('SubscriptionOverflow');
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

  it('surfaces the message but no faultCode for an unrecognized (future) code', async () => {
    // A structured body whose `code` is not a known FaultCode still yields its
    // human message — only the typed faultCode/category are withheld, so a
    // forward-compatible server fault does not lose its message to statusText.
    const error = await captureError(
      new Response(JSON.stringify({ error: { code: 'Teapot', message: 'short and stout' } }), {
        status: 418,
        statusText: "I'm a teapot",
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(error.faultCode).toBeUndefined();
    expect(error.category).toBeUndefined();
    expect(error.message).toBe('short and stout');
  });

  it('ignores the structured data field but not its weftCode', async () => {
    const error = await captureError(
      new Response(
        JSON.stringify({ error: { code: 'NotFound', message: 'gone', data: { resource: 'wf' } } }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    expect(error.faultCode).toBe('NotFound');
    expect(error.message).toBe('gone');
    expect('data' in error).toBe(false);
    expect(error.weftCode).toBeUndefined();
  });

  it('surfaces a fine-grained weftCode from a structured body data field (#465)', async () => {
    const error = await captureError(
      new Response(
        JSON.stringify({
          error: {
            code: 'NotFound',
            message: 'workflow not found',
            data: { resource: 'workflow', weftCode: 'WorkflowNotFoundError' },
          },
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    expect(error.faultCode).toBe('NotFound');
    expect(error.weftCode).toBe('WorkflowNotFoundError');
  });

  it('surfaces a top-level weftCode sibling from a flat string body (#465)', async () => {
    // The `shapeRestFault` shape: flat `{ error }` plus a top-level `weftCode`.
    const error = await captureError(
      new Response(
        JSON.stringify({ error: 'No workflow registered', weftCode: 'WorkflowNotRegisteredError' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    expect(error.message).toBe('No workflow registered');
    expect(error.faultCode).toBeUndefined();
    expect(error.weftCode).toBe('WorkflowNotRegisteredError');
  });

  it('ignores an unrecognized weftCode sibling (#465)', async () => {
    const error = await captureError(
      new Response(JSON.stringify({ error: 'boom', weftCode: 'NotARealCode' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(error.message).toBe('boom');
    expect(error.weftCode).toBeUndefined();
  });

  it('falls back to statusText when a structured body has a code but no message', async () => {
    const error = await captureError(
      new Response(JSON.stringify({ error: { code: 'NotFound' } }), {
        status: 404,
        statusText: 'Not Found',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(error.faultCode).toBeUndefined();
    expect(error.message).toBe('Not Found');
  });

  it('falls back to statusText for a null error field', async () => {
    const error = await captureError(
      new Response(JSON.stringify({ error: null }), {
        status: 500,
        statusText: 'Internal Server Error',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(error.message).toBe('Internal Server Error');
    expect(error.faultCode).toBeUndefined();
  });

  it('falls back to statusText for a flat body with an empty error string', async () => {
    const error = await captureError(
      new Response(JSON.stringify({ error: '' }), {
        status: 500,
        statusText: 'Internal Server Error',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(error.message).toBe('Internal Server Error');
    expect(error.faultCode).toBeUndefined();
  });

  it('falls back to statusText for a JSON body with no error field', async () => {
    const error = await captureError(
      new Response(JSON.stringify({ detail: 'something else' }), {
        status: 500,
        statusText: 'Internal Server Error',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(error.message).toBe('Internal Server Error');
    expect(error.faultCode).toBeUndefined();
  });
});
