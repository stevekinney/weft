import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { TransportKind } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import { anonymousPrincipal } from '../principal.ts';
import { DISPATCH_ALLOWLIST } from './dispatch-allowlist.ts';
import { executeOperation } from './pipeline.ts';
import { createOperationRegistry } from './registry.ts';
import { executeStream, executeSubscription } from './stream-pipeline.ts';
import type { DispatchContext, PipelineTrace, PipelineTraceMarker } from './types.ts';

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

async function* streamFixtureIterable() {
  yield { chunk: 'a' };
}

function emptyAsyncIterable<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: true as const, value: undefined }),
    }),
  };
}

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
    const markers: PipelineTraceMarker[] = [];

    await skipParsingHandler(operation, {
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
      invoke: async () => streamFixtureIterable(),
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
      eventSchema: z.unknown(),
      access: { kind: 'public' },
      transports: { http: false, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async () => ({
        envelope: { subscriptionId: 's', cursor: 'c' },
        iterable: emptyAsyncIterable(),
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

describe('operation dispatch audit — executeSubscription envelope typing', () => {
  // Regression guard: executeSubscription<Element, Envelope> must stay
  // generic over the operation's declared envelope shape. A prior revision
  // narrowed the return type to the canonical JSON-RPC session envelope
  // ({ subscriptionId, cursor }), which is false for a catalog subscription
  // whose outputSchema declares a different shape — this operation deliberately
  // omits `cursor` to prove the envelope type genuinely follows the operation's
  // own outputSchema/Envelope type argument rather than a hardcoded shape.
  it('returns exactly the operation-declared envelope shape, without a cursor field the schema never declared', async () => {
    const subscriptionIdOnlyOperation = defineOperation({
      name: 'weft.audit.subscriptiononly',
      mcpExposable: false,
      destructive: false,
      summary: 'Subscription operation whose envelope has no cursor field',
      kind: 'subscription',
      inputSchema: z.object({}),
      outputSchema: z.object({ subscriptionId: z.string() }),
      eventSchema: z.object({ value: z.number() }),
      access: { kind: 'public' },
      transports: { http: false, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async () => ({
        envelope: { subscriptionId: 'sub-1' },
        iterable: (async function* () {
          yield { value: 1 };
        })(),
        close: async () => {},
      }),
    });
    const registry = createOperationRegistry([subscriptionIdOnlyOperation]);

    const result = await executeSubscription(
      'weft.audit.subscriptiononly',
      {},
      {
        principal: anonymousPrincipal(),
        engine: {},
        transport: 'jsonRpcWebSocket',
        registry,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.envelope).toEqual({ subscriptionId: 'sub-1' });
    // The runtime envelope has no `cursor` key at all — asserting this
    // directly, rather than only checking the TypeScript type, is what
    // catches a return-type narrowing that lies about a field's presence.
    expect(
      result.value.envelope !== null &&
        typeof result.value.envelope === 'object' &&
        Object.hasOwn(result.value.envelope, 'cursor'),
    ).toBe(false);
  });
});

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
  operation: ReturnType<typeof createTraceOperation>,
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
