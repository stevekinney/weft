/**
 * Tests for `faultToJsonRpcError` — converts a transport-neutral
 * OperationFault into the JSON-RPC error object the dispatchers send.
 */

import { describe, expect, it } from 'bun:test';

import { faultToJsonRpcError } from './fault-to-json-rpc.ts';
import type { OperationFault } from './operation-fault.ts';

describe('faultToJsonRpcError', () => {
  it('NotFound -> code -32020 with weftCode + httpStatus in data', () => {
    const fault: OperationFault = {
      code: 'NotFound',
      message: 'workflow not found',
      data: { resource: 'workflow', identifier: 'wf-1' },
    };
    const error = faultToJsonRpcError(fault);
    expect(error.code).toBe(-32020);
    expect(error.message).toBe('workflow not found');
    expect(error.data).toMatchObject({
      weftCode: 'NotFound',
      httpStatus: 404,
      resource: 'workflow',
      identifier: 'wf-1',
    });
  });

  it('Unauthorized -> -32010', () => {
    const error = faultToJsonRpcError({
      code: 'Unauthorized',
      message: 'authentication required',
      data: { reason: 'no credentials' },
    });
    expect(error.code).toBe(-32010);
    expect(error.data).toMatchObject({
      weftCode: 'Unauthorized',
      httpStatus: 401,
      reason: 'no credentials',
    });
  });

  it('Forbidden -> -32011', () => {
    const error = faultToJsonRpcError({
      code: 'Forbidden',
      message: 'forbidden',
      data: { reason: 'missing scope workflows:write' },
    });
    expect(error.code).toBe(-32011);
    expect(error.data).toMatchObject({ weftCode: 'Forbidden', httpStatus: 403 });
  });

  it('InvalidParams -> -32602 (reserved spec code) with zod issues in data', () => {
    const error = faultToJsonRpcError({
      code: 'InvalidParams',
      message: 'invalid params',
      data: {
        issues: [{ path: ['workflowId'], message: 'required', code: 'invalid_type' }],
      },
    });
    expect(error.code).toBe(-32602);
    expect(error.data).toMatchObject({ weftCode: 'InvalidParams', httpStatus: 400 });
    expect((error.data as { issues: unknown[] }).issues).toHaveLength(1);
  });

  it('MethodNotFound -> -32601 (reserved spec code)', () => {
    const error = faultToJsonRpcError({
      code: 'MethodNotFound',
      message: 'unknown method',
      data: { method: 'weft.unknown' },
    });
    expect(error.code).toBe(-32601);
    expect(error.data).toMatchObject({
      weftCode: 'MethodNotFound',
      httpStatus: 404,
      method: 'weft.unknown',
    });
  });

  it('UnsupportedTransport -> -32030 (Weft domain)', () => {
    const error = faultToJsonRpcError({
      code: 'UnsupportedTransport',
      message: 'unsupported',
      data: { transport: 'jsonRpcHttp', supported: ['jsonRpcWebSocket'] },
    });
    expect(error.code).toBe(-32030);
    expect(error.data).toMatchObject({
      weftCode: 'UnsupportedTransport',
      transport: 'jsonRpcHttp',
    });
  });

  it('SubscriptionOverflow -> -32031', () => {
    const error = faultToJsonRpcError({
      code: 'SubscriptionOverflow',
      message: 'overflow',
      data: { subscriptionId: 'sub-1', droppedCount: 17 },
    });
    expect(error.code).toBe(-32031);
  });

  it('NotImplemented -> -32025 with no extra data', () => {
    const error = faultToJsonRpcError({
      code: 'NotImplemented',
      message: 'not implemented',
      data: {},
    });
    expect(error.code).toBe(-32025);
    expect(error.data).toMatchObject({ weftCode: 'NotImplemented', httpStatus: 501 });
  });

  it('EngineFailure -> -32099 (no internal-detail leak)', () => {
    const error = faultToJsonRpcError({
      code: 'EngineFailure',
      message: 'internal error',
      data: {},
    });
    expect(error.code).toBe(-32099);
    expect(error.data).toMatchObject({ weftCode: 'EngineFailure', httpStatus: 500 });
    // Just the metadata pair — no leaked internals.
    expect(Object.keys(error.data).toSorted()).toEqual(['httpStatus', 'weftCode']);
  });

  it('Conflict -> -32021', () => {
    const error = faultToJsonRpcError({
      code: 'Conflict',
      message: 'conflict',
      data: { reason: 'duplicate id' },
    });
    expect(error.code).toBe(-32021);
  });

  it('Unprocessable -> -32022', () => {
    const error = faultToJsonRpcError({
      code: 'Unprocessable',
      message: 'unprocessable',
      data: { reason: 'workflow terminal' },
    });
    expect(error.code).toBe(-32022);
  });

  it('Timeout -> -32023', () => {
    const error = faultToJsonRpcError({
      code: 'Timeout',
      message: 'timeout',
      data: { operationName: 'weft.workflows.update' },
    });
    expect(error.code).toBe(-32023);
  });

  it('RateLimited -> -32024 with retry-after data merged', () => {
    const error = faultToJsonRpcError({
      code: 'RateLimited',
      message: 'rate limited',
      data: { retryAfterMs: 5000 },
    });
    expect(error.code).toBe(-32024);
    expect(error.data).toMatchObject({
      weftCode: 'RateLimited',
      httpStatus: 429,
      retryAfterMs: 5000,
    });
  });

  it('every error includes weftCode + httpStatus in data (uniform shape)', () => {
    const samples: OperationFault[] = [
      { code: 'Unauthorized', message: 'x', data: { reason: 'r' } },
      { code: 'Forbidden', message: 'x', data: { reason: 'r' } },
      { code: 'NotFound', message: 'x', data: { resource: 'r' } },
      { code: 'EngineFailure', message: 'x', data: {} },
    ];
    for (const fault of samples) {
      const error = faultToJsonRpcError(fault);
      const data = error.data;
      expect(data['weftCode']).toBe(fault.code);
      expect(typeof data['httpStatus']).toBe('number');
    }
  });

  it('Timeout without operationName produces minimal data (only the metadata pair)', () => {
    const error = faultToJsonRpcError({
      code: 'Timeout',
      message: 'timed out',
      data: {},
    });
    expect(Object.keys(error.data).toSorted()).toEqual(['httpStatus', 'weftCode']);
  });

  it('RateLimited without retryAfterMs produces minimal data', () => {
    const error = faultToJsonRpcError({
      code: 'RateLimited',
      message: 'rate limited',
      data: {},
    });
    expect(Object.keys(error.data).toSorted()).toEqual(['httpStatus', 'weftCode']);
  });

  it('UnsupportedTransport `supported` array is copied (defensive against caller mutation)', () => {
    const supported = ['jsonRpcWebSocket' as const];
    const error = faultToJsonRpcError({
      code: 'UnsupportedTransport',
      message: 'no',
      data: { transport: 'jsonRpcHttp', supported },
    });
    const data = error.data as { supported: string[] };
    expect(data.supported).toEqual(['jsonRpcWebSocket']);
    expect(data.supported).not.toBe(supported);
  });

  it('InvalidParams `issues` array is deep-copied (path arrays defensive too)', () => {
    const original = {
      path: ['workflowId'] as const,
      message: 'required',
      code: 'invalid_type',
    };
    const error = faultToJsonRpcError({
      code: 'InvalidParams',
      message: 'invalid',
      data: { issues: [original] },
    });
    const data = error.data as {
      issues: ReadonlyArray<{ path: ReadonlyArray<string>; message: string; code: string }>;
    };
    expect(data.issues[0]?.path).toEqual(['workflowId']);
    expect(data.issues[0]).not.toBe(original);
  });
});
