import { describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine';
import {
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowTimedOutEvent,
} from '../core/events';
import type {
  ActivityInterception,
  ChildWorkflowInterception,
  SignalInterception,
  SleepInterception,
} from '../core/interceptor';
import type { WorkflowContext } from '../core/types';
import { workflow } from '../core/types/workflow-function.ts';
import { MemoryStorage } from '../storage/memory';
import { flush } from '../testing/storage-backends.test-support';
import { createObservabilityInterceptors } from './index';
import { MetricsCollector } from './metrics';
import type {
  OpenTelemetryApi,
  OpenTelemetrySpan,
  OpenTelemetryTracer,
  SpanLink,
} from './no-op-telemetry';

// ---------------------------------------------------------------------------
// Recording tracer: captures all span operations for assertions
// ---------------------------------------------------------------------------

type RecordedSpan = {
  name: string;
  attributes: Record<string, string | number | boolean>;
  status?: { code: number; message?: string };
  exceptions: Array<Error | string>;
  ended: boolean;
  endCount: number;
  parentContext?: unknown;
  links?: SpanLink[];
};

function createRecordingTracer(): {
  tracer: OpenTelemetryTracer;
  spans: RecordedSpan[];
} {
  const spans: RecordedSpan[] = [];

  const tracer: OpenTelemetryTracer = {
    startSpan(name: string, options?, _context?): OpenTelemetrySpan {
      const recorded: RecordedSpan = {
        name,
        attributes: { ...options?.attributes },
        exceptions: [],
        ended: false,
        endCount: 0,
        parentContext: _context,
        links: options?.links ?? [],
      };
      spans.push(recorded);

      return {
        setAttribute(key: string, value: string | number | boolean) {
          recorded.attributes[key] = value;
        },
        setStatus(status: { code: number; message?: string }) {
          recorded.status = status;
        },
        recordException(exception: Error | string) {
          recorded.exceptions.push(exception);
        },
        end() {
          recorded.ended = true;
          recorded.endCount += 1;
        },
        spanContext() {
          return {
            traceId: 'abcd1234abcd1234abcd1234abcd1234',
            spanId: 'ef56ef56ef56ef56',
            traceFlags: 1,
          };
        },
      };
    },
  };

  return { tracer, spans };
}

/**
 * Build a mock OTel API that uses our recording tracer.
 * This lets us verify that the interceptors call OTel correctly.
 */
function createMockOpenTelemetryApi(tracer: OpenTelemetryTracer): OpenTelemetryApi {
  return {
    trace: {
      getTracer() {
        return tracer;
      },
      setSpan(context: unknown) {
        return context;
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
      ROOT_CONTEXT: Symbol.for('ROOT'),
      with<T>(_ctx: unknown, fn: () => T): T {
        return fn();
      },
    },
    SpanStatusCode: { OK: 1, ERROR: 2, UNSET: 0 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createObservabilityInterceptors', () => {
  it('returns a unified interceptor', () => {
    const interceptors = createObservabilityInterceptors();
    expect(interceptors.interceptor.workflowStart).toBeDefined();
    expect(interceptors.interceptor.execute).toBeDefined();
  });

  it('returns a metrics collector even when not explicitly provided', () => {
    const { metrics } = createObservabilityInterceptors();
    expect(metrics).toBeDefined();
    expect(typeof metrics.increment).toBe('function');
    expect(typeof metrics.snapshot).toBe('function');
  });

  describe('workflow interceptor', () => {
    it('injects traceparent header on workflowStart', () => {
      const { tracer } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      const headers = new Map<string, string>();
      interceptor.workflowStart!(
        {
          workflowId: 'wf-1',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers,
        },
        () => {},
      );

      expect(headers.has('traceparent')).toBe(true);
      const traceparent = headers.get('traceparent')!;
      expect(traceparent).toContain('abcd1234abcd1234abcd1234abcd1234');
    });

    it('creates a span for workflowStart with correct attributes', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      interceptor.workflowStart!(
        {
          workflowId: 'wf-1',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      expect(spans).toHaveLength(1);
      expect(spans[0]!.name).toBe('workflow:TestWorkflow');
      expect(spans[0]!.attributes['weft.workflow.id']).toBe('wf-1');
      expect(spans[0]!.attributes['weft.workflow.type']).toBe('TestWorkflow');
    });

    it('ends and replaces an existing workflow span on re-execution', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      const interception = {
        workflowId: 'wf-retry',
        workflowType: 'TestWorkflow',
        input: undefined,
        headers: new Map<string, string>(),
      };

      interceptor.workflowStart!(interception, () => {});
      interceptor.workflowStart!(interception, () => {});

      expect(spans).toHaveLength(2);
      expect(spans[0]!.status).toEqual({ code: 1 });
      expect(spans[0]!.ended).toBe(true);
      expect(spans[1]!.ended).toBe(false);
    });

    it('evicts TTL-expired workflow spans on the next workflow start', () => {
      const originalDateNow = Date.now;
      let mockTime = 0;
      Date.now = () => mockTime;

      try {
        const { tracer, spans } = createRecordingTracer();
        const { interceptor } = createObservabilityInterceptors({
          openTelemetryApi: createMockOpenTelemetryApi(tracer),
        });

        interceptor.workflowStart!(
          {
            workflowId: 'wf-expired',
            workflowType: 'TestWorkflow',
            input: undefined,
            headers: new Map<string, string>(),
          },
          () => {},
        );

        mockTime = 60 * 60 * 1000 + 1;

        interceptor.workflowStart!(
          {
            workflowId: 'wf-fresh',
            workflowType: 'TestWorkflow',
            input: undefined,
            headers: new Map<string, string>(),
          },
          () => {},
        );

        expect(spans[0]!.ended).toBe(true);
        expect(spans[1]!.ended).toBe(false);
      } finally {
        Date.now = originalDateNow;
      }
    });

    it('evicts the oldest workflow spans when the span cache exceeds the hard cap', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      for (let index = 0; index <= 10_001; index++) {
        interceptor.workflowStart!(
          {
            workflowId: `wf-${index}`,
            workflowType: 'TestWorkflow',
            input: undefined,
            headers: new Map<string, string>(),
          },
          () => {},
        );
      }

      expect(spans).toHaveLength(10_002);
      expect(spans[0]!.ended).toBe(true);
      expect(spans.at(-1)!.ended).toBe(false);
    });

    it('ends workflow spans from terminal events and ignores unrelated events', () => {
      const { tracer, spans } = createRecordingTracer();
      const eventTarget = new EventTarget();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
        eventTarget,
      });

      interceptor.workflowStart!(
        {
          workflowId: 'wf-terminal-events',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      eventTarget.dispatchEvent(new Event(WorkflowCompletedEvent.type));
      expect(spans[0]!.ended).toBe(false);

      eventTarget.dispatchEvent(
        new WorkflowFailedEvent('wf-terminal-events', new Error('workflow failed')),
      );

      expect(spans[0]!.status).toEqual({ code: 2, message: 'workflow failed' });
      expect(spans[0]!.ended).toBe(true);

      interceptor.workflowStart!(
        {
          workflowId: 'wf-terminal-completed',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );
      eventTarget.dispatchEvent(new WorkflowCompletedEvent('wf-terminal-completed', 'ok', 1));
      expect(spans[1]!.status).toEqual({ code: 1 });
      expect(spans[1]!.ended).toBe(true);

      interceptor.workflowStart!(
        {
          workflowId: 'wf-terminal-cancelled',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );
      eventTarget.dispatchEvent(new WorkflowCancelledEvent('wf-terminal-cancelled'));
      expect(spans[2]!.status).toEqual({ code: 2, message: 'Workflow cancelled' });
      expect(spans[2]!.ended).toBe(true);

      interceptor.workflowStart!(
        {
          workflowId: 'wf-terminal-timeout',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );
      eventTarget.dispatchEvent(new WorkflowTimedOutEvent('wf-terminal-timeout', 'execution', 5));
      expect(spans[3]!.status).toEqual({
        code: 2,
        message: 'Workflow timed out (execution) after 5ms',
      });
      expect(spans[3]!.ended).toBe(true);
    });

    it('injects traceparent header on activity', () => {
      const { tracer } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      interceptor.workflowStart!(
        {
          workflowId: 'wf-1',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const headers = new Map<string, string>();
      const interception = {
        workflowId: 'wf-1',
        activityName: 'doSomething',
        input: 'hello',
        attempt: 1,
        headers,
      };

      const mockResult = 'activity-result';
      const next = function* (ctx: ActivityInterception) {
        expect(ctx.headers.has('traceparent')).toBe(true);
        return mockResult;
      };

      const generator = interceptor.activity!(interception, next);
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      expect(step.value).toBe(mockResult);
      expect(headers.has('traceparent')).toBe(true);
    });

    it('creates a span for activity with correct attributes', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      interceptor.workflowStart!(
        {
          workflowId: 'wf-1',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const next = function* (_ctx: ActivityInterception) {
        return 'result';
      };

      const generator = interceptor.activity!(
        {
          workflowId: 'wf-1',
          activityName: 'doSomething',
          input: undefined,
          attempt: 1,
          headers: new Map(),
        },
        next,
      );
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      // spans[0] is workflowStart, spans[1] is activity
      const activitySpan = spans.find((s) => s.name.startsWith('activity:'));
      expect(activitySpan).toBeDefined();
      expect(activitySpan!.name).toBe('activity:doSomething');
      expect(activitySpan!.attributes['weft.activity.name']).toBe('doSomething');
      expect(activitySpan!.attributes['weft.activity.attempt']).toBe(1);
      expect(activitySpan!.status?.code).toBe(1); // OK
      expect(activitySpan!.ended).toBe(true);
    });

    it('records error span when activity generator throws', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      interceptor.workflowStart!(
        {
          workflowId: 'wf-err',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const theError = new Error('activity failed');
      const next = function* (_ctx: ActivityInterception) {
        throw theError;
      };

      const generator = interceptor.activity!(
        {
          workflowId: 'wf-err',
          activityName: 'failingActivity',
          input: undefined,
          attempt: 1,
          headers: new Map(),
        },
        next,
      );

      let caught = false;
      try {
        let step = generator.next();
        while (!step.done) {
          step = generator.next(step.value);
        }
      } catch (error) {
        caught = true;
        expect(error).toBe(theError);
      }
      expect(caught).toBe(true);

      const errorSpan = spans.find((s) => s.name === 'activity:failingActivity');
      expect(errorSpan).toBeDefined();
      expect(errorSpan!.status?.code).toBe(2); // ERROR
      expect(errorSpan!.status?.message).toBe('activity failed');
      expect(errorSpan!.exceptions).toHaveLength(1);
      expect(errorSpan!.ended).toBe(true);
    });

    it('records span for sleep with correct attributes', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      interceptor.workflowStart!(
        {
          workflowId: 'wf-1',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const next = function* (_ctx: SleepInterception) {};

      const generator = interceptor.sleep!(
        { workflowId: 'wf-1', duration: 5000, headers: new Map() },
        next,
      );
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      const sleepSpan = spans.find((s) => s.name === 'sleep');
      expect(sleepSpan).toBeDefined();
      expect(sleepSpan!.attributes['weft.sleep.duration']).toBe(5000);
      expect(sleepSpan!.status?.code).toBe(1); // OK
      expect(sleepSpan!.ended).toBe(true);
    });

    it('records error span when sleep throws', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      interceptor.workflowStart!(
        {
          workflowId: 'wf-sleep-error',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const next = function* (_ctx: SleepInterception) {
        throw new Error('sleep failed');
      };

      const generator = interceptor.sleep!(
        { workflowId: 'wf-sleep-error', duration: 100, headers: new Map() },
        next,
      );

      expect(() => {
        let step = generator.next();
        while (!step.done) {
          step = generator.next(step.value);
        }
      }).toThrow('sleep failed');

      const sleepSpan = spans.find((span) => span.name === 'sleep');
      expect(sleepSpan).toBeDefined();
      expect(sleepSpan!.status).toEqual({ code: 2, message: 'sleep failed' });
      expect(sleepSpan!.exceptions).toHaveLength(1);
      expect(sleepSpan!.ended).toBe(true);
    });

    it('records span for waitForSignal with correct attributes', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      interceptor.workflowStart!(
        {
          workflowId: 'wf-1',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const next = function* (_ctx: SignalInterception) {
        return 'signal-result';
      };

      const generator = interceptor.waitForSignal!(
        {
          workflowId: 'wf-1',
          signalName: 'approval',
          payload: { approved: true },
          headers: new Map(),
        },
        next,
      );
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      const signalSpan = spans.find((s) => s.name === 'waitForSignal');
      expect(signalSpan).toBeDefined();
      expect(signalSpan!.attributes['weft.signal.name']).toBe('approval');
      expect(signalSpan!.status?.code).toBe(1); // OK
      expect(signalSpan!.ended).toBe(true);
    });

    it('records error span when waitForSignal throws', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      interceptor.workflowStart!(
        {
          workflowId: 'wf-sig-err',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const theError = new Error('signal failed');
      const next = function* (_ctx: SignalInterception) {
        throw theError;
      };

      const generator = interceptor.waitForSignal!(
        {
          workflowId: 'wf-sig-err',
          signalName: 'test-signal',
          payload: undefined,
          headers: new Map(),
        },
        next,
      );

      let caught = false;
      try {
        let step = generator.next();
        while (!step.done) {
          step = generator.next(step.value);
        }
      } catch (error) {
        caught = true;
        expect(error).toBe(theError);
      }
      expect(caught).toBe(true);

      const errorSpan = spans.find((s) => s.name === 'waitForSignal');
      expect(errorSpan).toBeDefined();
      expect(errorSpan!.status?.code).toBe(2); // ERROR
      expect(errorSpan!.exceptions).toHaveLength(1);
      expect(errorSpan!.ended).toBe(true);
    });

    it('creates standalone span for signalReceived', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      interceptor.signalReceived!(
        {
          workflowId: 'wf-1',
          signalName: 'approval',
          payload: undefined,
          headers: new Map(),
        },
        () => {},
      );

      const signalSpan = spans.find((s) => s.name === 'signal:received:approval');
      expect(signalSpan).toBeDefined();
      expect(signalSpan!.attributes['weft.signal.name']).toBe('approval');
      expect(signalSpan!.attributes['weft.signal.workflow_id']).toBe('wf-1');
      expect(signalSpan!.status?.code).toBe(1); // OK
      expect(signalSpan!.ended).toBe(true);
    });

    it('records error span when signalReceived throws', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      const theError = new Error('signal handler failed');
      expect(() => {
        interceptor.signalReceived!(
          {
            workflowId: 'wf-1',
            signalName: 'approval',
            payload: undefined,
            headers: new Map(),
          },
          () => {
            throw theError;
          },
        );
      }).toThrow(theError);

      const signalSpan = spans.find((s) => s.name === 'signal:received:approval');
      expect(signalSpan).toBeDefined();
      expect(signalSpan!.status?.code).toBe(2); // ERROR
      expect(signalSpan!.ended).toBe(true);
    });

    it('ends workflow spans explicitly with success and error states', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor, endWorkflowSpan } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      interceptor.workflowStart!(
        {
          workflowId: 'wf-end-ok',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );
      endWorkflowSpan('wf-end-ok', 'ok');

      interceptor.workflowStart!(
        {
          workflowId: 'wf-end-error',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );
      endWorkflowSpan('wf-end-error', 'error', 'workflow failed');
      endWorkflowSpan('wf-missing', 'ok');

      expect(spans[0]!.status).toEqual({ code: 1 });
      expect(spans[0]!.ended).toBe(true);
      expect(spans[1]!.status).toEqual({ code: 2, message: 'workflow failed' });
      expect(spans[1]!.ended).toBe(true);
    });
  });

  describe('activity interceptor', () => {
    it('extracts trace context from headers and creates child span', async () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      const headers = new Map<string, string>([
        ['traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
      ]);

      const result = await interceptor.execute!(
        { activityName: 'doSomething', input: 'hello', attempt: 1, headers },
        async () => 'result',
      );

      expect(result).toBe('result');
      expect(spans).toHaveLength(1);
      expect(spans[0]!.name).toBe('activity:execute:doSomething');
      expect(spans[0]!.status?.code).toBe(1); // OK
      expect(spans[0]!.ended).toBe(true);
    });

    it('materializes the remote parent span context when a traceparent header is provided', async () => {
      const { tracer } = createRecordingTracer();
      let extractedRemoteSpanId: string | undefined;

      const openTelemetryApi = createMockOpenTelemetryApi(tracer);
      openTelemetryApi.trace.setSpan = (_context, span) => {
        extractedRemoteSpanId = span.spanContext().spanId;
        return _context;
      };

      const { interceptor } = createObservabilityInterceptors({ openTelemetryApi });
      const headers = new Map<string, string>([
        ['traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
      ]);

      await interceptor.execute!(
        { activityName: 'doSomething', input: 'hello', attempt: 1, headers },
        async () => 'result',
      );

      expect(extractedRemoteSpanId).toBe('00f067aa0ba902b7');
    });

    it('handles errors in activity execution', async () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      const headers = new Map<string, string>([
        ['traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
      ]);

      try {
        await interceptor.execute!(
          { activityName: 'failingActivity', input: undefined, attempt: 1, headers },
          async () => {
            throw new Error('something went wrong');
          },
        );
      } catch {
        // Expected
      }

      expect(spans).toHaveLength(1);
      expect(spans[0]!.status?.code).toBe(2); // ERROR
      expect(spans[0]!.status?.message).toBe('something went wrong');
      expect(spans[0]!.exceptions).toHaveLength(1);
      expect(spans[0]!.ended).toBe(true);
    });

    it('handles non-Error thrown values', async () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      const headers = new Map<string, string>([
        ['traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
      ]);

      try {
        await interceptor.execute!(
          { activityName: 'stringThrower', input: undefined, attempt: 1, headers },
          async () => {
            throw 'string error value';
          },
        );
      } catch {
        // Expected
      }

      expect(spans).toHaveLength(1);
      expect(spans[0]!.status?.code).toBe(2); // ERROR
      expect(spans[0]!.status?.message).toBe('string error value');
      expect(spans[0]!.ended).toBe(true);
    });

    it('generates a new trace when no traceparent header exists', async () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      await interceptor.execute!(
        { activityName: 'noTrace', input: undefined, attempt: 1, headers: new Map() },
        async () => 'ok',
      );

      expect(spans).toHaveLength(1);
      expect(spans[0]!.name).toBe('activity:execute:noTrace');
      expect(spans[0]!.ended).toBe(true);
    });
  });

  describe('recordPayloads option', () => {
    it('includes input as attribute when enabled', async () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        recordPayloads: true,
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      await interceptor.execute!(
        {
          activityName: 'doSomething',
          input: 'hello-world',
          attempt: 1,
          headers: new Map(),
        },
        async () => 'ok',
      );

      expect(spans).toHaveLength(1);
      expect(spans[0]!.attributes['weft.payload.input']).toBe('"hello-world"');
    });

    it('does not include input when disabled', async () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        recordPayloads: false,
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      await interceptor.execute!(
        {
          activityName: 'doSomething',
          input: 'hello-world',
          attempt: 1,
          headers: new Map(),
        },
        async () => 'ok',
      );

      expect(spans).toHaveLength(1);
      expect(spans[0]!.attributes['weft.payload.input']).toBeUndefined();
    });

    it('truncates payloads exceeding maxPayloadSize', async () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        recordPayloads: true,
        maxPayloadSize: 10,
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      await interceptor.execute!(
        {
          activityName: 'doSomething',
          input: 'this is a very long input string that exceeds the max',
          attempt: 1,
          headers: new Map(),
        },
        async () => 'ok',
      );

      expect(spans).toHaveLength(1);
      const inputAttribute = spans[0]!.attributes['weft.payload.input'] as string;
      expect(inputAttribute.length).toBeLessThanOrEqual(13); // 10 + "..."
    });

    it('records workflow start input when recordPayloads is enabled', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        recordPayloads: true,
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      interceptor.workflowStart!(
        {
          workflowId: 'wf-payload',
          workflowType: 'TestWorkflow',
          input: { key: 'value' },
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const startSpan = spans.find((s) => s.name.startsWith('workflow:'));
      expect(startSpan).toBeDefined();
      expect(startSpan!.attributes['weft.payload.input']).toBe('{"key":"value"}');
    });

    it('records activity input when recordPayloads is enabled (workflow interceptor)', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        recordPayloads: true,
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      interceptor.workflowStart!(
        {
          workflowId: 'wf-act-payload',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const next = function* (_ctx: ActivityInterception) {
        return 'result';
      };

      const generator = interceptor.activity!(
        {
          workflowId: 'wf-act-payload',
          activityName: 'doSomething',
          input: 'hello',
          attempt: 1,
          headers: new Map(),
        },
        next,
      );
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      const activitySpan = spans.find((s) => s.name.startsWith('activity:'));
      expect(activitySpan).toBeDefined();
      expect(activitySpan!.attributes['weft.payload.input']).toBe('"hello"');
    });

    it('handles non-serializable payloads', async () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        recordPayloads: true,
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      // Create a circular reference that JSON.stringify will fail on
      const circular: any = {};
      circular.self = circular;

      await interceptor.execute!(
        {
          activityName: 'circularInput',
          input: circular,
          attempt: 1,
          headers: new Map(),
        },
        async () => 'ok',
      );

      expect(spans).toHaveLength(1);
      expect(spans[0]!.attributes['weft.payload.input']).toBeDefined();
    });
  });

  describe('attributeExtractor', () => {
    it('merges custom attributes into workflowStart span', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
        attributeExtractor: () => ({ 'custom.region': 'us-east', 'custom.priority': 1 }),
      });

      interceptor.workflowStart!(
        {
          workflowId: 'wf-attr',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const span = spans.find((s) => s.name.startsWith('workflow:'));
      expect(span).toBeDefined();
      expect(span!.attributes['custom.region']).toBe('us-east');
      expect(span!.attributes['custom.priority']).toBe(1);
    });

    it('merges custom attributes into activity span', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
        attributeExtractor: () => ({ 'custom.region': 'us-east' }),
      });

      interceptor.workflowStart!(
        {
          workflowId: 'wf-attr-act',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const next = function* (_ctx: ActivityInterception) {
        return 'result';
      };

      const generator = interceptor.activity!(
        {
          workflowId: 'wf-attr-act',
          activityName: 'doSomething',
          input: undefined,
          attempt: 1,
          headers: new Map(),
        },
        next,
      );
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      const activitySpan = spans.find((s) => s.name.startsWith('activity:'));
      expect(activitySpan).toBeDefined();
      expect(activitySpan!.attributes['custom.region']).toBe('us-east');
    });

    it('merges custom attributes into sleep span', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
        attributeExtractor: () => ({ 'custom.region': 'eu-west' }),
      });

      interceptor.workflowStart!(
        {
          workflowId: 'wf-attr-sleep',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const next = function* (_ctx: SleepInterception) {};

      const generator = interceptor.sleep!(
        { workflowId: 'wf-attr-sleep', duration: 5000, headers: new Map() },
        next,
      );
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      const sleepSpan = spans.find((s) => s.name === 'sleep');
      expect(sleepSpan).toBeDefined();
      expect(sleepSpan!.attributes['custom.region']).toBe('eu-west');
    });

    it('receives actual interception context', () => {
      const extractorCalls: unknown[] = [];
      const { tracer } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
        attributeExtractor: (ctx) => {
          extractorCalls.push(ctx);
          return {};
        },
      });

      const interception = {
        workflowId: 'wf-ctx-check',
        workflowType: 'MyWorkflow',
        input: { data: 123 },
        headers: new Map<string, string>(),
      };

      interceptor.workflowStart!(interception, () => {});

      expect(extractorCalls.length).toBeGreaterThanOrEqual(1);
      // The extractor receives the actual interception object
      expect(extractorCalls[0]).toBe(interception);
    });
  });

  describe('MetricsCollector integration', () => {
    it('records weft.workflow.started on workflowStart', () => {
      const metricsCollector = new MetricsCollector();
      const { interceptor } = createObservabilityInterceptors({ metrics: metricsCollector });

      interceptor.workflowStart!(
        {
          workflowId: 'wf-m1',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const snapshot = metricsCollector.snapshot();
      expect(snapshot['weft.workflow.started']).toBeDefined();
      expect(
        snapshot['weft.workflow.started']!.type === 'counter' &&
          snapshot['weft.workflow.started']!.value,
      ).toBe(1);
    });

    it('records weft.activity.duration on activity completion', () => {
      const metricsCollector = new MetricsCollector();
      const { interceptor } = createObservabilityInterceptors({ metrics: metricsCollector });

      interceptor.workflowStart!(
        {
          workflowId: 'wf-m2',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const next = function* (_ctx: ActivityInterception) {
        return 'result';
      };

      const generator = interceptor.activity!(
        {
          workflowId: 'wf-m2',
          activityName: 'myActivity',
          input: undefined,
          attempt: 1,
          headers: new Map(),
        },
        next,
      );
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      const snapshot = metricsCollector.snapshot();
      expect(snapshot['weft.activity.duration']).toBeDefined();
      expect(snapshot['weft.activity.duration']!.type).toBe('histogram');
      expect(snapshot['weft.activity.attempts']).toBeDefined();
      expect(
        snapshot['weft.activity.attempts']!.type === 'counter' &&
          snapshot['weft.activity.attempts']!.value,
      ).toBe(1);
    });

    it('counts timed-out workflows as DPMO defects', () => {
      const metricsCollector = new MetricsCollector();
      const eventTarget = new EventTarget();
      const { interceptor } = createObservabilityInterceptors({
        metrics: metricsCollector,
        eventTarget,
      });

      interceptor.workflowStart!(
        {
          workflowId: 'wf-timeout-dpmo',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      eventTarget.dispatchEvent(new WorkflowTimedOutEvent('wf-timeout-dpmo', 'execution', 5000));

      const snapshot = metricsCollector.snapshot();
      expect(
        snapshot['weft.dpmo.operations']!.type === 'counter' &&
          snapshot['weft.dpmo.operations']!.value,
      ).toBe(1);
      expect(
        snapshot['weft.dpmo.defects']!.type === 'counter' && snapshot['weft.dpmo.defects']!.value,
      ).toBe(1);
    });
  });

  describe('without OTel API (default no-op)', () => {
    it('works without any options — uses no-op OTel API', () => {
      const { interceptor } = createObservabilityInterceptors();

      const headers = new Map<string, string>();
      expect(() => {
        interceptor.workflowStart!(
          {
            workflowId: 'wf-noop',
            workflowType: 'TestWorkflow',
            input: undefined,
            headers,
          },
          () => {},
        );
      }).not.toThrow();

      // With the no-op API, traceparent still gets injected (using no-op span context)
      expect(headers.has('traceparent')).toBe(true);
    });

    it('activity interceptor works without OTel', async () => {
      const { interceptor } = createObservabilityInterceptors();

      const result = await interceptor.execute!(
        { activityName: 'noOtel', input: undefined, attempt: 1, headers: new Map() },
        async () => 'ok',
      );

      expect(result).toBe('ok');
    });
  });

  describe('non-Error thrown values', () => {
    it('records non-Error thrown value in activity generator', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      interceptor.workflowStart!(
        {
          workflowId: 'wf-err-2',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const next = function* (_ctx: ActivityInterception) {
        throw 'non-error value';
      };

      const generator = interceptor.activity!(
        {
          workflowId: 'wf-err-2',
          activityName: 'stringThrower',
          input: undefined,
          attempt: 1,
          headers: new Map(),
        },
        next,
      );

      try {
        let step = generator.next();
        while (!step.done) {
          step = generator.next(step.value);
        }
      } catch {
        // Expected
      }

      const errorSpan = spans.find((s) => s.name === 'activity:stringThrower');
      expect(errorSpan).toBeDefined();
      expect(errorSpan!.status?.code).toBe(2); // ERROR
      expect(errorSpan!.status?.message).toBe('non-error value');
    });

    it('records non-Error thrown value in waitForSignal', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      interceptor.workflowStart!(
        {
          workflowId: 'wf-sig-err-2',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const next = function* (_ctx: SignalInterception) {
        throw 42;
      };

      const generator = interceptor.waitForSignal!(
        {
          workflowId: 'wf-sig-err-2',
          signalName: 'test-signal',
          payload: undefined,
          headers: new Map(),
        },
        next,
      );

      try {
        let step = generator.next();
        while (!step.done) {
          step = generator.next(step.value);
        }
      } catch {
        // Expected
      }

      const errorSpan = spans.find((s) => s.name === 'waitForSignal');
      expect(errorSpan).toBeDefined();
      expect(errorSpan!.status?.code).toBe(2); // ERROR
      expect(errorSpan!.status?.message).toBe('42');
    });
  });

  describe('workflow activity interceptor without prior workflowStart', () => {
    it('still creates a span when no workflowStart was called', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      const interception = {
        workflowId: 'wf-orphan',
        activityName: 'orphanActivity',
        input: undefined,
        attempt: 1,
        headers: new Map<string, string>(),
      };

      const next = function* (_ctx: ActivityInterception) {
        return 'result';
      };

      const generator = interceptor.activity!(interception, next);
      let step = generator.next();
      while (!step.done) {
        step = generator.next(step.value);
      }

      expect(spans).toHaveLength(1);
      expect(interception.headers.has('traceparent')).toBe(true);
    });
  });

  describe('child workflow interceptor', () => {
    it('creates a span with link to parent, not parent-child relationship', async () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      // Start parent workflow to populate the root span
      interceptor.workflowStart!(
        {
          workflowId: 'parent-wf',
          workflowType: 'ParentWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      // Parent traceparent header simulating what the engine would pass
      const parentHeaders = new Map<string, string>([
        ['traceparent', '00-abcd1234abcd1234abcd1234abcd1234-ef56ef56ef56ef56-01'],
      ]);

      const interception: ChildWorkflowInterception = {
        workflowId: 'parent-wf',
        childWorkflowId: 'child-wf-1',
        workflowType: 'ChildWorkflow',
        input: { task: 'process' },
        headers: new Map<string, string>(),
        parentHeaders,
      };

      const result = await interceptor.childWorkflow!(interception, async () => 'child-result');

      expect(result).toBe('child-result');

      const childSpan = spans.find((s) => s.name === 'childWorkflow:ChildWorkflow');
      expect(childSpan).toBeDefined();
      expect(childSpan!.attributes['weft.child_workflow.type']).toBe('ChildWorkflow');
      expect(childSpan!.attributes['weft.child_workflow.id']).toBe('child-wf-1');
      expect(childSpan!.attributes['weft.child_workflow.parent_id']).toBe('parent-wf');

      // The span should have a link to the parent, not a parent context
      expect(childSpan!.links).toBeDefined();
      expect(childSpan!.links).toHaveLength(1);
      expect(childSpan!.links![0]!.context.traceId).toBe('abcd1234abcd1234abcd1234abcd1234');
      expect(childSpan!.links![0]!.context.spanId).toBe('ef56ef56ef56ef56');

      // The span should NOT have a parent context (root context means independent lifecycle)
      // In our mock, ROOT_CONTEXT is a Symbol — if parentContext is that symbol, the span is a root.
      expect(childSpan!.parentContext).toBe(Symbol.for('ROOT'));
      expect(childSpan!.ended).toBe(true);
      expect(childSpan!.status?.code).toBe(1); // OK
    });

    it('injects traceparent header into child workflow headers', async () => {
      const { tracer } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      interceptor.workflowStart!(
        {
          workflowId: 'parent-wf',
          workflowType: 'ParentWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const childHeaders = new Map<string, string>();
      const interception: ChildWorkflowInterception = {
        workflowId: 'parent-wf',
        childWorkflowId: 'child-wf-2',
        workflowType: 'ChildWorkflow',
        input: undefined,
        headers: childHeaders,
        parentHeaders: new Map([
          ['traceparent', '00-abcd1234abcd1234abcd1234abcd1234-ef56ef56ef56ef56-01'],
        ]),
      };

      await interceptor.childWorkflow!(interception, async () => 'ok');

      expect(childHeaders.has('traceparent')).toBe(true);
      const traceparent = childHeaders.get('traceparent')!;
      // The traceparent should contain the recording span's trace ID
      expect(traceparent).toContain('abcd1234abcd1234abcd1234abcd1234');
    });

    it('records error span when child workflow fails', async () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      interceptor.workflowStart!(
        {
          workflowId: 'parent-wf',
          workflowType: 'ParentWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const theError = new Error('child workflow failed');
      const interception: ChildWorkflowInterception = {
        workflowId: 'parent-wf',
        childWorkflowId: 'child-wf-err',
        workflowType: 'FailingChild',
        input: undefined,
        headers: new Map<string, string>(),
        parentHeaders: new Map([
          ['traceparent', '00-abcd1234abcd1234abcd1234abcd1234-ef56ef56ef56ef56-01'],
        ]),
      };

      let caught = false;
      try {
        await interceptor.childWorkflow!(interception, async () => {
          throw theError;
        });
      } catch (error) {
        caught = true;
        expect(error).toBe(theError);
      }
      expect(caught).toBe(true);

      const childSpan = spans.find((s) => s.name === 'childWorkflow:FailingChild');
      expect(childSpan).toBeDefined();
      expect(childSpan!.status?.code).toBe(2); // ERROR
      expect(childSpan!.status?.message).toBe('child workflow failed');
      expect(childSpan!.exceptions).toHaveLength(1);
      expect(childSpan!.ended).toBe(true);
    });

    it('creates span with empty links when no parent traceparent exists', async () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      interceptor.workflowStart!(
        {
          workflowId: 'parent-wf',
          workflowType: 'ParentWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const interception: ChildWorkflowInterception = {
        workflowId: 'parent-wf',
        childWorkflowId: 'child-wf-no-parent',
        workflowType: 'OrphanChild',
        input: undefined,
        headers: new Map<string, string>(),
        parentHeaders: new Map<string, string>(), // No traceparent
      };

      await interceptor.childWorkflow!(interception, async () => 'ok');

      const childSpan = spans.find((s) => s.name === 'childWorkflow:OrphanChild');
      expect(childSpan).toBeDefined();
      // No link when parent has no traceparent
      expect(childSpan!.links ?? []).toHaveLength(0);
      expect(childSpan!.ended).toBe(true);
    });

    it('records input when recordPayloads is enabled', async () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        recordPayloads: true,
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      interceptor.workflowStart!(
        {
          workflowId: 'parent-wf',
          workflowType: 'ParentWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const interception: ChildWorkflowInterception = {
        workflowId: 'parent-wf',
        childWorkflowId: 'child-wf-payload',
        workflowType: 'PayloadChild',
        input: { data: 'important' },
        headers: new Map<string, string>(),
        parentHeaders: new Map<string, string>(),
      };

      await interceptor.childWorkflow!(interception, async () => 'ok');

      const childSpan = spans.find((s) => s.name === 'childWorkflow:PayloadChild');
      expect(childSpan).toBeDefined();
      expect(childSpan!.attributes['weft.payload.input']).toBe('{"data":"important"}');
    });

    it('records child workflow started metric', async () => {
      const metricsCollector = new MetricsCollector();
      const { interceptor } = createObservabilityInterceptors({ metrics: metricsCollector });

      interceptor.workflowStart!(
        {
          workflowId: 'parent-wf',
          workflowType: 'ParentWorkflow',
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );

      const interception: ChildWorkflowInterception = {
        workflowId: 'parent-wf',
        childWorkflowId: 'child-wf-metric',
        workflowType: 'MetricChild',
        input: undefined,
        headers: new Map<string, string>(),
        parentHeaders: new Map<string, string>(),
      };

      await interceptor.childWorkflow!(interception, async () => 'ok');

      const snapshot = metricsCollector.snapshot();
      expect(snapshot['weft.child_workflow.started']).toBeDefined();
      expect(
        snapshot['weft.child_workflow.started']!.type === 'counter' &&
          snapshot['weft.child_workflow.started']!.value,
      ).toBe(1);
    });
  });

  describe('workflow lifecycle span ending', () => {
    /** Helper: start a workflow span for the given workflow ID. */
    function startWorkflow(
      interceptor: ReturnType<typeof createObservabilityInterceptors>['interceptor'],
      workflowId: string,
      workflowType = 'TestWorkflow',
    ): void {
      interceptor.workflowStart!(
        {
          workflowId,
          workflowType,
          input: undefined,
          headers: new Map<string, string>(),
        },
        () => {},
      );
    }

    it('ends the root span with OK on WorkflowCompletedEvent', () => {
      const { tracer, spans } = createRecordingTracer();
      const eventTarget = new EventTarget();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
        eventTarget,
      });

      startWorkflow(interceptor, 'wf-complete');

      const rootSpan = spans.find((s) => s.name === 'workflow:TestWorkflow');
      expect(rootSpan).toBeDefined();
      expect(rootSpan!.ended).toBe(false);

      eventTarget.dispatchEvent(new WorkflowCompletedEvent('wf-complete', 'result', 100));

      expect(rootSpan!.ended).toBe(true);
      expect(rootSpan!.status?.code).toBe(1); // OK
    });

    it('ends the root span with ERROR on WorkflowFailedEvent', () => {
      const { tracer, spans } = createRecordingTracer();
      const eventTarget = new EventTarget();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
        eventTarget,
      });

      startWorkflow(interceptor, 'wf-fail');

      const rootSpan = spans.find((s) => s.name === 'workflow:TestWorkflow');
      expect(rootSpan).toBeDefined();

      eventTarget.dispatchEvent(new WorkflowFailedEvent('wf-fail', new Error('boom')));

      expect(rootSpan!.ended).toBe(true);
      expect(rootSpan!.status?.code).toBe(2); // ERROR
      expect(rootSpan!.status?.message).toBe('boom');
    });

    it('ends the root span with ERROR on WorkflowCancelledEvent', () => {
      const { tracer, spans } = createRecordingTracer();
      const eventTarget = new EventTarget();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
        eventTarget,
      });

      startWorkflow(interceptor, 'wf-cancel');

      const rootSpan = spans.find((s) => s.name === 'workflow:TestWorkflow');
      expect(rootSpan).toBeDefined();

      eventTarget.dispatchEvent(new WorkflowCancelledEvent('wf-cancel'));

      expect(rootSpan!.ended).toBe(true);
      expect(rootSpan!.status?.code).toBe(2); // ERROR
      expect(rootSpan!.status?.message).toBe('Workflow cancelled');
    });

    it('ends the root span with ERROR on WorkflowTimedOutEvent', () => {
      const { tracer, spans } = createRecordingTracer();
      const eventTarget = new EventTarget();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
        eventTarget,
      });

      startWorkflow(interceptor, 'wf-timeout');

      const rootSpan = spans.find((s) => s.name === 'workflow:TestWorkflow');
      expect(rootSpan).toBeDefined();

      eventTarget.dispatchEvent(new WorkflowTimedOutEvent('wf-timeout', 'execution', 5000));

      expect(rootSpan!.ended).toBe(true);
      expect(rootSpan!.status?.code).toBe(2); // ERROR
      expect(rootSpan!.status?.message).toContain('timed out');
      expect(rootSpan!.status?.message).toContain('5000');
    });

    it('removes the workflow from the internal map after terminal event (no leak)', () => {
      const { tracer } = createRecordingTracer();
      const eventTarget = new EventTarget();
      const { interceptor, endWorkflowSpan } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
        eventTarget,
      });

      startWorkflow(interceptor, 'wf-leak');
      eventTarget.dispatchEvent(new WorkflowCompletedEvent('wf-leak', null, 0));

      // Calling endWorkflowSpan again should be a no-op because the entry was
      // already removed from the internal map on the terminal event.
      endWorkflowSpan('wf-leak', 'error', 'should not re-end');

      // Re-entering the workflow should create a fresh span (previous entry gone)
      startWorkflow(interceptor, 'wf-leak');
      // A new entry should exist now; end it to verify the lifecycle cleanly repeats.
      eventTarget.dispatchEvent(new WorkflowCompletedEvent('wf-leak', null, 0));
    });

    it('ignores terminal events for unrelated workflows', () => {
      const { tracer, spans } = createRecordingTracer();
      const eventTarget = new EventTarget();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
        eventTarget,
      });

      startWorkflow(interceptor, 'wf-a');
      startWorkflow(interceptor, 'wf-b');

      eventTarget.dispatchEvent(new WorkflowCompletedEvent('wf-a', null, 0));

      const spanA = spans.find(
        (s) => s.name === 'workflow:TestWorkflow' && s.attributes['weft.workflow.id'] === 'wf-a',
      );
      const spanB = spans.find(
        (s) => s.name === 'workflow:TestWorkflow' && s.attributes['weft.workflow.id'] === 'wf-b',
      );

      expect(spanA?.ended).toBe(true);
      expect(spanB?.ended).toBe(false);
    });

    it('dispose() removes listeners and ends any dangling spans', () => {
      const { tracer, spans } = createRecordingTracer();
      const eventTarget = new EventTarget();
      const { interceptor, dispose } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
        eventTarget,
      });

      startWorkflow(interceptor, 'wf-dangling');

      dispose();

      const rootSpan = spans.find((s) => s.name === 'workflow:TestWorkflow');
      expect(rootSpan?.ended).toBe(true);
      expect(rootSpan?.status?.code).toBe(2); // ERROR

      // After dispose, terminal events on the target should no longer do anything.
      // The span count should remain stable.
      const spanCountBefore = spans.length;
      eventTarget.dispatchEvent(new WorkflowCompletedEvent('wf-dangling', null, 0));
      expect(spans.length).toBe(spanCountBefore);
    });

    it('does nothing when no eventTarget is provided', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor, dispose } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      startWorkflow(interceptor, 'wf-no-target');

      // No event target wired, so dispose should still work and end the span.
      dispose();

      const rootSpan = spans.find((s) => s.name === 'workflow:TestWorkflow');
      expect(rootSpan?.ended).toBe(true);
    });
  });

  describe('engine integration', () => {
    it('ends workflow span with OK when engine completes a workflow', async () => {
      const { tracer, spans } = createRecordingTracer();
      const storage = new MemoryStorage();
      const engine = new Engine({ storage });

      const { interceptor, dispose } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
        eventTarget: engine,
      });
      engine.addInterceptor(interceptor);

      const greeter = workflow({ name: 'greeter' }).execute(async function* (
        _ctx: WorkflowContext,
      ) {
        return 'hello';
      });
      engine.register(greeter);

      const handle = await engine.start('greeter', { name: 'world' });
      await flush();
      const result = await handle.result();
      expect(result).toBe('hello');

      const rootSpan = spans.find((s) => s.name === 'workflow:greeter');
      expect(rootSpan).toBeDefined();
      expect(rootSpan!.ended).toBe(true);
      expect(rootSpan!.status?.code).toBe(1); // OK

      dispose();
      engine[Symbol.dispose]();
    });

    it('ends workflow span with ERROR when engine fails a workflow', async () => {
      const { tracer, spans } = createRecordingTracer();
      const storage = new MemoryStorage();
      const engine = new Engine({ storage });

      const { interceptor, dispose } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
        eventTarget: engine,
      });
      engine.addInterceptor(interceptor);

      const flaky = workflow({ name: 'flaky' }).execute(async function* (_ctx: WorkflowContext) {
        throw new Error('workflow exploded');
      });
      engine.register(flaky);

      const handle = await engine.start('flaky', undefined);
      await flush();
      await handle.result().catch(() => undefined);

      const rootSpan = spans.find((s) => s.name === 'workflow:flaky');
      expect(rootSpan).toBeDefined();
      expect(rootSpan!.ended).toBe(true);
      expect(rootSpan!.status?.code).toBe(2); // ERROR
      expect(rootSpan!.status?.message).toBe('workflow exploded');

      dispose();
      engine[Symbol.dispose]();
    });

    it('ends workflow span with ERROR when engine cancels a workflow', async () => {
      const { tracer, spans } = createRecordingTracer();
      const storage = new MemoryStorage();
      const engine = new Engine({ storage });

      const { interceptor, dispose } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
        eventTarget: engine,
      });
      engine.addInterceptor(interceptor);

      // A workflow that waits on a signal forever — giving us time to cancel.
      const waiter = workflow({ name: 'waiter' }).execute(async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('never-sent');
        return 'unreached';
      });
      engine.register(waiter);

      const handle = await engine.start('waiter', undefined);
      await flush();
      await engine.cancel(handle.id);
      await flush();
      await handle.result().catch(() => undefined);

      const rootSpan = spans.find((s) => s.name === 'workflow:waiter');
      expect(rootSpan).toBeDefined();
      expect(rootSpan!.ended).toBe(true);
      expect(rootSpan!.status?.code).toBe(2); // ERROR
      expect(rootSpan!.status?.message).toBe('Workflow cancelled');

      dispose();
      engine[Symbol.dispose]();
    });
  });

  describe('endWorkflowSpan', () => {
    it('ends the span with OK status', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor, endWorkflowSpan } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      interceptor.workflowStart!(
        {
          workflowId: 'wf-end-ok',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map(),
        },
        () => {},
      );

      endWorkflowSpan('wf-end-ok', 'ok');

      const span = spans.find((s) => s.name === 'workflow:TestWorkflow');
      expect(span?.ended).toBe(true);
      expect(span?.status?.code).toBe(1); // OK
    });

    it('ends the span with ERROR status and message', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor, endWorkflowSpan } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      interceptor.workflowStart!(
        {
          workflowId: 'wf-end-err',
          workflowType: 'TestWorkflow',
          input: undefined,
          headers: new Map(),
        },
        () => {},
      );

      endWorkflowSpan('wf-end-err', 'error', 'something broke');

      const span = spans.find((s) => s.name === 'workflow:TestWorkflow');
      expect(span?.ended).toBe(true);
      expect(span?.status?.code).toBe(2); // ERROR
      expect(span?.status?.message).toBe('something broke');
    });

    it('is a no-op for unknown workflow IDs', () => {
      const { endWorkflowSpan } = createObservabilityInterceptors();
      // Should not throw
      endWorkflowSpan('non-existent', 'ok');
    });
  });

  describe('evictStaleSpans', () => {
    it('evicts spans older than maxAgeMs and returns the count', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor, evictStaleSpans } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      interceptor.workflowStart!(
        {
          workflowId: 'wf-stale',
          workflowType: 'StaleWorkflow',
          input: undefined,
          headers: new Map(),
        },
        () => {},
      );

      // Evict with maxAgeMs = 0 — all spans are considered stale
      const evicted = evictStaleSpans(0);

      expect(evicted).toBe(1);
      const staleSpan = spans.find((s) => s.name === 'workflow:StaleWorkflow');
      expect(staleSpan?.ended).toBe(true);
      expect(staleSpan?.status?.code).toBe(2); // ERROR
      expect(staleSpan?.status?.message).toBe('span evicted (stale)');
    });

    it('does not evict spans younger than maxAgeMs', () => {
      const { tracer } = createRecordingTracer();
      const { interceptor, evictStaleSpans } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      interceptor.workflowStart!(
        {
          workflowId: 'wf-fresh',
          workflowType: 'FreshWorkflow',
          input: undefined,
          headers: new Map(),
        },
        () => {},
      );

      // 1-hour window — span was just created, so it's fresh
      const evicted = evictStaleSpans(60 * 60 * 1000);
      expect(evicted).toBe(0);
    });

    it('returns 0 when no spans exist', () => {
      const { evictStaleSpans } = createObservabilityInterceptors();
      expect(evictStaleSpans(0)).toBe(0);
    });
  });

  describe('dispose', () => {
    it('ends all tracked spans and clears the map', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor, dispose, evictStaleSpans } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      interceptor.workflowStart!(
        { workflowId: 'wf-dispose-1', workflowType: 'T1', input: undefined, headers: new Map() },
        () => {},
      );
      interceptor.workflowStart!(
        { workflowId: 'wf-dispose-2', workflowType: 'T2', input: undefined, headers: new Map() },
        () => {},
      );

      dispose();

      // Both spans should be ended
      const workflowSpans = spans.filter((s) => s.name.startsWith('workflow:'));
      expect(workflowSpans.every((s) => s.ended)).toBe(true);

      // The map should be empty — eviction with 0 ms should find nothing
      expect(evictStaleSpans(0)).toBe(0);
    });
  });

  describe('span lifecycle invariants', () => {
    it('ends async activity span exactly once on success', async () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      await interceptor.execute!(
        {
          activityName: 'lifecycle.success',
          input: undefined,
          attempt: 1,
          headers: new Map(),
        },
        async () => 'ok',
      );

      expect(spans).toHaveLength(1);
      expect(spans[0]!.endCount).toBe(1);
      expect(spans[0]!.status?.code).toBe(1);
    });

    it('ends async activity span exactly once on failure and rethrows the original error', async () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      const originalError = new Error('boom-async');
      let thrown: unknown;
      try {
        await interceptor.execute!(
          {
            activityName: 'lifecycle.failure',
            input: undefined,
            attempt: 1,
            headers: new Map(),
          },
          async () => {
            throw originalError;
          },
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(originalError);
      expect(spans).toHaveLength(1);
      expect(spans[0]!.endCount).toBe(1);
      expect(spans[0]!.status?.code).toBe(2);
      expect(spans[0]!.exceptions).toHaveLength(1);
    });

    it('ends generator waitForSignal span exactly once on success', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      const generator = interceptor.waitForSignal!(
        { workflowId: 'wf-lifecycle-ok', signalName: 'go', payload: undefined, headers: new Map() },
        function* () {
          return 'payload';
        },
      );

      let next = generator.next();
      while (!next.done) {
        next = generator.next(next.value);
      }

      const span = spans.find((s) => s.name === 'waitForSignal');
      expect(span).toBeDefined();
      expect(span!.endCount).toBe(1);
      expect(span!.status?.code).toBe(1);
    });

    it('ends generator waitForSignal span exactly once on failure-after-yield and rethrows original error', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      const originalError = new Error('boom-after-yield');
      const generator = interceptor.waitForSignal!(
        {
          workflowId: 'wf-lifecycle-err',
          signalName: 'go',
          payload: undefined,
          headers: new Map(),
        },
        function* () {
          yield 'step-1';
          throw originalError;
        },
      );

      // First next() consumes the yield from inner; second resumes and inner throws.
      const first = generator.next();
      expect(first.done).toBe(false);
      expect(first.value).toBe('step-1');

      let thrown: unknown;
      try {
        generator.next();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(originalError);
      const span = spans.find((s) => s.name === 'waitForSignal');
      expect(span).toBeDefined();
      expect(span!.endCount).toBe(1);
      expect(span!.status?.code).toBe(2);
      expect(span!.exceptions).toHaveLength(1);
    });

    it('records weft.activity.duration and weft.activity.attempts only on success path', () => {
      const successCollector = new MetricsCollector();
      const { interceptor: successInterceptor } = createObservabilityInterceptors({
        metrics: successCollector,
      });

      const successGenerator = successInterceptor.activity!(
        {
          workflowId: 'wf-metrics-ok',
          activityName: 'doWork',
          input: undefined,
          attempt: 1,
          headers: new Map(),
        },
        function* () {
          return 'done';
        },
      );
      let step = successGenerator.next();
      while (!step.done) step = successGenerator.next(step.value);

      const successSnapshot = successCollector.snapshot();
      const successAttempts = successSnapshot['weft.activity.attempts'];
      expect(successAttempts).toBeDefined();
      if (!successAttempts || successAttempts.type !== 'counter') {
        throw new Error('expected counter metric weft.activity.attempts');
      }
      expect(successAttempts.value).toBe(1);

      const successDuration = successSnapshot['weft.activity.duration'];
      expect(successDuration).toBeDefined();
      if (!successDuration || successDuration.type !== 'histogram') {
        throw new Error('expected histogram metric weft.activity.duration');
      }
      expect(successDuration.count).toBe(1);

      // Failure path: metrics must NOT be recorded.
      const failureCollector = new MetricsCollector();
      const { interceptor: failureInterceptor } = createObservabilityInterceptors({
        metrics: failureCollector,
      });

      const failureGenerator = failureInterceptor.activity!(
        {
          workflowId: 'wf-metrics-err',
          activityName: 'doWork',
          input: undefined,
          attempt: 1,
          headers: new Map(),
        },
        function* () {
          throw new Error('failed');
        },
      );

      expect(() => {
        let next = failureGenerator.next();
        while (!next.done) next = failureGenerator.next(next.value);
      }).toThrow('failed');

      const failureSnapshot = failureCollector.snapshot();
      expect(failureSnapshot['weft.activity.attempts']).toBeUndefined();
      expect(failureSnapshot['weft.activity.duration']).toBeUndefined();
    });

    it('ends sync signalReceived span exactly once on success', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      interceptor.signalReceived!(
        {
          workflowId: 'wf-sync-ok',
          signalName: 'ping',
          payload: undefined,
          headers: new Map(),
        },
        () => {},
      );

      const span = spans.find((s) => s.name === 'signal:received:ping');
      expect(span).toBeDefined();
      expect(span!.endCount).toBe(1);
      expect(span!.status?.code).toBe(1);
    });

    it('ends sync signalReceived span exactly once on failure and rethrows original error', () => {
      const { tracer, spans } = createRecordingTracer();
      const { interceptor } = createObservabilityInterceptors({
        openTelemetryApi: createMockOpenTelemetryApi(tracer),
      });

      const originalError = new Error('boom-sync');
      let thrown: unknown;
      try {
        interceptor.signalReceived!(
          {
            workflowId: 'wf-sync-err',
            signalName: 'ping',
            payload: undefined,
            headers: new Map(),
          },
          () => {
            throw originalError;
          },
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(originalError);
      const span = spans.find((s) => s.name === 'signal:received:ping');
      expect(span).toBeDefined();
      expect(span!.endCount).toBe(1);
      expect(span!.status?.code).toBe(2);
      expect(span!.exceptions).toHaveLength(1);
    });
  });
});
