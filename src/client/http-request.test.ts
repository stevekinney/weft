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

  it('carries a provided data payload (#711)', () => {
    const error = new HttpClientError(400, 'invalid input', {
      faultCode: 'InvalidParams',
      data: { issues: [{ path: ['name'], message: 'Required', code: 'invalid_type' }] },
    });
    expect(error.data).toEqual({
      issues: [{ path: ['name'], message: 'Required', code: 'invalid_type' }],
    });
  });

  it('leaves data undefined when constructed without options', () => {
    const error = new HttpClientError(404, 'not found');
    expect(error.data).toBeUndefined();
  });
});

describe('request() error-body parsing', () => {
  it('falls back to statusText for a non-string error field', async () => {
    const error = await captureError(
      new Response(JSON.stringify({ error: { code: 'NotFound', message: 'no such workflow' } }), {
        status: 404,
        statusText: 'Not Found',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(error.status).toBe(404);
    expect(error.message).toBe('Not Found');
    expect(error.faultCode).toBeUndefined();
    expect(error.category).toBeUndefined();
    expect(error.code).toBe('HttpClientError');
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

  it('leaves data undefined for a flat string body (no structured data on the wire)', async () => {
    const error = await captureError(
      new Response(JSON.stringify({ error: 'plain message' }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(error.data).toBeUndefined();
  });

  it('never surfaces data for a masked EngineFailure REST response (#711)', async () => {
    // shapeRestFault masks EngineFailure to a flat `{ error: "Internal server
    // error" }` body with no `data` at all — this pins that masking so a
    // future refactor cannot leak internal fault detail through `error.data`.
    const error = await captureError(
      new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(error.message).toBe('Internal server error');
    expect(error.faultCode).toBeUndefined();
    expect(error.weftCode).toBeUndefined();
    expect(error.data).toBeUndefined();
  });

  it('surfaces a top-level weftCode sibling from a flat string body (#465)', async () => {
    // The `shapeRestFault` shape: flat `{ error }` plus optional top-level
    // `weftCode` and audited `data` siblings.
    const error = await captureError(
      new Response(
        JSON.stringify({
          error: 'No workflow registered',
          weftCode: 'WorkflowNotRegisteredError',
          data: { issues: [{ path: ['type'], message: 'Unknown workflow', code: 'custom' }] },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    expect(error.message).toBe('No workflow registered');
    expect(error.faultCode).toBeUndefined();
    expect(error.weftCode).toBe('WorkflowNotRegisteredError');
    expect(error.data).toEqual({
      issues: [{ path: ['type'], message: 'Unknown workflow', code: 'custom' }],
    });
  });

  it('rejects a non-object data sibling from a flat string body (#720)', async () => {
    const error = await captureError(
      new Response(JSON.stringify({ error: 'Invalid input', data: ['not', 'an', 'object'] }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(error.message).toBe('Invalid input');
    expect(error.data).toBeUndefined();
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
