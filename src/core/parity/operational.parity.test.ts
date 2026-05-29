import { describe, expect, it } from 'bun:test';

import { LocalClient } from '../../client/local.ts';
import {
  createObservabilityInterceptors,
  type OpenTelemetryApi,
  type OpenTelemetrySpan,
  type OpenTelemetryTracer,
} from '../../observability/index.ts';
import { TestEngine } from '../../testing/test-engine.ts';
import type { ActivityInterceptor, WorkflowInterceptor } from '../interceptor.ts';
import { activity, workflow, type WorkflowContext } from '../types.ts';

type RecordedSpan = {
  attributes: Record<string, boolean | number | string>;
  context: { spanId: string; traceFlags: number; traceId: string };
  ended: boolean;
  name: string;
  parentContext: unknown;
  status?: { code: number; message?: string };
};

function createRecordingTracer(): { spans: RecordedSpan[]; tracer: OpenTelemetryTracer } {
  const spans: RecordedSpan[] = [];

  const tracer: OpenTelemetryTracer = {
    startSpan(name, options, parentContext): OpenTelemetrySpan {
      const index = spans.length + 1;
      const span: RecordedSpan = {
        name,
        attributes: { ...options?.attributes },
        context: {
          traceId: index.toString(16).padStart(32, '0'),
          spanId: index.toString(16).padStart(16, '0'),
          traceFlags: 1,
        },
        ended: false,
        parentContext,
      };
      spans.push(span);

      return {
        end() {
          span.ended = true;
        },
        recordException() {},
        setAttribute(key, value) {
          span.attributes[key] = value;
        },
        setStatus(status) {
          span.status = status;
        },
        spanContext() {
          return span.context;
        },
      };
    },
  };

  return { spans, tracer };
}

function createMockOpenTelemetryApi(tracer: OpenTelemetryTracer): OpenTelemetryApi {
  return {
    SpanStatusCode: { ERROR: 2, OK: 1, UNSET: 0 },
    context: {
      ROOT_CONTEXT: { root: true },
      with(_context, run) {
        return run();
      },
    },
    metrics: {
      getMeter() {
        return {
          createCounter() {
            return { add() {} };
          },
          createHistogram() {
            return { record() {} };
          },
          createUpDownCounter() {
            return { add() {} };
          },
        };
      },
    },
    trace: {
      getTracer() {
        return tracer;
      },
      setSpan(context, span) {
        return { context, spanContext: span.spanContext() };
      },
    },
  };
}

function findSpan(spans: RecordedSpan[], name: string): RecordedSpan {
  const span = spans.find((candidate) => candidate.name === name);
  if (!span) {
    throw new Error(`Expected span "${name}" to be recorded`);
  }
  return span;
}

function findLastSpan(spans: RecordedSpan[], name: string): RecordedSpan {
  const span = spans.findLast((candidate) => candidate.name === name);
  if (!span) {
    throw new Error(`Expected span "${name}" to be recorded`);
  }
  return span;
}

describe('operational parity', () => {
  it('indexes workflow-owned search attributes and filters list results by exact attribute match', async () => {
    await using engine = new TestEngine();
    const client = new LocalClient(engine);

    engine.register(
      workflow({ name: 'parity-index-order' })
        .searchAttributes({
          customerId: { type: 'string' },
          region: { type: 'string' },
        })
        .execute(async function* (context: WorkflowContext, input: { customerId: string }) {
          context.setAttribute('customerId', input.customerId);
          context.setAttribute('region', 'us-west');
          yield* context.waitForSignal('release');
          return input.customerId;
        }),
    );

    await client.start(
      'parity-index-order',
      { customerId: 'customer-a' },
      { id: 'parity-order-a' },
    );
    await client.start(
      'parity-index-order',
      { customerId: 'customer-b' },
      { id: 'parity-order-b' },
    );
    await engine.advanceTime(0);

    const result = await client.list({
      attributes: [
        { key: 'customerId', value: 'customer-a' },
        { key: 'region', value: 'us-west' },
      ],
    });

    expect(result.items.map((item) => item.id)).toEqual(['parity-order-a']);
  });

  it('drives schedule create, pause, resume, and cancel through the client with virtual time', async () => {
    await using engine = new TestEngine({ startTime: Date.UTC(2026, 0, 1, 0, 0, 0) });
    const client = new LocalClient(engine);
    const firedInputs: string[] = [];

    engine.register(
      workflow({ name: 'parity-scheduled-job' }).execute(async function* (
        _context: WorkflowContext,
        input: string,
      ) {
        firedInputs.push(input);
        return input;
      }),
    );

    const schedule = await client.schedule('parity-scheduled-job', 'nightly', '* * * * * *', {
      id: 'parity-schedule',
    });

    await engine.advanceTime('1 second');
    expect(firedInputs).toEqual(['nightly']);

    await schedule.pause();
    await engine.advanceTime('1 second');
    expect(firedInputs).toEqual(['nightly']);

    await schedule.resume();
    await engine.advanceTime('1 second');
    expect(firedInputs).toEqual(['nightly', 'nightly']);

    await schedule.cancel();
    await engine.advanceTime('1 second');
    expect(firedInputs).toEqual(['nightly', 'nightly']);
    expect(await client.getSchedule('parity-schedule')).toMatchObject({
      id: 'parity-schedule',
      nextFireAt: null,
      status: 'cancelled',
    });
  });

  it('runs workflow and activity interceptors around activity, sleep, and signal operations', async () => {
    await using engine = new TestEngine({ startTime: 0 });
    const events: string[] = [];

    async function addOne(input: number): Promise<number> {
      return input + 1;
    }

    const workflowInterceptor: WorkflowInterceptor = {
      *activity(interception, next) {
        events.push(
          `workflow-activity:before:${interception.activityName}:${String(interception.input)}`,
        );
        const result = yield* next(interception);
        events.push(`workflow-activity:after:${interception.activityName}:${String(result)}`);
        return result;
      },
      signalReceived(interception, next) {
        events.push(`signal-received:${interception.signalName}:${String(interception.payload)}`);
        next(interception);
      },
      *sleep(interception, next) {
        events.push(`sleep:before:${interception.duration}`);
        yield* next(interception);
        events.push(`sleep:after:${interception.duration}`);
      },
      *waitForSignal(interception, next) {
        events.push(`wait-for-signal:before:${interception.signalName}`);
        const result = yield* next(interception);
        events.push(`wait-for-signal:after:${interception.signalName}:${String(result)}`);
        return result;
      },
      workflowStart(interception, next) {
        const input = interception.input as { value: number };
        events.push(`workflow-start:${interception.workflowType}:${input.value}`);
        next(interception);
      },
    };

    const activityInterceptor: ActivityInterceptor = {
      async execute(interception, next) {
        events.push(
          `activity-execute:before:${interception.activityName}:${String(interception.input)}`,
        );
        const result = await next(interception);
        events.push(`activity-execute:after:${interception.activityName}:${String(result)}`);
        return result;
      },
    };

    engine.addInterceptor(workflowInterceptor);
    engine.addInterceptor(activityInterceptor);
    engine.register(
      workflow({ name: 'parity-intercepted-workflow' }).execute(async function* (
        context: WorkflowContext,
        input: { value: number },
      ) {
        const activityResult = yield* context.run(addOne, input.value);
        yield* context.sleep('1 second');
        const approval = yield* context.waitForSignal<string>('approval');
        return `${activityResult}:${approval}`;
      }),
    );

    const handle = await engine.start('parity-intercepted-workflow', { value: 3 });
    await engine.advanceTime('1 second');
    await engine.signal(handle.id, 'approval', 'approved');

    await expect(handle.result()).resolves.toBe('4:approved');
    expect(events).toEqual([
      'workflow-start:parity-intercepted-workflow:3',
      'workflow-activity:before:addOne:3',
      'activity-execute:before:addOne:3',
      'activity-execute:after:addOne:4',
      'workflow-activity:after:addOne:4',
      'sleep:before:1000',
      'sleep:after:1000',
      'wait-for-signal:before:approval',
      'signal-received:approval:approved',
      'wait-for-signal:before:approval',
      'wait-for-signal:after:approval:approved',
    ]);
  });

  it('keeps interceptor state correct across inline recovery and cached replay', async () => {
    const events: string[] = [];
    let activityExecutions = 0;

    async function addOne(input: number): Promise<number> {
      activityExecutions += 1;
      return input + 1;
    }

    const workflowInterceptor: WorkflowInterceptor = {
      signalReceived(interception, next) {
        events.push(`signal-received:${interception.signalName}:${String(interception.payload)}`);
        next(interception);
      },
      *sleep(interception, next) {
        events.push(`sleep:before:${interception.duration}`);
        yield* next(interception);
        events.push(`sleep:after:${interception.duration}`);
      },
      *waitForSignal(interception, next) {
        events.push(`wait-for-signal:before:${interception.signalName}`);
        const result = yield* next(interception);
        events.push(`wait-for-signal:after:${interception.signalName}:${String(result)}`);
        return result;
      },
    };

    const recoveredWorkflow = workflow({ name: 'parity-recovered-interceptors' }).execute(
      async function* (context: WorkflowContext, input: number) {
        const activityResult = yield* context.run(addOne, input);
        yield* context.sleep('1 second');
        const approval = yield* context.waitForSignal<string>('approval');
        return `${activityResult}:${approval}`;
      },
    );

    const firstEngine = new TestEngine({ startTime: 0 });
    firstEngine.addInterceptor(workflowInterceptor);
    firstEngine.register(recoveredWorkflow);
    const handle = await firstEngine.start('parity-recovered-interceptors', 3, {
      id: 'parity-recovered-interceptors-id',
    });
    await firstEngine.advanceTime(0);

    const recoveredEngine = firstEngine.recover();
    firstEngine[Symbol.dispose]();
    recoveredEngine.addInterceptor(workflowInterceptor);
    recoveredEngine.register(recoveredWorkflow);
    const recoveredHandles = await recoveredEngine.recoverAll();
    expect(recoveredHandles.map((recoveredHandle) => recoveredHandle.id)).toEqual([handle.id]);

    await recoveredEngine.advanceTime('1 second');
    await recoveredEngine.signal(handle.id, 'approval', 'approved');

    await expect(recoveredHandles[0]!.result()).resolves.toBe('4:approved');
    expect(activityExecutions).toBe(1);
    expect(events.filter((event) => event === 'sleep:after:1000')).toHaveLength(1);
    expect(events).toContain('signal-received:approval:approved');
    expect(
      events.filter((event) => event === 'wait-for-signal:after:approval:approved'),
    ).toHaveLength(1);

    recoveredEngine[Symbol.dispose]();
  });

  it('does not rerun waitForSignal interceptors when a cached signal result replays', async () => {
    const events: string[] = [];

    const workflowInterceptor: WorkflowInterceptor = {
      *waitForSignal(interception, next) {
        events.push(`wait-for-signal:before:${interception.signalName}`);
        const result = yield* next(interception);
        events.push(`wait-for-signal:after:${interception.signalName}:${String(result)}`);
        return result;
      },
    };

    const cachedSignalWorkflow = workflow({ name: 'parity-cached-signal-interceptor' }).execute(
      async function* (context: WorkflowContext) {
        const approval = yield* context.waitForSignal<string>('approval');
        yield* context.sleep('1 hour');
        return approval;
      },
    );

    const firstEngine = new TestEngine({ startTime: 0 });
    firstEngine.addInterceptor(workflowInterceptor);
    firstEngine.register(cachedSignalWorkflow);
    const handle = await firstEngine.start('parity-cached-signal-interceptor', null, {
      id: 'parity-cached-signal-interceptor-id',
    });
    await firstEngine.advanceTime(0);
    await firstEngine.signal(handle.id, 'approval', 'approved');
    await firstEngine.advanceTime(0);

    expect(
      events.filter((event) => event === 'wait-for-signal:after:approval:approved'),
    ).toHaveLength(1);

    const eventsBeforeRecovery = events.length;
    const recoveredEngine = firstEngine.recover();
    firstEngine[Symbol.dispose]();
    recoveredEngine.addInterceptor(workflowInterceptor);
    recoveredEngine.register(cachedSignalWorkflow);
    const recoveredHandles = await recoveredEngine.recoverAll();
    expect(recoveredHandles.map((recoveredHandle) => recoveredHandle.id)).toEqual([handle.id]);
    expect(events).toHaveLength(eventsBeforeRecovery);

    await recoveredEngine.advanceTime('1 hour');
    await expect(recoveredHandles[0]!.result()).resolves.toBe('approved');
    expect(events).toHaveLength(eventsBeforeRecovery);

    recoveredEngine[Symbol.dispose]();
  });

  it('emits OpenTelemetry spans for activity, sleep, and signal paths with W3C trace propagation', async () => {
    await using engine = new TestEngine({ startTime: 0 });
    const { spans, tracer } = createRecordingTracer();
    const { dispose, interceptor } = createObservabilityInterceptors({
      eventTarget: engine,
      openTelemetryApi: createMockOpenTelemetryApi(tracer),
    });

    const multiply = activity({
      name: 'multiplyForParity',
      execute: async (input: number) => input * 2,
    });

    engine.addInterceptor(interceptor);
    engine.register(multiply);
    engine.register(
      workflow({ name: 'parity-observed-workflow' }).execute(async function* (
        context: WorkflowContext,
        input: number,
      ) {
        const activityResult = yield* context.run(multiply, input);
        yield* context.sleep('1 second');
        const signalPayload = yield* context.waitForSignal<string>('finish');
        return `${activityResult}:${signalPayload}`;
      }),
    );

    const handle = await engine.start('parity-observed-workflow', 5);
    await engine.advanceTime('1 second');
    await engine.signal(handle.id, 'finish', 'done');
    await expect(handle.result()).resolves.toBe('10:done');
    dispose();

    const workflowSpan = findSpan(spans, 'workflow:parity-observed-workflow');
    const workflowActivitySpan = findSpan(spans, 'activity:multiplyForParity');
    const activityExecutionSpan = findSpan(spans, 'activity:execute:multiplyForParity');
    const sleepSpan = findSpan(spans, 'sleep');
    const waitForSignalSpan = findLastSpan(spans, 'waitForSignal');
    const signalReceivedSpan = findSpan(spans, 'signal:received:finish');

    expect(workflowSpan.ended).toBe(true);
    expect(workflowActivitySpan.parentContext).toEqual({
      context: { root: true },
      spanContext: workflowSpan.context,
    });
    expect(sleepSpan.parentContext).toEqual({
      context: { root: true },
      spanContext: workflowSpan.context,
    });
    expect(waitForSignalSpan.parentContext).toEqual({
      context: { root: true },
      spanContext: workflowSpan.context,
    });
    expect(activityExecutionSpan.parentContext).toEqual({
      context: { root: true },
      spanContext: workflowActivitySpan.context,
    });
    expect(activityExecutionSpan.attributes['weft.parent.trace_id']).toBe(
      workflowActivitySpan.context.traceId,
    );
    expect(signalReceivedSpan.attributes['weft.signal.name']).toBe('finish');
    for (const span of [
      workflowActivitySpan,
      activityExecutionSpan,
      sleepSpan,
      waitForSignalSpan,
    ]) {
      expect(span.status?.code).toBe(1);
      expect(span.ended).toBe(true);
    }
  });
});
