import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { TransportKind } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import { anonymousPrincipal } from '../principal.ts';
import { DISPATCH_ALLOWLIST } from './dispatch-allowlist.ts';
import { executeOperation } from './pipeline.ts';
import { createOperationRegistry } from './registry.ts';
import { executeStream, executeSubscription } from './stream-pipeline.ts';
import type {
  DispatchContext,
  ErasedOperation,
  PipelineTrace,
  PipelineTraceMarker,
} from './types.ts';

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

const TRANSPORTS = [
  'http-rest',
  'jsonRpcHttp',
  'jsonRpcWebSocket',
  'jsonRpcStdio',
] as const satisfies ReadonlyArray<TransportKind>;

describe('operation dispatch audit — pipeline trace sweep', () => {
  it('emits every pipeline marker in order for each transport kind', async () => {
    const registry = createOperationRegistry([createTraceOperation()]);

    for (const transport of TRANSPORTS) {
      const markers: PipelineTraceMarker[] = [];
      const result = await executeOperation(
        'weft.audit.trace',
        { value: 'ok' },
        {
          principal: anonymousPrincipal(),
          engine: {},
          transport,
          registry,
          pipelineTrace: (marker) => markers.push(marker),
        },
      );

      expect(result).toEqual({ ok: true, value: { echoed: 'ok' } });
      expect(markers).toEqual(EXPECTED_PIPELINE_TRACE);
    }
  });
});

describe('operation dispatch audit — allow-list invariant', () => {
  it('contains only the stateful WebSocket session lifecycle exemptions', () => {
    expect(DISPATCH_ALLOWLIST).toEqual(
      new Set(['weft.workflows.subscribe', 'weft.workflows.unsubscribe']),
    );
    expect(DISPATCH_ALLOWLIST.size).toBe(2);
  });
});

describe('operation dispatch audit — negative fixture', () => {
  it('detects a handler that skips the parsing and unknown-key-policy stages', async () => {
    const operation = createTraceOperation();
    const registry = createOperationRegistry([operation]);
    const registeredOperation = registry.get('weft.audit.trace');
    if (registeredOperation === undefined) throw new Error('expected audit operation to register');
    const markers: PipelineTraceMarker[] = [];

    await skipParsingHandler(registeredOperation, {
      principal: anonymousPrincipal(),
      engine: {},
      transport: 'jsonRpcWebSocket',
      registry,
      pipelineTrace: (marker) => markers.push(marker),
    });

    expect(markers).not.toContain('parsed');
    expect(markers).not.toContain('unknown-key-policy-applied');
  });
});

describe('operation dispatch audit — discriminated union compile-time guarantees', () => {
  it('compiles: kind: stream with eventSchema is accepted', () => {
    // The compile-time test is the test. If this file compiles, the
    // discriminated union accepts the well-formed stream operation; if
    // someone removes `eventSchema`, this file fails to compile and the
    // whole audit suite fails to run.
    const operation = defineOperation({
      name: 'weft.audit.streamtrace',
      mcpExposable: false,
      destructive: false,
      kind: 'stream',
      summary: 'fixture',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      eventSchema: z.object({ chunk: z.string() }),
      access: { kind: 'public' },
      transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async () => {
        async function* iter() {
          yield { chunk: 'a' };
        }
        return iter();
      },
    });
    expect(operation.kind).toBe('stream');
    expect(operation.eventSchema).toBeDefined();
  });

  it('compiles: kind: subscription with eventSchema is accepted', () => {
    const operation = defineOperation({
      name: 'weft.audit.subtrace',
      mcpExposable: false,
      destructive: false,
      kind: 'subscription',
      summary: 'fixture',
      inputSchema: z.object({}),
      outputSchema: z.object({ subscriptionId: z.string(), cursor: z.string() }),
      eventSchema: z.object({ envelope: z.unknown() }),
      access: { kind: 'public' },
      transports: { http: false, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async () => ({
        envelope: { subscriptionId: 's', cursor: 'c' },
        iterable: (async function* () {})(),
        close: async () => {},
      }),
    });
    expect(operation.kind).toBe('subscription');
    expect(operation.eventSchema).toBeDefined();
  });

  // Negative compile-time tests: documented for future readers, NOT
  // executed as runtime tests (TypeScript already proves them at build
  // time). The discriminated union forbids these at type-check time:
  //
  //   defineOperation({ kind: 'stream', /* no eventSchema */ ... })
  //     ^^^^^^^^^^^^ Property 'eventSchema' is missing
  //
  //   defineOperation({ kind: 'unary', eventSchema: z.unknown(), ... })
  //     ^^^^^^^^^^^ Object literal may only specify known properties,
  //                 and 'eventSchema' does not exist in type
  //                 'UnaryOperationDefinition...'
});

describe('operation dispatch audit — long-lived kind guards', () => {
  it('executeStream against a unary operation records only `looked-up` then fails Unprocessable', async () => {
    // The kind check sits between lookupOperation and prepareAuthorizedInput;
    // if a future refactor pushed it past transport/access, this trace would
    // grow extra markers and the failure code would still pass — only the
    // pinned marker list catches the regression.
    const registry = createOperationRegistry([createTraceOperation()]);
    const markers: PipelineTraceMarker[] = [];
    const result = await executeStream(
      'weft.audit.trace',
      { value: 'ok' },
      {
        principal: anonymousPrincipal(),
        engine: {},
        transport: 'jsonRpcWebSocket',
        registry,
        pipelineTrace: (marker) => markers.push(marker),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fault.code).toBe('Unprocessable');
    expect(markers).toEqual(['looked-up']);
  });

  it('executeSubscription against a unary operation records only `looked-up` then fails Unprocessable', async () => {
    const registry = createOperationRegistry([createTraceOperation()]);
    const markers: PipelineTraceMarker[] = [];
    const result = await executeSubscription(
      'weft.audit.trace',
      { value: 'ok' },
      {
        principal: anonymousPrincipal(),
        engine: {},
        transport: 'jsonRpcWebSocket',
        registry,
        pipelineTrace: (marker) => markers.push(marker),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fault.code).toBe('Unprocessable');
    expect(markers).toEqual(['looked-up']);
  });
});

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
      const body = (await request.json()) as Record<string, unknown>;
      return { value: body['value'] };
    },
    success: { kind: 'json' as const, status: 200 },
  };
  const markers: PipelineTraceMarker[] = [];
  const engine = new Engine({ storage: new MemoryStorage() });

  return { handleRequest, engine, registry, traceBinding, markers };
}

function createTraceOperation() {
  return defineOperation({
    name: 'weft.audit.trace',
    mcpExposable: false,
    destructive: false,
    summary: 'Audit pipeline trace markers',
    inputSchema: z.object({ value: z.string() }),
    outputSchema: z.object({ echoed: z.string() }),
    access: { kind: 'public' },
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    invoke: async ({ input }) => ({ echoed: input.value }),
  });
}

async function skipParsingHandler(
  operation: ErasedOperation,
  context: DispatchContext & { pipelineTrace: PipelineTrace },
): Promise<void> {
  const trace = context.pipelineTrace;
  trace('looked-up');
  trace('transport-checked');
  trace('access-checked');
  trace('authorized');
  await operation.invoke({
    input: { value: 'direct' },
    principal: context.principal,
    engine: context.engine,
    transport: context.transport,
  });
  trace('invoked');
  trace('output-validated');
}
