import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { defineOperation } from '../operation-registry.ts';
import { createOperationRegistry } from './registry.ts';
import type { PipelineTraceMarker } from './types.ts';

const EXPECTED_PIPELINE_TRACE: PipelineTraceMarker[] = [
  'looked-up',
  'transport-checked',
  'access-checked',
  'parsed',
  'unknown-key-policy-applied',
  'authorized',
  'invoked',
  'output-validated',
];

describe('operation dispatch audit — HTTP-handler integration', () => {
  it('records the prefix-up-to-failure when input parsing fails on a real HTTP POST', async () => {
    // Failure-path coverage: the test proves the trace records the
    // pre-failure stages and stops. A regression where an HTTP adapter
    // shortcuts past parse failure (e.g. invokes the operation with raw
    // input) would surface as the trace containing markers AFTER `parsed`.
    const { handleRequest, engine, registry, traceBinding, markers } =
      await createHttpTraceFixture();

    try {
      // value field missing → Zod safeParse rejects → InvalidParams.
      const response = await handleRequest(
        new Request('http://localhost/v1/test/trace', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }),
        engine,
        {
          operationRegistry: registry,
          restBindings: [traceBinding],
          pipelineTrace: (marker) => markers.push(marker),
        },
      );

      expect(response.status).toBe(400);
      // The trace records every stage that succeeded before the parse
      // failure (lookup, transport-checked, access-checked) and nothing
      // after the failed stage. `parsed` and `unknown-key-policy-applied`
      // both fire only AFTER successful Zod validation, so they should
      // be absent here.
      expect(markers).toEqual(['looked-up', 'transport-checked', 'access-checked']);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('drives all eight pipeline-stage markers when a request reaches the real HTTP handler', async () => {
    // This proves the HTTP transport adapter does call executeOperation
    // through the standard pipeline rather than shortcutting around it.
    // The earlier transport sweep above tests executeOperation directly;
    // this test verifies the HTTP handler path lands at executeOperation.
    const { handleRequest, engine, registry, traceBinding, markers } =
      await createHttpTraceFixture();

    try {
      const response = await handleRequest(
        new Request('http://localhost/v1/test/trace', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: 'http' }),
        }),
        engine,
        {
          operationRegistry: registry,
          restBindings: [traceBinding],
          pipelineTrace: (marker) => markers.push(marker),
        },
      );

      expect(response.status).toBe(200);
      expect(markers).toEqual(EXPECTED_PIPELINE_TRACE);
    } finally {
      engine[Symbol.dispose]();
    }
  });
});

/**
 * Build the invariant HTTP-handler trace harness shared by the two
 * HTTP-integration tests: the dynamic imports, the trace operation + registry,
 * the REST `traceBinding`, a fresh marker array, and an engine over
 * `MemoryStorage`. Each test keeps its own request body, expected status, and
 * expected marker sequence at the call site; the caller disposes the engine.
 */
async function createHttpTraceFixture() {
  const { handleRequest } = await import('../handler.ts');
  const { Engine } = await import('../../core/engine.ts');
  const { MemoryStorage } = await import('../../storage/memory.ts');

  const registry = createOperationRegistry([createTraceOperation()]);
  const traceBinding = {
    method: 'POST' as const,
    path: '/v1/test/trace',
    pathParamNames: [] as readonly string[],
    operationName: 'weft.audit.trace',
    inputSources: { value: { kind: 'body-field' as const, bodyField: 'value' } },
    extractInput: async (request: Request) => {
      const body = await request.json();
      if (!isRecord(body)) throw new Error('expected object request body');
      return { value: body['value'] };
    },
    success: { kind: 'json' as const, status: 200 },
  };
  const markers: PipelineTraceMarker[] = [];
  const engine = new Engine({ storage: new MemoryStorage() });

  return { handleRequest, engine, registry, traceBinding, markers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createTraceOperation() {
  return defineOperation({
    name: 'weft.audit.trace',
    mcpExposable: false,
    destructive: false,
    summary: 'Audit pipeline trace markers',
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ echoed: z.string() }),
    access: { kind: 'public' as const },
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'reject' as const, jsonRpc: 'reject' as const },
    invoke: async ({ input }) => ({ echoed: input.value }),
  });
}
