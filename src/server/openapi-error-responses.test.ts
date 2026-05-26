import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { buildErrorResponses } from './openapi-error-responses.ts';
import type { ErasedOperation } from './operation-catalog.ts';
import type { FaultCode } from './operation-fault.ts';

function operation(producibleFaults?: readonly FaultCode[]): ErasedOperation {
  // Test-only cast: invoke parameter variance is intentionally relaxed in test fixtures.
  const base = {
    name: 'weft.test.errors',
    mcpExposable: false,
    summary: 'test operation',
    tags: [],
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    access: { kind: 'public' as const },
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'reject' as const, jsonRpc: 'reject' as const },
    invoke: async () => ({}),
  } as ErasedOperation;
  return producibleFaults === undefined ? base : { ...base, producibleFaults };
}

function responseSchema(response: unknown): unknown {
  if (response === null || typeof response !== 'object') return undefined;
  const content = (response as Record<string, unknown>)['content'];
  if (content === null || typeof content !== 'object') return undefined;
  const applicationJson = (content as Record<string, unknown>)['application/json'];
  if (applicationJson === null || typeof applicationJson !== 'object') return undefined;
  return (applicationJson as Record<string, unknown>)['schema'];
}

describe('buildErrorResponses', () => {
  it('includes only universal-default statuses when an operation has no producibleFaults', () => {
    expect(Object.keys(buildErrorResponses(operation())).toSorted()).toEqual([
      '400',
      '401',
      '403',
      '500',
    ]);
  });

  it('includes operation-specific statuses in addition to universal defaults', () => {
    expect(Object.keys(buildErrorResponses(operation(['Conflict', 'Timeout']))).toSorted()).toEqual(
      ['400', '401', '403', '408', '409', '500'],
    );
  });

  it('references the shared Error component for every response schema', () => {
    const responses = buildErrorResponses(operation(['Conflict', 'Timeout']));

    for (const response of Object.values(responses)) {
      expect(responseSchema(response)).toEqual({ $ref: '#/components/schemas/Error' });
    }
  });

  it('merges multiple fault codes that share one HTTP status into a single response entry', () => {
    const responses = buildErrorResponses(operation(['NotImplemented', 'UnsupportedTransport']));

    expect(Object.keys(responses).toSorted()).toEqual(['400', '401', '403', '500', '501']);
    expect(responses['501']).toEqual(
      expect.objectContaining({
        description: 'NotImplemented, UnsupportedTransport',
      }),
    );
  });
});
