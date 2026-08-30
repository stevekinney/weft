import { describe, expect, it } from 'bun:test';

import type { ActivityInterception } from '../core/interceptor';
import { createObservabilityInterceptors, extractTraceParent } from './index';
import type { OpenTelemetryApi, OpenTelemetrySpan, OpenTelemetryTracer } from './no-op-telemetry';

/**
 * Drive a generator to completion, pumping each yielded value back in.
 * Returns the generator's final return value.
 */
function driveGenerator<T>(gen: Generator<unknown, T, unknown>): T {
  let step = gen.next();
  while (!step.done) {
    step = gen.next(step.value);
  }
  return step.value;
}

// ---------------------------------------------------------------------------
// Recording tracer: captures span contexts for verifying trace propagation
// ---------------------------------------------------------------------------

type RecordedSpan = {
  name: string;
  attributes: Record<string, string | number | boolean>;
  parentContext?: unknown;
  ended: boolean;
  spanContext: { traceId: string; spanId: string; traceFlags: number };
};

function createRecordingTracer(): { tracer: OpenTelemetryTracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  let spanCounter = 0;

  const tracer: OpenTelemetryTracer = {
    startSpan(name: string, options?, _context?): OpenTelemetrySpan {
      const id = String(++spanCounter).padStart(16, '0');
      // If a parent context carries a span with a traceId, inherit it.
      // This mirrors real OTel behavior where child spans share the parent's traceId.
      const parentSpan = (_context as any)?.__span as OpenTelemetrySpan | undefined;
      const traceId = parentSpan ? parentSpan.spanContext().traceId : 'a'.repeat(32);
      const recorded: RecordedSpan = {
        name,
        attributes: { ...options?.attributes },
        parentContext: _context,
        ended: false,
        spanContext: { traceId, spanId: id, traceFlags: 1 },
      };
      spans.push(recorded);

      return {
        setAttribute(key: string, value: string | number | boolean) {
          recorded.attributes[key] = value;
        },
        setStatus() {},
        recordException() {},
        end() {
          recorded.ended = true;
        },
        spanContext() {
          return recorded.spanContext;
        },
      };
    },
  };

  return { tracer, spans };
}

function createMockOpenTelemetryApi(tracer: OpenTelemetryTracer): OpenTelemetryApi {
  return {
    trace: {
      getTracer() {
        return tracer;
      },
      setSpan(_context: unknown, span: OpenTelemetrySpan) {
        // Store the span on the context so the recording tracer can retrieve it.
        return { __span: span };
      },
    },
    metrics: {
      getMeter() {
        return {
          createHistogram() {
            return { record() {} };
          },
          createCounter() {
            return { add() {} };
          },
          createUpDownCounter() {
            return { add() {} };
          },
        };
      },
    },
    context: {
      ROOT_CONTEXT: Symbol('ROOT'),
      with<T>(_ctx: unknown, fn: () => T): T {
        return fn();
      },
    },
    SpanStatusCode: { OK: 1, ERROR: 2, UNSET: 0 },
  };
}

describe('remote worker trace propagation', () => {
  it('workflow activity hook injects traceparent that the activity interceptor extracts on the remote side', async () => {
    const { tracer: wfTracer } = createRecordingTracer();
    const { tracer: workerTracer, spans: workerSpans } = createRecordingTracer();

    const workflowSide = createObservabilityInterceptors({
      openTelemetryApi: createMockOpenTelemetryApi(wfTracer),
    });
    const workerSide = createObservabilityInterceptors({
      openTelemetryApi: createMockOpenTelemetryApi(workerTracer),
    });

    // 1. Establish the workflow's trace context via workflowStart.
    workflowSide.interceptor.workflowStart!(
      {
        workflowId: 'wf-remote-1',
        workflowType: 'OrderProcessing',
        input: { orderId: 42 },
        headers: new Map<string, string>(),
      },
      () => {},
    );

    // 2. Dispatch an activity — the workflow interceptor injects traceparent.
    const activityHeaders = new Map<string, string>();
    const activityInterception: ActivityInterception = {
      workflowId: 'wf-e2e-1',
      activityName: 'chargeCard',
      input: { amount: 99 },
      attempt: 1,
      headers: activityHeaders,
    };

    driveGenerator(
      workflowSide.interceptor.activity!(activityInterception, function* () {
        return 'dispatched';
      }),
    );

    // 3. Verify the workflow interceptor injected a valid traceparent.
    expect(activityHeaders.has('traceparent')).toBe(true);
    const injectedContext = extractTraceParent(activityHeaders);
    expect(injectedContext).not.toBeNull();
    expect(injectedContext!.traceId).toHaveLength(32);
    expect(injectedContext!.spanId).toHaveLength(16);

    // 4. Simulate the server serialization boundary: Map → Record → JSON → Record → Map.
    const serializedHeaders: Record<string, string> = Object.fromEntries(activityHeaders);
    const remoteHeaders = new Map<string, string>(Object.entries(serializedHeaders));

    // 5. Run the activity interceptor on the remote worker side.
    let activityExecuted = false;
    await workerSide.interceptor.execute!(
      {
        activityName: 'chargeCard',
        input: { amount: 99 },
        attempt: 1,
        operationId: 'op-remote-1',
        headers: remoteHeaders,
      },
      async () => {
        activityExecuted = true;
        return 'charged';
      },
    );

    expect(activityExecuted).toBe(true);

    // 6. Verify the remote worker created a span for the activity.
    const remoteSpan = workerSpans.find((s) => s.name.includes('chargeCard'));
    expect(remoteSpan).toBeDefined();
    expect(remoteSpan!.ended).toBe(true);

    // 7. Verify the remote span shares the workflow's traceId — the whole point
    //    of trace propagation. The injected traceparent carries the workflow's
    //    traceId, and the activity interceptor should parent the span under it.
    expect(remoteSpan!.spanContext.traceId).toBe(injectedContext!.traceId);
    expect(remoteSpan!.parentContext).toBeDefined();
  });

  it('round-trips through JSON serialization without losing trace context', async () => {
    const { tracer } = createRecordingTracer();
    const workflowSide = createObservabilityInterceptors({
      openTelemetryApi: createMockOpenTelemetryApi(tracer),
    });

    workflowSide.interceptor.workflowStart!(
      {
        workflowId: 'wf-json-rt',
        workflowType: 'TestWorkflow',
        input: undefined,
        headers: new Map<string, string>(),
      },
      () => {},
    );

    const headers = new Map<string, string>();
    driveGenerator(
      workflowSide.interceptor.activity!(
        { workflowId: 'wf-json-rt', activityName: 'process', input: 'data', attempt: 1, headers },
        function* () {
          return 'ok';
        },
      ),
    );

    // Full JSON round-trip, as the WebSocket transport does.
    const wirePayload = JSON.stringify({
      type: 'task',
      operationId: 'op-json-rt',
      activityName: 'process',
      input: 'data',
      attempt: 1,
      headers: Object.fromEntries(headers),
    });

    const parsed = JSON.parse(wirePayload);
    const reconstructedHeaders = new Map<string, string>(Object.entries(parsed.headers));

    // The traceparent must survive the round-trip intact.
    const traceContext = extractTraceParent(reconstructedHeaders);
    expect(traceContext).not.toBeNull();
    expect(traceContext!.traceId).toHaveLength(32);
    expect(traceContext!.spanId).toHaveLength(16);
    expect(traceContext!.traceFlags).toBe(1);
  });

  it('activity interceptor creates a span when no traceparent is present', async () => {
    const { tracer, spans } = createRecordingTracer();
    const { interceptor } = createObservabilityInterceptors({
      openTelemetryApi: createMockOpenTelemetryApi(tracer),
    });

    // Simulate a remote worker receiving a task with no headers.
    await interceptor.execute!(
      {
        activityName: 'standaloneTask',
        input: 'hello',
        attempt: 1,
        headers: new Map<string, string>(),
      },
      async () => 'done',
    );

    // A span should still be created even without parent trace context.
    const span = spans.find((s) => s.name.includes('standaloneTask'));
    expect(span).toBeDefined();
    expect(span!.ended).toBe(true);
  });

  it('multiple activities in the same workflow get distinct traceparent headers', () => {
    const { tracer } = createRecordingTracer();
    const workflowSide = createObservabilityInterceptors({
      openTelemetryApi: createMockOpenTelemetryApi(tracer),
    });

    workflowSide.interceptor.workflowStart!(
      {
        workflowId: 'wf-multi',
        workflowType: 'MultiStep',
        input: undefined,
        headers: new Map<string, string>(),
      },
      () => {},
    );

    // Dispatch two activities from the same workflow.
    const headers1 = new Map<string, string>();
    driveGenerator(
      workflowSide.interceptor.activity!(
        {
          workflowId: 'wf-multi',
          activityName: 'step1',
          input: 'a',
          attempt: 1,
          headers: headers1,
        },
        function* () {
          return 'r1';
        },
      ),
    );

    const headers2 = new Map<string, string>();
    driveGenerator(
      workflowSide.interceptor.activity!(
        {
          workflowId: 'wf-multi',
          activityName: 'step2',
          input: 'b',
          attempt: 1,
          headers: headers2,
        },
        function* () {
          return 'r2';
        },
      ),
    );

    // Both should carry valid traceparent headers.
    const ctx1 = extractTraceParent(headers1);
    const ctx2 = extractTraceParent(headers2);
    expect(ctx1).not.toBeNull();
    expect(ctx2).not.toBeNull();

    // Same traceId (same workflow), different spanIds (different activities).
    expect(ctx1!.traceId).toBe(ctx2!.traceId);
    expect(ctx1!.spanId).not.toBe(ctx2!.spanId);
  });
});
