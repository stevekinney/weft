/**
 * Tests for `faultToHttpResponse` — converts a transport-neutral
 * OperationFault into the HTTP response shape REST clients expect.
 */

import { describe, expect, it } from 'bun:test';

import { faultToHttpResponse } from './fault-to-http.ts';
import type { OperationFault } from './operation-fault.ts';

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  return text.length === 0 ? undefined : JSON.parse(text);
}

describe('faultToHttpResponse', () => {
  it('NotFound without identifier omits the identifier key from data (no undefined leak)', async () => {
    const response = faultToHttpResponse({
      code: 'NotFound',
      message: 'workflow not found',
      data: { resource: 'workflow' },
    });
    const body = (await readBody(response)) as { error: { data: Record<string, unknown> } };
    expect(body.error.data).toEqual({ resource: 'workflow' });
    expect('identifier' in body.error.data).toBe(false);
  });

  it('NotFound -> 404 with structured body', async () => {
    const fault: OperationFault = {
      code: 'NotFound',
      message: 'workflow "wf-1" not found',
      data: { resource: 'workflow', identifier: 'wf-1' },
    };
    const response = faultToHttpResponse(fault);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = await readBody(response);
    expect(body).toEqual({
      error: {
        code: 'NotFound',
        message: 'workflow "wf-1" not found',
        data: { resource: 'workflow', identifier: 'wf-1' },
      },
    });
  });

  it('NotFound forwards a fine-grained weftCode in data (#465)', async () => {
    const response = faultToHttpResponse({
      code: 'NotFound',
      message: 'workflow "wf-1" not found',
      data: { resource: 'workflow', identifier: 'wf-1', weftCode: 'WorkflowNotFoundError' },
    });
    const body = (await readBody(response)) as { error: { data: Record<string, unknown> } };
    expect(body.error.data).toEqual({
      resource: 'workflow',
      identifier: 'wf-1',
      weftCode: 'WorkflowNotFoundError',
    });
  });

  it('NotFound forwards a weftCode even without an identifier (#465)', async () => {
    const response = faultToHttpResponse({
      code: 'NotFound',
      message: 'workflow not found',
      data: { resource: 'workflow', weftCode: 'WorkflowNotFoundError' },
    });
    const body = (await readBody(response)) as { error: { data: Record<string, unknown> } };
    expect(body.error.data).toEqual({
      resource: 'workflow',
      weftCode: 'WorkflowNotFoundError',
    });
    expect('identifier' in body.error.data).toBe(false);
  });

  it('Unauthorized -> 401', async () => {
    const fault: OperationFault = {
      code: 'Unauthorized',
      message: 'authentication required',
      data: { reason: 'no credentials' },
    };
    const response = faultToHttpResponse(fault);
    expect(response.status).toBe(401);
  });

  it('Forbidden -> 403', async () => {
    const fault: OperationFault = {
      code: 'Forbidden',
      message: 'forbidden',
      data: { reason: 'missing scope workflows:write' },
    };
    const response = faultToHttpResponse(fault);
    expect(response.status).toBe(403);
  });

  it('InvalidParams -> 400 with zod issues in data', async () => {
    const fault: OperationFault = {
      code: 'InvalidParams',
      message: 'invalid params',
      data: {
        issues: [{ path: ['workflowId'], message: 'required', code: 'invalid_type' }],
      },
    };
    const response = faultToHttpResponse(fault);
    expect(response.status).toBe(400);
    const body = (await readBody(response)) as { error: { data: { issues: unknown[] } } };
    expect(body.error.data.issues).toHaveLength(1);
  });

  it('Conflict -> 409', async () => {
    const response = faultToHttpResponse({
      code: 'Conflict',
      message: 'workflow already exists',
      data: { reason: 'duplicate id' },
    });
    expect(response.status).toBe(409);
  });

  it('Unprocessable -> 422', async () => {
    const response = faultToHttpResponse({
      code: 'Unprocessable',
      message: 'workflow is terminal',
      data: { reason: 'cannot signal completed workflow' },
    });
    expect(response.status).toBe(422);
  });

  it('Timeout -> 408', async () => {
    const response = faultToHttpResponse({
      code: 'Timeout',
      message: 'operation timed out',
      data: { operationName: 'weft.workflows.update' },
    });
    expect(response.status).toBe(408);
  });

  it('Timeout with operationName present includes it in the body data field', async () => {
    const response = faultToHttpResponse({
      code: 'Timeout',
      message: 'operation timed out',
      data: { operationName: 'weft.workflows.update' },
    });
    const body = (await readBody(response)) as { error: { data: { operationName: string } } };
    expect(body.error.data).toEqual({ operationName: 'weft.workflows.update' });
  });

  it('NotImplemented -> 501 with no data field in body', async () => {
    const response = faultToHttpResponse({
      code: 'NotImplemented',
      message: 'not implemented',
      data: {},
    });
    expect(response.status).toBe(501);
    const body = (await readBody(response)) as { error: { code: string; data?: unknown } };
    expect(body.error.code).toBe('NotImplemented');
    expect(body.error.data).toBeUndefined();
  });

  it('UnsupportedTransport -> 501 with transport detail', async () => {
    const response = faultToHttpResponse({
      code: 'UnsupportedTransport',
      message: 'transport not supported',
      data: { transport: 'jsonRpcHttp', supported: ['jsonRpcWebSocket'] },
    });
    expect(response.status).toBe(501);
    const body = (await readBody(response)) as { error: { data: { transport: string } } };
    expect(body.error.data.transport).toBe('jsonRpcHttp');
  });

  it('SubscriptionOverflow -> 500 with subscription detail', async () => {
    const response = faultToHttpResponse({
      code: 'SubscriptionOverflow',
      message: 'subscription overflow',
      data: { subscriptionId: 'sub-1', droppedCount: 17 },
    });
    expect(response.status).toBe(500);
  });

  it('MethodNotFound -> 404 with method name', async () => {
    const response = faultToHttpResponse({
      code: 'MethodNotFound',
      message: 'unknown method',
      data: { method: 'weft.unknown' },
    });
    expect(response.status).toBe(404);
  });

  it('EngineFailure -> 500 without leaking internal data', async () => {
    const response = faultToHttpResponse({
      code: 'EngineFailure',
      message: 'internal error',
      data: {},
    });
    expect(response.status).toBe(500);
    const body = (await readBody(response)) as { error: { code: string; data?: unknown } };
    expect(body.error.code).toBe('EngineFailure');
    expect(body.error.data).toBeUndefined();
  });

  it('Timeout without operationName omits the data field in body', async () => {
    const response = faultToHttpResponse({
      code: 'Timeout',
      message: 'operation timed out',
      data: {},
    });
    const body = (await readBody(response)) as { error: { data?: unknown } };
    expect(body.error.data).toBeUndefined();
  });

  it('Timeout with operationName: undefined still omits the data field (filter defined values)', async () => {
    // A caller can construct `data: { operationName: undefined }` legally.
    // Object.keys would still see the key; we must filter by actual value.
    const fault: OperationFault = {
      code: 'Timeout',
      message: 'operation timed out',
      data: { operationName: undefined },
    };
    const response = faultToHttpResponse(fault);
    const body = (await readBody(response)) as { error: { data?: unknown } };
    expect(body.error.data).toBeUndefined();
  });
});
