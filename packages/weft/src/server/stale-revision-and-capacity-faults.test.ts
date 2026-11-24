/**
 * Transport coverage for the `StaleRevision`, `RateLimited`, `Unavailable`, and
 * `UnsupportedCapability` fault codes: REST status and `Retry-After`, JSON-RPC
 * code and payload, failure category, and OpenRPC listing.
 */

import { describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import {
  defineOperation,
  isFaultCode,
  staleRevisionFault,
  type OperationFault,
} from "../embedded/backchannel/src/index.ts";
import {
  assertFiniteFaultData,
  buildErrorResponses,
  buildOpenRpcComponentsErrors,
  createOperationRegistry,
  FAULT_CODE_TO_HTTP_STATUS,
  FAULT_CODE_TO_JSON_RPC_CODE,
  faultToHttpResponse,
  faultToJsonRpcError,
  generateOpenRpcDocument,
  shapeOperationFaultAsJson,
} from "../embedded/backchannel/src/internals.ts";
import { failureCategoryForFaultCode } from '../core/fault-code.ts';
import type { FailureCategory } from '../core/types/identity.ts';
import { isRecord } from './protocol.test-support.ts';

type AddedFault = Extract<
  OperationFault,
  { code: 'StaleRevision' | 'RateLimited' | 'Unavailable' | 'UnsupportedCapability' }
>;

const staleRevision: AddedFault = {
  code: 'StaleRevision',
  message: 'revision is stale',
  data: { expectedRevision: 3, currentRevision: 5 },
};
const rateLimited: AddedFault = {
  code: 'RateLimited',
  message: 'too many requests',
  data: { retryAfterSeconds: 30 },
};
const unavailable: AddedFault = {
  code: 'Unavailable',
  message: 'temporarily unavailable',
  data: { reason: 'storage is recovering', retryAfterSeconds: 7 },
};
const unsupportedCapability: AddedFault = {
  code: 'UnsupportedCapability',
  message: 'capability not supported',
  data: { capability: 'streams' },
};

type AddedCodeRow = {
  readonly fault: AddedFault;
  readonly http: number;
  readonly jsonRpc: number;
  readonly category: FailureCategory;
  readonly retryable: boolean;
  readonly jsonRpcData: Record<string, unknown>;
  readonly restData: Record<string, unknown>;
};

const ADDED_CODES: AddedCodeRow[] = [
  {
    fault: staleRevision,
    http: 409,
    jsonRpc: -32026,
    category: 'application',
    retryable: false,
    jsonRpcData: { expectedRevision: 3, currentRevision: 5 },
    restData: { expectedRevision: 3, currentRevision: 5 },
  },
  {
    fault: rateLimited,
    http: 429,
    jsonRpc: -32027,
    category: 'resource',
    retryable: true,
    jsonRpcData: { retryAfterSeconds: 30 },
    restData: { retryAfterSeconds: 30 },
  },
  {
    fault: unavailable,
    http: 503,
    jsonRpc: -32028,
    category: 'system',
    retryable: true,
    jsonRpcData: { reason: 'storage is recovering', retryAfterSeconds: 7 },
    // `reason` is internal detail: REST discloses only the retry delay.
    restData: { retryAfterSeconds: 7 },
  },
  {
    fault: unsupportedCapability,
    http: 501,
    jsonRpc: -32029,
    category: 'system',
    retryable: false,
    jsonRpcData: { capability: 'streams' },
    restData: { capability: 'streams' },
  },
];

describe.each(ADDED_CODES)('$fault.code', (row) => {
  const code = row.fault.code;

  it('is a known fault code with its failure category', () => {
    expect(isFaultCode(code)).toBe(true);
    expect(failureCategoryForFaultCode(code)).toBe(row.category);
  });

  it('maps to its HTTP status', () => {
    expect(FAULT_CODE_TO_HTTP_STATUS[code]).toBe(row.http);
    expect(faultToHttpResponse(row.fault).status).toBe(row.http);
    expect(shapeOperationFaultAsJson(row.fault).status).toBe(row.http);
  });

  it('serializes the typed data an audited REST body discloses', async () => {
    const body = await faultToHttpResponse(row.fault).json();
    expect(body).toEqual({
      error: row.fault.message,
      data: row.restData,
      retryable: row.retryable,
    });
  });

  it('maps to its JSON-RPC code and payload', () => {
    expect(FAULT_CODE_TO_JSON_RPC_CODE[code]).toBe(row.jsonRpc);
    expect(faultToJsonRpcError(row.fault)).toEqual({
      code: row.jsonRpc,
      message: row.fault.message,
      data: {
        ...row.jsonRpcData,
        weftCode: code,
        httpStatus: row.http,
        retryable: row.retryable,
      },
    });
  });

  it('is listed in the OpenRPC error components', () => {
    expect(buildOpenRpcComponentsErrors()[code]).toMatchObject({
      code: row.jsonRpc,
      message: code,
      'x-http-status': row.http,
    });
  });
});

describe('Retry-After', () => {
  it('is emitted for RateLimited and Unavailable over REST', () => {
    expect(faultToHttpResponse(rateLimited).headers.get('Retry-After')).toBe('30');
    expect(faultToHttpResponse(unavailable).headers.get('Retry-After')).toBe('7');
  });

  it('rounds a fractional delay up so a client never retries early', () => {
    const fault: AddedFault = { ...rateLimited, data: { retryAfterSeconds: 1.2 } };
    expect(faultToHttpResponse(fault).headers.get('Retry-After')).toBe('2');
  });

  it('is omitted when the delay is absent, negative, or not finite', () => {
    for (const retryAfterSeconds of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const fault: AddedFault = { ...rateLimited, data: { retryAfterSeconds } };
      const response = faultToHttpResponse(fault);
      expect(response.status).toBe(429);
      expect(response.headers.has('Retry-After')).toBe(false);
    }
    expect(faultToHttpResponse({ ...unavailable, data: {} }).headers.has('Retry-After')).toBe(
      false,
    );
  });

  it('is never emitted for other fault codes', () => {
    expect(faultToHttpResponse(staleRevision).headers.has('Retry-After')).toBe(false);
    expect(faultToHttpResponse(unsupportedCapability).headers.has('Retry-After')).toBe(false);
  });

  it('keeps a non-finite or negative delay out of every wire payload', async () => {
    for (const retryAfterSeconds of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      for (const base of [rateLimited, unavailable]) {
        const fault: AddedFault = { ...base, data: { ...base.data, retryAfterSeconds } };
        expect(faultToJsonRpcError(fault).data).not.toHaveProperty('retryAfterSeconds');
        const restBody = (await faultToHttpResponse(fault).json()) as { data?: object };
        expect(restBody.data ?? {}).not.toHaveProperty('retryAfterSeconds');
      }
    }
  });

  it('always carries currentRevision, the field that tells a client to re-read and retry', async () => {
    const fault: AddedFault = { ...staleRevision, data: { currentRevision: 9 } };
    expect(await faultToHttpResponse(fault).json()).toEqual({
      error: fault.message,
      data: { currentRevision: 9 },
      retryable: false,
    });
    expect(faultToJsonRpcError(fault).data).toMatchObject({ currentRevision: 9 });
    // Even a falsy revision survives.
    const zero: AddedFault = { ...staleRevision, data: { currentRevision: 0 } };
    expect(await faultToHttpResponse(zero).json()).toEqual({
      error: zero.message,
      data: { currentRevision: 0 },
      retryable: false,
    });
  });

  describe('non-finite revision tokens', () => {
    // `NaN` and `Infinity` serialize as `null`, which would break the schema's
    // required `currentRevision`. A fault carrying one is a programming error.
    const NON_FINITE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

    for (const field of ['currentRevision', 'expectedRevision'] as const) {
      for (const value of NON_FINITE) {
        it(`${field} = ${String(value)} is refused by the factory`, () => {
          expect(() => staleRevisionFault('stale', { currentRevision: 5, [field]: value })).toThrow(
            TypeError,
          );
        });

        it(`${field} = ${String(value)} is never sent as null: REST and JSON-RPC answer with the masked internal error`, async () => {
          const fault = {
            code: 'StaleRevision',
            message: 'stale',
            data: { currentRevision: 5, [field]: value },
          } as AddedFault;
          const errors = spyOn(console, 'error').mockImplementation(() => {});
          try {
            const rest = faultToHttpResponse(fault);
            expect(rest.status).toBe(500);
            expect(await rest.json()).toEqual({ error: 'Internal server error', retryable: false });
            expect((await shapeOperationFaultAsJson(fault).json()) as unknown).toEqual({
              error: 'Internal server error',
              retryable: false,
            });
            const rpc = faultToJsonRpcError(fault);
            expect(rpc.data).toEqual({
              weftCode: 'EngineFailure',
              httpStatus: 500,
              retryable: false,
            });
            expect(errors).toHaveBeenCalledTimes(3);
            expect(String(errors.mock.calls[0]?.[0])).toContain(`data.${field}`);
          } finally {
            errors.mockRestore();
          }
        });
      }
    }

    it('accepts finite numbers and string tokens through the factory', () => {
      expect(staleRevisionFault('stale', { currentRevision: 0 }).data).toEqual({
        currentRevision: 0,
      });
      expect(
        staleRevisionFault('stale', { currentRevision: 'r9', expectedRevision: -3 }).data,
      ).toEqual({ currentRevision: 'r9', expectedRevision: -3 });
    });

    it('applies one finite-number check to every numeric field of fault data', () => {
      const payloadTooLarge: OperationFault = {
        code: 'PayloadTooLarge',
        message: 'too large',
        data: { maxBytes: Number.NaN },
      };
      expect(() => assertFiniteFaultData(payloadTooLarge)).toThrow(TypeError);
      const errors = spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(faultToHttpResponse(payloadTooLarge).status).toBe(500);
        expect(faultToJsonRpcError(payloadTooLarge).data).toEqual({
          weftCode: 'EngineFailure',
          httpStatus: 500,
          retryable: false,
        });
      } finally {
        errors.mockRestore();
      }
    });
  });

  it('keeps an undefined delay out of the wire payloads', async () => {
    const fault: AddedFault = { ...rateLimited, data: {} };
    expect(await faultToHttpResponse(fault).json()).toEqual({
      error: fault.message,
      retryable: true,
    });
    expect(faultToJsonRpcError(fault).data).toEqual({
      weftCode: 'RateLimited',
      httpStatus: 429,
      retryable: true,
    });
  });
});

describe('OpenRPC and OpenAPI listing of operations that declare the codes', () => {
  const declaring = defineOperation({
    name: 'weft.test.declares.added.faults',
    mcpExposable: false,
    destructive: false,
    summary: 'declares the added fault codes',
    tags: [],
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    access: { kind: 'public' as const },
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'reject' as const, jsonRpc: 'reject' as const },
    producibleFaults: ['StaleRevision', 'RateLimited', 'Unavailable', 'UnsupportedCapability'],
    invoke: async () => ({}),
  });
  const silent = defineOperation({
    name: 'weft.test.declares.nothing',
    mcpExposable: false,
    destructive: false,
    summary: 'declares no additional faults',
    tags: [],
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    access: { kind: 'public' as const },
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'reject' as const, jsonRpc: 'reject' as const },
    invoke: async () => ({}),
  });

  function methodErrors(name: string): readonly string[] {
    const document = generateOpenRpcDocument({
      registry: createOperationRegistry([declaring, silent]),
      transports: ['http'],
      includeMcpMetadata: false,
    });
    const methods = document['methods'];
    if (!Array.isArray(methods)) throw new Error('document has no methods');
    const method = methods.find((candidate) => isRecord(candidate) && candidate['name'] === name);
    if (!isRecord(method) || !Array.isArray(method['errors'])) {
      throw new Error(`method ${name} has no errors`);
    }
    return method['errors'].map((reference) =>
      isRecord(reference) ? String(reference['$ref']) : '',
    );
  }

  it('lists each added code on the operation that declares it, and only there', () => {
    const declared = methodErrors('weft.test.declares.added.faults');
    for (const { fault } of ADDED_CODES) {
      expect(declared).toContain(`#/components/errors/${fault.code}`);
      expect(methodErrors('weft.test.declares.nothing')).not.toContain(
        `#/components/errors/${fault.code}`,
      );
    }
  });

  it('documents the statuses in the OpenAPI responses', () => {
    expect(Object.keys(buildErrorResponses(declaring))).toEqual(
      expect.arrayContaining(['409', '429', '501', '503']),
    );
  });
});
