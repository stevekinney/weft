/** Tests for the route-dispatch fallback REST fault mapper. */

import { describe, expect, it } from 'bun:test';

import type { FaultCode } from '../core/fault-code.ts';
import { faultToHttpResponse } from './fault-to-http.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from './operation-fault.ts';

describe('faultToHttpResponse', () => {
  it('maps every FaultCode to its canonical HTTP status', () => {
    const statusFaults = {
      Unauthorized: { code: 'Unauthorized', message: 'Unauthorized', data: { reason: 'hidden' } },
      Forbidden: { code: 'Forbidden', message: 'Forbidden', data: { reason: 'hidden' } },
      NotFound: { code: 'NotFound', message: 'Not found', data: { resource: 'workflow' } },
      Conflict: { code: 'Conflict', message: 'Conflict', data: { reason: 'hidden' } },
      Unprocessable: {
        code: 'Unprocessable',
        message: 'Invalid state',
        data: { reason: 'hidden' },
      },
      PayloadTooLarge: { code: 'PayloadTooLarge', message: 'Too large', data: { maxBytes: 1 } },
      Timeout: { code: 'Timeout', message: 'Timed out', data: {} },
      NotImplemented: { code: 'NotImplemented', message: 'Not implemented', data: {} },
      UnsupportedTransport: {
        code: 'UnsupportedTransport',
        message: 'Unsupported',
        data: { transport: 'http-rest', supported: ['jsonRpcHttp'] },
      },
      SubscriptionOverflow: {
        code: 'SubscriptionOverflow',
        message: 'Overflow',
        data: { subscriptionId: 'hidden', droppedCount: 1 },
      },
      InvalidParams: { code: 'InvalidParams', message: 'Invalid', data: { issues: [] } },
      MethodNotFound: { code: 'MethodNotFound', message: 'Missing', data: { method: 'missing' } },
      EngineFailure: { code: 'EngineFailure', message: 'private detail', data: {} },
    } satisfies Record<FaultCode, OperationFault>;

    for (const code of Object.keys(statusFaults) as FaultCode[]) {
      expect(faultToHttpResponse(statusFaults[code]).status).toBe(FAULT_CODE_TO_HTTP_STATUS[code]);
    }
  });

  it('uses the flat audited NotFound projection', async () => {
    const response = faultToHttpResponse({
      code: 'NotFound',
      message: 'workflow "wf-1" not found',
      data: {
        resource: 'workflow',
        identifier: 'wf-1',
        weftCode: 'WorkflowNotFoundError',
      },
    });

    expect(await response.json()).toEqual({
      error: 'workflow "wf-1" not found',
      weftCode: 'WorkflowNotFoundError',
      data: { resource: 'workflow', identifier: 'wf-1' },
    });
  });

  it('surfaces non-empty validation issues', async () => {
    const response = faultToHttpResponse({
      code: 'InvalidParams',
      message: 'invalid params',
      data: {
        issues: [{ path: ['workflowId'], message: 'required', code: 'invalid_type' }],
      },
    });

    expect(await response.json()).toEqual({
      error: 'invalid params',
      data: {
        issues: [{ path: ['workflowId'], message: 'required', code: 'invalid_type' }],
      },
    });
  });

  it('withholds unauthenticated reasons and subscription identifiers', async () => {
    const unauthorized = faultToHttpResponse({
      code: 'Unauthorized',
      message: 'authentication required',
      data: { reason: 'credential parser detail' },
    });
    const overflow = faultToHttpResponse({
      code: 'SubscriptionOverflow',
      message: 'subscription overflow',
      data: { subscriptionId: 'private-subscription-id', droppedCount: 17 },
    });

    expect(await unauthorized.json()).toEqual({ error: 'authentication required' });
    expect(await overflow.json()).toEqual({
      error: 'subscription overflow',
      data: { droppedCount: 17 },
    });
  });

  it('masks EngineFailure to the exact canonical bytes', async () => {
    const response = faultToHttpResponse({
      code: 'EngineFailure',
      message: 'database password leaked by implementation detail',
      data: {},
    });

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"error":"Internal server error"}');
  });
});
