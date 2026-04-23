/**
 * Tests for the OperationFault discriminated union — the transport-neutral
 * fault model used by the operation pipeline. Each fault variant carries a
 * stable `code` (used both as the JSON-RPC mapping key and the OpenAPI
 * documentation handle) and a typed `data` payload.
 *
 * See Track 8 design decision 4 and the FaultCode mapping table.
 */

import { describe, expect, it } from 'bun:test';

import {
  FAULT_CODE_TO_HTTP_STATUS,
  FAULT_CODE_TO_JSON_RPC_CODE,
  type FaultCode,
  type OperationFault,
} from './operation-fault.ts';

describe('FaultCode mapping tables', () => {
  it('every FaultCode has an HTTP status and a JSON-RPC code', () => {
    const codes: FaultCode[] = [
      'Unauthorized',
      'Forbidden',
      'NotFound',
      'Conflict',
      'Unprocessable',
      'Timeout',
      'RateLimited',
      'NotImplemented',
      'UnsupportedTransport',
      'SubscriptionOverflow',
      'InvalidParams',
      'MethodNotFound',
      'EngineFailure',
    ];
    for (const code of codes) {
      expect(typeof FAULT_CODE_TO_HTTP_STATUS[code]).toBe('number');
      expect(typeof FAULT_CODE_TO_JSON_RPC_CODE[code]).toBe('number');
    }
  });

  it('HTTP statuses match the plan (Track 8 design decision 4)', () => {
    expect(FAULT_CODE_TO_HTTP_STATUS.Unauthorized).toBe(401);
    expect(FAULT_CODE_TO_HTTP_STATUS.Forbidden).toBe(403);
    expect(FAULT_CODE_TO_HTTP_STATUS.NotFound).toBe(404);
    expect(FAULT_CODE_TO_HTTP_STATUS.Conflict).toBe(409);
    expect(FAULT_CODE_TO_HTTP_STATUS.Unprocessable).toBe(422);
    expect(FAULT_CODE_TO_HTTP_STATUS.Timeout).toBe(408);
    expect(FAULT_CODE_TO_HTTP_STATUS.RateLimited).toBe(429);
    expect(FAULT_CODE_TO_HTTP_STATUS.NotImplemented).toBe(501);
    expect(FAULT_CODE_TO_HTTP_STATUS.UnsupportedTransport).toBe(501);
    expect(FAULT_CODE_TO_HTTP_STATUS.SubscriptionOverflow).toBe(500);
    expect(FAULT_CODE_TO_HTTP_STATUS.InvalidParams).toBe(400);
    expect(FAULT_CODE_TO_HTTP_STATUS.MethodNotFound).toBe(404);
    expect(FAULT_CODE_TO_HTTP_STATUS.EngineFailure).toBe(500);
  });

  it('Weft domain JSON-RPC codes live in the -32010..-32099 band', () => {
    expect(FAULT_CODE_TO_JSON_RPC_CODE.Unauthorized).toBe(-32010);
    expect(FAULT_CODE_TO_JSON_RPC_CODE.Forbidden).toBe(-32011);
    expect(FAULT_CODE_TO_JSON_RPC_CODE.NotFound).toBe(-32020);
    expect(FAULT_CODE_TO_JSON_RPC_CODE.Conflict).toBe(-32021);
    expect(FAULT_CODE_TO_JSON_RPC_CODE.Unprocessable).toBe(-32022);
    expect(FAULT_CODE_TO_JSON_RPC_CODE.Timeout).toBe(-32023);
    expect(FAULT_CODE_TO_JSON_RPC_CODE.RateLimited).toBe(-32024);
    expect(FAULT_CODE_TO_JSON_RPC_CODE.NotImplemented).toBe(-32025);
    expect(FAULT_CODE_TO_JSON_RPC_CODE.UnsupportedTransport).toBe(-32030);
    expect(FAULT_CODE_TO_JSON_RPC_CODE.SubscriptionOverflow).toBe(-32031);
    expect(FAULT_CODE_TO_JSON_RPC_CODE.EngineFailure).toBe(-32099);
  });

  it('protocol-reserved JSON-RPC codes match the spec', () => {
    expect(FAULT_CODE_TO_JSON_RPC_CODE.InvalidParams).toBe(-32602);
    expect(FAULT_CODE_TO_JSON_RPC_CODE.MethodNotFound).toBe(-32601);
  });

  it('every Weft domain code is unique inside the -32010..-32099 band', () => {
    const weftCodes = (Object.keys(FAULT_CODE_TO_JSON_RPC_CODE) as FaultCode[])
      .map((code) => FAULT_CODE_TO_JSON_RPC_CODE[code])
      .filter((value) => value <= -32000 && value > -32100);
    expect(new Set(weftCodes).size).toBe(weftCodes.length);
  });
});

describe('OperationFault discriminated union', () => {
  it('InvalidParams fault carries flattened zod issues in data', () => {
    const fault: OperationFault = {
      code: 'InvalidParams',
      message: 'invalid params',
      data: { issues: [{ path: ['workflowId'], message: 'required', code: 'invalid_type' }] },
    };
    expect(fault.code).toBe('InvalidParams');
    expect(fault.data.issues).toHaveLength(1);
  });

  it('NotFound fault carries the missing resource identifier', () => {
    const fault: OperationFault = {
      code: 'NotFound',
      message: 'workflow not found',
      data: { resource: 'workflow', identifier: 'wf-1' },
    };
    expect(fault.data.resource).toBe('workflow');
    expect(fault.data.identifier).toBe('wf-1');
  });

  it('Forbidden / Unauthorized faults carry a denial reason', () => {
    const forbidden: OperationFault = {
      code: 'Forbidden',
      message: 'forbidden',
      data: { reason: 'missing scope workflows:write' },
    };
    expect(forbidden.data.reason).toContain('workflows:write');
  });

  it('UnsupportedTransport fault names the rejected transport and the supported list', () => {
    const fault: OperationFault = {
      code: 'UnsupportedTransport',
      message: 'transport not supported',
      data: { transport: 'jsonRpcHttp', supported: ['jsonRpcWebSocket', 'jsonRpcStdio'] },
    };
    expect(fault.data.transport).toBe('jsonRpcHttp');
    expect(fault.data.supported).toContain('jsonRpcWebSocket');
  });

  it('SubscriptionOverflow fault carries subscriptionId and droppedCount', () => {
    const fault: OperationFault = {
      code: 'SubscriptionOverflow',
      message: 'subscription overflow',
      data: { subscriptionId: 'sub-1', droppedCount: 17 },
    };
    expect(fault.data.subscriptionId).toBe('sub-1');
    expect(fault.data.droppedCount).toBe(17);
  });

  it('NotImplemented fault carries an empty data object (uniform shape)', () => {
    const fault: OperationFault = {
      code: 'NotImplemented',
      message: 'not implemented',
      data: {},
    };
    expect(fault.code).toBe('NotImplemented');
    expect(fault.data).toEqual({});
  });

  it('EngineFailure fault carries an empty data object (no internal-detail leak)', () => {
    const fault: OperationFault = {
      code: 'EngineFailure',
      message: 'internal error',
      data: {},
    };
    expect(fault.code).toBe('EngineFailure');
    expect(fault.data).toEqual({});
  });

  it('RateLimited fault may include retryAfterMs', () => {
    const fault: OperationFault = {
      code: 'RateLimited',
      message: 'rate limited',
      data: { retryAfterMs: 5000 },
    };
    expect(fault.data.retryAfterMs).toBe(5000);
  });
});
