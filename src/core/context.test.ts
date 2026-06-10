import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

import {
  Context,
  type ContextOperationRequest,
  type OffloadReference,
  type StreamReference,
  type StreamSink,
} from './context.ts';
import { BranchTopologyChangedError } from './context/parallel-operations.ts';
import {
  MAX_SESSION_STATE_SERIALIZED_BYTES,
  SessionStateValidationError,
} from './session-state.ts';
import type { SearchAttributeValue, WorkflowContext } from './types.ts';

function createContext(overrides: Partial<ConstructorParameters<typeof Context>[0]> = {}) {
  return new Context({
    workflowId: 'wf-test-123',
    workflowType: 'test-workflow',
    startedAt: 1000,
    abortController: new AbortController(),
    ...overrides,
  });
}

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

// Helper functions used as activity stubs (at module scope to satisfy consistent-function-scoping)
function greet(input: unknown) {
  return `Hello, ${String(input)}!`;
}

function sendEmail(input: unknown) {
  return `Sent to ${String(input)}`;
}

function taskA() {
  return 'a';
}

function taskB() {
  return 'b';
}

function task() {
  return 'result';
}

const handler = (payload: unknown) => payload;
const accessor = () => 42;

/** Narrow a yielded ContextOperationRequest by its type discriminant. */
function expectRequest<T extends ContextOperationRequest['type']>(
  yielded: IteratorResult<ContextOperationRequest, unknown>,
  expectedType: T,
): Extract<ContextOperationRequest, { type: T }> {
  expect(yielded.done).toBe(false);
  const request = yielded.value as ContextOperationRequest;
  expect(request.type).toBe(expectedType);
  return request as Extract<ContextOperationRequest, { type: T }>;
}

describe('Context', () => {
  describe('ctx.onCancel', () => {
    it('throws when cancellation hooks are not available for the execution mode', () => {
      const context = createContext();

      expect(() => context.onCancel(() => {})).toThrow(
        'ctx.onCancel() is only supported for inline workflow execution',
      );
    });

    it('registers a cancellation handler when supported by the engine', () => {
      const handlers: Array<() => Promise<void> | void> = [];
      const context = createContext({
        registerCancelHandler: (cancelHandler) => {
          handlers.push(cancelHandler);
          return () => {};
        },
      });
      const cancellationHandler = () => {};

      context.onCancel(cancellationHandler);

      expect(handlers).toEqual([cancellationHandler]);
    });
  });

  describe('ctx.run', () => {
    it('yields an activity request', () => {
      const context = createContext();

      const generator = context.run(greet, 'Alice');
      const request = expectRequest(generator.next(), 'activity');

      expect(request.activityName).toBe('greet');
      expect(request.fn).toBe(greet);
      expect(request.input).toBe('Alice');
    });

    it('returns the fed-back result', () => {
      const context = createContext();

      const generator = context.run(greet, 'Alice');
      generator.next(); // yield

      const result = generator.next('Hello, Alice!');
      expect(result.done).toBe(true);
      expect(result.value).toBe('Hello, Alice!');
    });

    it('on recovery returns cached result without yielding', () => {
      const accumulatedResults = new Map<number, unknown>();
      accumulatedResults.set(0, 'cached-result');
      const context = createContext({ accumulatedResults });

      const generator = context.run(greet, 'Alice');
      const result = generator.next();

      expect(result.done).toBe(true);
      expect(result.value).toBe('cached-result');
    });

    it('on recovery skips completed retry backoff sleeps after a cached retried activity', () => {
      const accumulatedResults = new Map<number, unknown>();
      accumulatedResults.set(0, 'cached-result');
      accumulatedResults.set(1, undefined);
      const context = createContext({
        accumulatedResults,
        locals: {
          __weftActivityRetryState: {
            version: 1,
            attempts: {},
            completedRetrySleeps: { '0': 1 },
          },
        },
      });

      const retriedActivity = context.run(greet, 'Alice');
      const retriedResult = retriedActivity.next();
      expect(retriedResult.done).toBe(true);
      expect(retriedResult.value).toBe('cached-result');
      expect(context.stepIndex).toBe(2);

      const nextActivity = context.run(sendEmail, 'bob@example.com');
      const request = expectRequest(nextActivity.next(), 'activity');
      expect(request.activityName).toBe('sendEmail');
    });

    it('on recovery returns cached undefined without yielding', () => {
      const accumulatedResults = new Map<number, unknown>();
      accumulatedResults.set(0, undefined);
      const context = createContext({ accumulatedResults });

      const generator = context.run(() => undefined);
      const result = generator.next();

      expect(result.done).toBe(true);
      expect(result.value).toBeUndefined();
    });

    it('derives activity name from function name', () => {
      const context = createContext();

      const generator = context.run(sendEmail, 'bob@example.com');
      const request = expectRequest(generator.next(), 'activity');

      expect(request.activityName).toBe('sendEmail');
    });

    it('accepts ActivityCallOptions as the last argument with queue', () => {
      const context = createContext();

      const generator = context.run(greet, 'Alice', { queue: 'gpu' });
      const request = expectRequest(generator.next(), 'activity');

      expect(request.activityName).toBe('greet');
      expect(request.input).toBe('Alice');
      expect(request.options).toEqual({ queue: 'gpu' });
    });

    it('accepts ActivityCallOptions for string-name activities', () => {
      const context = createContext();

      const generator = context.run('formatGreeting', { name: 'Alice' }, { queue: 'gpu' });
      const request = expectRequest(generator.next(), 'activity');

      expect(request.activityName).toBe('formatGreeting');
      expect(request.fn).toBeUndefined();
      expect(request.input).toEqual({ name: 'Alice' });
      expect(request.options).toEqual({ queue: 'gpu' });
    });

    it('accepts ActivityCallOptions with no function arguments', () => {
      const context = createContext();

      const generator = context.run(task, { queue: 'billing' });
      const request = expectRequest(generator.next(), 'activity');

      expect(request.activityName).toBe('task');
      expect(request.input).toBeUndefined();
      expect(request.options).toEqual({ queue: 'billing' });
    });

    it('accepts ActivityCallOptions with multiple options', () => {
      const context = createContext();

      const generator = context.run(greet, 'Alice', { queue: 'gpu', timeout: 5000 });
      const request = expectRequest(generator.next(), 'activity');

      expect(request.input).toBe('Alice');
      expect(request.options).toEqual({ queue: 'gpu', timeout: 5000 });
    });

    it('rejects multiple activity input values at runtime', () => {
      const context = createContext();
      const run = context.run as (...arguments_: unknown[]) => Generator<ContextOperationRequest>;

      expect(() => run(greet, 'Alice', 'extra').next()).toThrow(
        'ctx.run() accepts one activity input value plus optional ActivityCallOptions.',
      );
    });

    it('does not include options when none are provided', () => {
      const context = createContext();

      const generator = context.run(greet, 'Alice');
      const request = expectRequest(generator.next(), 'activity');

      expect(request.options).toBeUndefined();
    });

    it('does not treat a plain object argument as options if it has unknown keys', () => {
      const context = createContext();

      const generator = context.run(greet, { name: 'Alice', queue: 'not-options' });
      const request = expectRequest(generator.next(), 'activity');

      expect(request.input).toEqual({ name: 'Alice', queue: 'not-options' });
      expect(request.options).toBeUndefined();
    });

    it('does not treat an options-shaped object as options for an input activity', () => {
      const context = createContext();

      const generator = context.run(greet, { queue: 'orders' });
      const request = expectRequest(generator.next(), 'activity');

      expect(request.input).toEqual({ queue: 'orders' });
      expect(request.options).toBeUndefined();
    });

    it('does not treat { timeout: 5000 } as options — timeout alone is ambiguous', () => {
      const context = createContext();

      const generator = context.run(greet, { timeout: 5000 });
      const request = expectRequest(generator.next(), 'activity');

      expect(request.input).toEqual({ timeout: 5000 });
      expect(request.options).toBeUndefined();
    });

    it('accepts sticky: true as an ActivityCallOption', () => {
      const context = createContext();

      const generator = context.run(greet, 'Alice', { sticky: true });
      const request = expectRequest(generator.next(), 'activity');

      expect(request.input).toBe('Alice');
      expect(request.options).toEqual({ sticky: true });
    });

    it('accepts sticky: true combined with queue option', () => {
      const context = createContext();

      const generator = context.run(greet, 'Alice', { queue: 'gpu', sticky: true });
      const request = expectRequest(generator.next(), 'activity');

      expect(request.input).toBe('Alice');
      expect(request.options).toEqual({ queue: 'gpu', sticky: true });
    });

    it('accepts visibilityTimeout as an ActivityCallOption', () => {
      const context = createContext();

      const generator = context.run(greet, 'Alice', { visibilityTimeout: 60_000 });
      const request = expectRequest(generator.next(), 'activity');

      expect(request.input).toBe('Alice');
      expect(request.options).toEqual({ visibilityTimeout: 60_000 });
    });

    it('defaults queue to "default" in explain mode when no queue option is provided', () => {
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
      const context = createContext();
      context.explain(true);

      const generator = context.run(greet, 'Alice');
      generator.next();

      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('queue "default"');
      consoleSpy.mockRestore();
    });

    it('logs the specified queue in explain mode', () => {
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
      const context = createContext();
      context.explain(true);

      const generator = context.run(greet, 'Alice', { queue: 'gpu' });
      generator.next();

      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('queue "gpu"');
      consoleSpy.mockRestore();
    });
  });

  describe('Acceptance criterion: Virtual-Object-style session state API', () => {
    it('does not expose the old sessionState method', () => {
      const context = createContext();

      expect('sessionState' in context).toBe(false);
    });

    it('returns the initial value until a value is written', () => {
      const context = createContext();
      const session = context.state.session<number>('counter', { initial: 0 });

      expect(session.get()).toBe(0);
    });

    it('restores legacy checkpoint-local session state and normalizes new writes', () => {
      const context = createContext({
        locals: {
          retained: true,
          sessionState: {
            counter: 2,
          },
        },
      });
      const session = context.state.session<number>('counter');

      expect(session.get()).toBe(2);

      session.set(3);

      expect(context.checkpointLocals).toEqual({
        retained: true,
        stateSession: {
          counter: 3,
        },
      });
      expect('sessionState' in context.checkpointLocals).toBe(false);
    });

    it('returns undefined after clear when no initial value is configured', () => {
      const context = createContext();
      const session = context.state.session<number>('counter');

      session.set(1);
      session.delete();

      expect(session.get()).toBeUndefined();
    });

    it('updates and clears a session-scoped value', () => {
      const context = createContext();
      const session = context.state.session<number>('counter', { initial: 0 });

      expect(session.update((current) => (current ?? 0) + 1)).toBe(1);
      expect(session.get()).toBe(1);

      session.delete();
      expect(session.get()).toBe(0);
    });

    it('routes session-bound activities through sticky worker execution', () => {
      const context = createContext();
      const session = context.state.session<number>('conversation', { initial: 0 });

      const generator = session.run(greet, 'Alice', { queue: 'gpu' });
      const request = expectRequest(
        generator.next() as IteratorResult<ContextOperationRequest, unknown>,
        'activity',
      );

      expect(request.input).toBe('Alice');
      expect(request.options).toEqual({ queue: 'gpu', sticky: true });
    });

    it('rejects reserved prototype keys', () => {
      const context = createContext();
      const session = context.state.session<number>('__proto__', { initial: 0 });

      expect(() => session.set(1)).toThrow(SessionStateValidationError);
      expect(({} as { polluted?: number }).polluted).toBeUndefined();
    });

    it('rejects oversized session-state payloads', () => {
      const context = createContext();
      const session = context.state.session<string>('payload');

      expect(() => session.set('x'.repeat(MAX_SESSION_STATE_SERIALIZED_BYTES + 1024))).toThrow(
        SessionStateValidationError,
      );
    });

    it('returns cloned values so caller mutation does not leak into durable state', () => {
      const context = createContext();
      const session = context.state.session<{ values: string[] }>('draft');

      const stored = session.set({ values: ['a'] });
      stored.values.push('b');

      const firstRead = session.get();
      expect(firstRead).toEqual({ values: ['a'] });

      firstRead!.values.push('c');
      expect(session.get()).toEqual({ values: ['a'] });
    });

    it('snapshots the initial value when the handle is created', () => {
      const context = createContext();
      const initialValue = { values: ['a'] };
      const session = context.state.session<{ values: string[] }>('draft', {
        initial: initialValue,
      });

      initialValue.values.push('b');

      const firstRead = session.get();
      expect(firstRead).toEqual({ values: ['a'] });

      firstRead!.values.push('c');
      expect(session.get()).toEqual({ values: ['a'] });
    });

    it('does not poison stored state when validation rejects a write', () => {
      const context = createContext();
      const session = context.state.session<string>('payload');

      session.set('safe');

      expect(() => session.set('x'.repeat(MAX_SESSION_STATE_SERIALIZED_BYTES + 1024))).toThrow(
        SessionStateValidationError,
      );
      expect(session.get()).toBe('safe');
    });

    it('allows durable state handles to configure maxRetries', () => {
      const context = createContext();
      const durable = context.state.execution<number>('counter', {
        initial: 0,
        maxRetries: 1,
      });

      const request = expectRequest(
        durable.get().next() as IteratorResult<ContextOperationRequest, number | undefined>,
        'state-read',
      );

      expect(request.key).toBe('counter');
    });
  });

  describe('ctx.sleep', () => {
    it('yields a sleep request with parsed duration from string', () => {
      const now = 1_000_000;
      const context = createContext({ getNow: () => now });

      const generator = context.sleep('1 hour');
      const request = expectRequest(generator.next(), 'sleep');

      expect(request.duration).toBe(3_600_000);
      expect(request.scheduledFireAt).toBe(now + 3_600_000);
    });

    it('yields a sleep request with numeric duration', () => {
      const now = 1_000_000;
      const context = createContext({ getNow: () => now });

      const generator = context.sleep(5000);
      const request = expectRequest(generator.next(), 'sleep');

      expect(request.duration).toBe(5000);
      expect(request.scheduledFireAt).toBe(now + 5000);
    });
  });

  describe('ctx.waitForSignal', () => {
    it('yields a wait-signal request with the signal name', () => {
      const context = createContext();

      const generator = context.waitForSignal('approval');
      const request = expectRequest(generator.next(), 'wait-signal');

      expect(request.signalName).toBe('approval');
    });
  });

  describe('ctx.all', () => {
    it('yields a parallel request containing sub-operations', () => {
      const context = createContext();

      const generator = context.all([context.run(taskA), context.run(taskB)]);
      const request = expectRequest(generator.next(), 'parallel');

      expect(request.operations).toHaveLength(2);
      expect(request.operations[0]!.type).toBe('activity');
      expect(request.operations[1]!.type).toBe('activity');
    });

    it('preserves queue options on parallel sub-operations', () => {
      const context = createContext();

      const generator = context.all([
        context.run(taskA, { queue: 'gpu' }),
        context.run(taskB, { queue: 'cpu' }),
      ]);
      const request = expectRequest(generator.next(), 'parallel');

      expect(request.operations).toHaveLength(2);
      const op0 = request.operations[0] as Extract<ContextOperationRequest, { type: 'activity' }>;
      const op1 = request.operations[1] as Extract<ContextOperationRequest, { type: 'activity' }>;
      expect(op0.options).toEqual({ queue: 'gpu' });
      expect(op1.options).toEqual({ queue: 'cpu' });
    });

    it('preserves legacy recovery step ordering for cached parallel results', () => {
      const context = createContext({
        accumulatedResults: new Map<number, unknown>([
          [0, ['cached-a', 'cached-b']],
          [1, 'next-cached-result'],
        ]),
      });

      const generator = context.all([context.run(taskA), context.run(taskB)]);
      const result = generator.next();

      expect(result.done).toBe(true);
      expect(result.value).toEqual(['cached-a', 'cached-b']);

      const nextStep = context.run(task).next();
      expect(nextStep.done).toBe(true);
      expect(nextStep.value).toBe('next-cached-result');
    });

    it('advances recovery past cached parallel sub-operations for new checkpoints', () => {
      const context = createContext({
        accumulatedResults: new Map<number, unknown>([
          [
            0,
            {
              __weftParallelOperationCache: true,
              formatVersion: 2,
              variant: 'all',
              branches: [
                { status: 'fulfilled', value: 'cached-a', operationId: 'parallel:0:0' },
                { status: 'fulfilled', value: 'cached-b', operationId: 'parallel:0:1' },
              ],
              subOperationCount: 2,
            },
          ],
          [3, 'next-cached-result'],
        ]),
      });

      const generator = context.all([context.run(taskA), context.run(taskB)]);
      const result = generator.next();

      expect(result.done).toBe(true);
      expect(result.value).toEqual(['cached-a', 'cached-b']);

      const nextStep = context.run(task).next();
      expect(nextStep.done).toBe(true);
      expect(nextStep.value).toBe('next-cached-result');
    });

    it('throws when a cached all entry has a malformed branch table', () => {
      const context = createContext({
        accumulatedResults: new Map<number, unknown>([
          [
            0,
            {
              __weftParallelOperationCache: true,
              formatVersion: 2,
              variant: 'all',
              branches: [{ status: 'fulfilled', value: 'cached-a', operationId: 'parallel:0:0' }],
              subOperationCount: 2,
            },
          ],
        ]),
      });

      const generator = context.all([context.run(taskA), context.run(taskB)]);

      expect(() => generator.next()).toThrow(BranchTopologyChangedError);
    });
  });

  describe('ctx.race', () => {
    it('yields a race request containing sub-operations', () => {
      const context = createContext();

      const generator = context.race([context.run(taskA), context.run(taskB)]);
      const request = expectRequest(generator.next(), 'race');

      expect(request.operations).toHaveLength(2);
    });

    it('preserves legacy recovery step ordering for cached race results', () => {
      const context = createContext({
        accumulatedResults: new Map<number, unknown>([
          [0, 'winner'],
          [1, 'next-cached-result'],
        ]),
      });

      const generator = context.race([context.run(taskA), context.run(taskB)]);
      const result = generator.next();

      expect(result.done).toBe(true);
      expect(result.value).toBe('winner');

      const nextStep = context.run(task).next();
      expect(nextStep.done).toBe(true);
      expect(nextStep.value).toBe('next-cached-result');
    });

    it('advances recovery past cached race sub-operations for new checkpoints', () => {
      const context = createContext({
        accumulatedResults: new Map<number, unknown>([
          [
            0,
            {
              __weftParallelOperationCache: true,
              formatVersion: 2,
              variant: 'race',
              branches: [{ status: 'fulfilled', value: 'winner', operationId: 'race:0:winner' }],
              subOperationCount: 2,
            },
          ],
          [3, 'next-cached-result'],
        ]),
      });

      const generator = context.race([context.run(taskA), context.run(taskB)]);
      const result = generator.next();

      expect(result.done).toBe(true);
      expect(result.value).toBe('winner');

      const nextStep = context.run(task).next();
      expect(nextStep.done).toBe(true);
      expect(nextStep.value).toBe('next-cached-result');
    });

    it('throws when cached race branch count changes on replay', () => {
      const context = createContext({
        accumulatedResults: new Map<number, unknown>([
          [
            0,
            {
              __weftParallelOperationCache: true,
              formatVersion: 2,
              variant: 'race',
              branches: [{ status: 'fulfilled', value: 'winner', operationId: 'race:0:winner' }],
              subOperationCount: 2,
            },
          ],
        ]),
      });

      const generator = context.race([context.run(taskA), context.run(taskB), context.run(task)]);

      expect(() => generator.next()).toThrow(BranchTopologyChangedError);
    });
  });

  describe('ctx.memo', () => {
    it('returns cached value on second call without re-yielding', () => {
      const context = createContext();

      let _callCount = 0;
      const compute = () => {
        _callCount++;
        return 42;
      };

      // First call: yields
      const generator1 = context.memo('key1', compute);
      const yielded = generator1.next();
      expect(yielded.done).toBe(false);
      const request = yielded.value as ContextOperationRequest;
      expect(request.type).toBe('memo');
      // Feed the result back
      const result1 = generator1.next(42);
      expect(result1.done).toBe(true);
      expect(result1.value).toBe(42);

      // Second call: returns from memo cache without yielding
      const generator2 = context.memo('key1', compute);
      const result2 = generator2.next();
      expect(result2.done).toBe(true);
      expect(result2.value).toBe(42);
    });

    it('on recovery returns checkpoint-cached value', () => {
      const accumulatedResults = new Map<number, unknown>();
      accumulatedResults.set(0, 'recovered-value');
      const context = createContext({ accumulatedResults });

      const generator = context.memo('key1', () => 'computed');
      const result = generator.next();

      expect(result.done).toBe(true);
      expect(result.value).toBe('recovered-value');
    });
  });

  describe('ctx.waitForUpdate', () => {
    it('yields a wait-update request', () => {
      const context = createContext();

      const generator = context.waitForUpdate('updateName');
      const request = expectRequest(generator.next(), 'wait-update');

      expect(request.updateName).toBe('updateName');
    });

    it('recovery path returns a no-op responder that can still be called safely', () => {
      const accumulatedResults = new Map<number, unknown>();
      accumulatedResults.set(0, { payload: 'cached-update' });
      const context = createContext({ accumulatedResults });

      const generator = context.waitForUpdate<string>('updateName');
      const result = generator.next();

      expect(result.done).toBe(true);
      if (!result.done) {
        throw new Error('Expected waitForUpdate recovery path to return without yielding');
      }

      expect(result.value.payload).toBe('cached-update');
      expect(() => result.value.respond('ignored')).not.toThrow();
    });
  });

  describe('setAttribute / getAttribute', () => {
    it('stores and retrieves an attribute', () => {
      const context = createContext();
      context.setAttribute('region', 'us-east-1');
      expect(context.getAttribute('region')).toBe('us-east-1');
    });

    it('setAttributes merges with existing attributes', () => {
      const context = createContext();
      context.setAttribute('region', 'us-east-1');
      context.setAttributes({ priority: 5, region: 'eu-west-1' });

      expect(context.getAttribute('region')).toBe('eu-west-1');
      expect(context.getAttribute('priority')).toBe(5);
    });

    it('getAttributes returns a readonly copy that cannot mutate internal state', () => {
      const context = createContext();
      context.setAttribute('key', 'value');

      const attributes = context.getAttributes() as Record<string, SearchAttributeValue>;
      attributes['key'] = 'mutated';

      expect(context.getAttribute('key')).toBe('value');
    });
  });

  describe('ctx.onUpdate', () => {
    it('registers an update handler', () => {
      const context = createContext();
      context.onUpdate('myUpdate', handler);

      expect(context.updateHandlers.get('myUpdate')).toBe(handler);
    });
  });

  describe('ctx.onQuery', () => {
    it('registers a query handler', () => {
      const context = createContext();
      context.onQuery('myQuery', handler);

      expect(context.queryHandlers.get('myQuery')).toBe(handler);
    });
  });

  describe('ctx.expose', () => {
    it('stores accessor functions', () => {
      const context = createContext();
      context.expose({ counter: accessor });

      expect(context.exposedAccessors.get('counter')).toBe(accessor);
    });
  });

  describe('ctx.signal', () => {
    it('returns an AbortSignal', () => {
      const context = createContext();
      expect(context.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('ctx.executionTimeRemaining', () => {
    it('returns the time remaining when deadline is set', () => {
      const now = 10_000;
      const deadline = 20_000;
      const context = createContext({ deadline, getNow: () => now });

      expect(context.executionTimeRemaining).toBe(10_000);
    });

    it('returns Infinity when no deadline is set', () => {
      const context = createContext();
      expect(context.executionTimeRemaining).toBe(Infinity);
    });
  });

  describe('step index', () => {
    it('increments monotonically across different operations', () => {
      const context = createContext();

      // Step 0: run
      const runGenerator = context.run(taskA);
      runGenerator.next();
      runGenerator.next('result-a');

      // Step 1: sleep
      const sleepGenerator = context.sleep(1000);
      sleepGenerator.next();
      sleepGenerator.next(undefined);

      // Step 2: run
      const runGenerator2 = context.run(taskB);
      runGenerator2.next();
      runGenerator2.next('result-b');

      expect(context.stepIndex).toBe(3);
    });
  });

  describe('operationId', () => {
    it('is a valid UUID', () => {
      const context = createContext();

      const generator = context.run(task);
      const request = expectRequest(generator.next(), 'activity');

      expect(request.operationId).toMatch(UUID_PATTERN);
    });
  });

  describe('pendingAttributeChanges', () => {
    it('tracks attribute changes separately', () => {
      const context = createContext();
      context.setAttribute('key', 'value');

      expect(context.pendingAttributeChanges).toEqual({ key: 'value' });
    });
  });

  describe('constructor options', () => {
    it('initializes with provided search attributes', () => {
      const context = createContext({
        searchAttributes: { region: 'us-east-1' },
      });
      expect(context.getAttribute('region')).toBe('us-east-1');
    });

    it('initializes with a provided initial step', () => {
      const context = createContext({ initialStep: 5 });
      expect(context.stepIndex).toBe(5);
    });
  });

  describe('accumulatedResults getter', () => {
    it('returns the internal accumulated results map', () => {
      const accumulatedResults = new Map<number, unknown>();
      accumulatedResults.set(0, 'value-0');
      const context = createContext({ accumulatedResults });
      expect(context.accumulatedResults).toBe(accumulatedResults);
      expect(context.accumulatedResults.get(0)).toBe('value-0');
    });
  });

  describe('ctx.offload', () => {
    it('yields an offload operation request', () => {
      const context = createContext();
      const fn = async () => ({ large: 'data' });

      const generator = context.offload('large-payload', fn);
      const request = expectRequest(generator.next(), 'offload');

      expect(request.key).toBe('large-payload');
      expect(request.fn).toBe(fn);
      expect(request.operationId).toMatch(UUID_PATTERN);
    });

    it('on recovery returns cached OffloadReference without yielding', () => {
      const cachedReference: OffloadReference = {
        key: 'large-payload',
        workflowId: 'wf-test-123',
        sizeBytes: 1024,
      };
      const accumulatedResults = new Map<number, unknown>();
      accumulatedResults.set(0, cachedReference);
      const context = createContext({ accumulatedResults });

      const generator = context.offload('large-payload', async () => 'data');
      const result = generator.next();

      expect(result.done).toBe(true);
      expect(result.value).toBe(cachedReference);
    });

    it('returns the fed-back OffloadReference', () => {
      const context = createContext();
      const reference: OffloadReference = {
        key: 'large-payload',
        workflowId: 'wf-test-123',
        sizeBytes: 2048,
      };

      const generator = context.offload('large-payload', async () => 'data');
      generator.next(); // yield
      const result = generator.next(reference);

      expect(result.done).toBe(true);
      expect(result.value).toBe(reference);
    });
  });

  describe('ctx.load', () => {
    it('yields a load operation request', () => {
      const context = createContext();
      const reference: OffloadReference = {
        key: 'large-payload',
        workflowId: 'wf-test-123',
        sizeBytes: 1024,
      };

      const generator = context.load(reference);
      const request = expectRequest(generator.next(), 'load');

      expect(request.reference).toBe(reference);
      expect(request.operationId).toMatch(UUID_PATTERN);
    });

    it('on recovery returns cached value without yielding', () => {
      const accumulatedResults = new Map<number, unknown>();
      accumulatedResults.set(0, { large: 'data' });
      const context = createContext({ accumulatedResults });

      const reference: OffloadReference = {
        key: 'large-payload',
        workflowId: 'wf-test-123',
        sizeBytes: 1024,
      };
      const generator = context.load(reference);
      const result = generator.next();

      expect(result.done).toBe(true);
      expect(result.value).toEqual({ large: 'data' });
    });
  });

  describe('ctx.archive', () => {
    it('yields an archive operation request', () => {
      const context = createContext();
      const data = { order: 'completed', total: 99.99 };

      const generator = context.archive('order-snapshot', data);
      const request = expectRequest(generator.next(), 'archive');

      expect(request.key).toBe('order-snapshot');
      expect(request.data).toBe(data);
      expect(request.operationId).toMatch(UUID_PATTERN);
    });

    it('on recovery skips without yielding', () => {
      const accumulatedResults = new Map<number, unknown>();
      accumulatedResults.set(0, undefined);
      const context = createContext({ accumulatedResults });

      const generator = context.archive('order-snapshot', { some: 'data' });
      const result = generator.next();

      expect(result.done).toBe(true);
    });
  });

  describe('ctx.runAll', () => {
    it('yields a run-all operation request with named branches', () => {
      const context = createContext();
      const branches = {
        charge: [taskA, 'arg1'] as [Function, unknown],
        notify: [taskB] as [Function],
      };

      const generator = context.runAll(branches);
      const request = expectRequest(generator.next(), 'run-all');

      expect(request.branches).toBe(branches);
      // Operation IDs are deterministic (`run-all:<step>`) for stable
      // observability across retries.
      expect(request.operationId).toBe('run-all:0');
    });

    it('on recovery returns cached result without yielding', () => {
      const cached = { charge: 'paid', notify: 'sent' };
      const accumulatedResults = new Map<number, unknown>();
      accumulatedResults.set(0, cached);
      const context = createContext({ accumulatedResults });

      const generator = context.runAll({
        charge: [taskA] as [Function],
        notify: [taskB] as [Function],
      });
      const result = generator.next();

      expect(result.done).toBe(true);
      expect(result.value as unknown).toBe(cached);
    });
  });

  describe('ctx.speculate', () => {
    it('yields a speculative operation request', () => {
      const context = createContext();

      const generator = context.speculate(async function* (branch) {
        return yield* branch.run(task);
      });
      const request = expectRequest(generator.next(), 'speculate');

      expect(request.operationId).toMatch(UUID_PATTERN);
      expect(typeof request.execute).toBe('function');
    });

    it('on recovery returns cached result without yielding', () => {
      const accumulatedResults = new Map<number, unknown>();
      accumulatedResults.set(0, 'cached-speculation-result');
      const context = createContext({ accumulatedResults });

      const generator = context.speculate(async function* (branch) {
        return yield* branch.run(task);
      });
      const result = generator.next();

      expect(result.done).toBe(true);
      expect(result.value).toBe('cached-speculation-result');
    });

    it('preserves query handlers registered before speculative execution', () => {
      const context = createContext();
      const parentQueryHandler = () => 'parent';
      const childQueryHandler = () => 'child';
      context.onQuery('parent', parentQueryHandler);

      const child = context.createSpeculativeChild();
      expect(child.queryHandlers.get('parent')).toBe(parentQueryHandler);
      child.onQuery('child', childQueryHandler);
      context.commitSpeculativeChild(child);

      expect(context.queryHandlers.get('parent')).toBe(parentQueryHandler);
      expect(context.queryHandlers.get('child')).toBe(childQueryHandler);
    });

    it('propagates the non-serialized services value to a speculative child', () => {
      const services = { generate: () => 'ok' };
      const context = createContext({ services });
      const child = context.createSpeculativeChild();
      // A speculative re-execution of the body must still read ctx.services.
      expect(child.services).toBe(services);
    });

    it('leaves child services undefined when the parent has none', () => {
      const context = createContext();
      const child = context.createSpeculativeChild();
      expect(child.services).toBeUndefined();
    });
  });

  describe('ctx.workflowType', () => {
    it('exposes the workflowType passed at construction', () => {
      const context = createContext({ workflowType: 'my-workflow' });
      expect(context.workflowType).toBe('my-workflow');
    });

    it('is readable through the WorkflowContext interface type', () => {
      // Reading workflowType off a WorkflowContext-typed binding will not compile
      // if the interface lacks the member, so this read pins the interface
      // contract at compile time; the runtime expect confirms the value flows
      // through. (The drift guard in type-ergonomics.test-d.ts is the primary
      // enforcement; this is the consumer-facing companion.)
      const context = createContext({ workflowType: 'interface-check' });
      const asInterface: WorkflowContext = context;
      expect(asInterface.workflowType).toBe('interface-check');
    });
  });

  describe('ctx.runAll fed-back result', () => {
    it('returns the fed-back result', () => {
      const context = createContext();
      const branches = {
        charge: [taskA] as [Function],
        notify: [taskB] as [Function],
      };

      const generator = context.runAll(branches);
      generator.next(); // yield

      const result = generator.next({ charge: 'ok', notify: 'done' });
      expect(result.done).toBe(true);
      expect(result.value as unknown).toEqual({ charge: 'ok', notify: 'done' });
    });
  });

  describe('ctx.stream', () => {
    it('yields a stream operation request', () => {
      const context = createContext();
      const fn = async function* (sink: StreamSink) {
        yield { batch: 1 };
        sink.heartbeat({ processed: 1 });
        yield { batch: 2 };
      };

      const generator = context.stream('export-data', fn);
      const request = expectRequest(generator.next(), 'stream');

      expect(request.key).toBe('export-data');
      expect(request.fn).toBe(fn);
      expect(request.operationId).toMatch(UUID_PATTERN);
    });

    it('on recovery returns cached StreamReference without yielding', () => {
      const cachedReference: StreamReference = {
        key: 'export-data',
        workflowId: 'wf-test-123',
        chunkCount: 5,
        totalSizeBytes: 2048,
      };
      const accumulatedResults = new Map<number, unknown>();
      accumulatedResults.set(0, cachedReference);
      const context = createContext({ accumulatedResults });

      const generator = context.stream('export-data', async function* () {});
      const result = generator.next();

      expect(result.done).toBe(true);
      expect(result.value).toBe(cachedReference);
    });

    it('returns the fed-back StreamReference', () => {
      const context = createContext();
      const reference: StreamReference = {
        key: 'export-data',
        workflowId: 'wf-test-123',
        chunkCount: 3,
        totalSizeBytes: 4096,
      };

      const generator = context.stream('export-data', async function* () {});
      generator.next(); // yield
      const result = generator.next(reference);

      expect(result.done).toBe(true);
      expect(result.value).toBe(reference);
    });

    it('increments step index', () => {
      const context = createContext();
      const generator = context.stream('key', async function* () {});
      generator.next();
      generator.next({});
      expect(context.stepIndex).toBe(1);
    });
  });

  describe('ctx.streamUrl', () => {
    it('constructs a URL path from a StreamReference', () => {
      const context = createContext();
      const reference: StreamReference = {
        key: 'export-data',
        workflowId: 'wf-test-123',
        chunkCount: 5,
        totalSizeBytes: 2048,
      };

      const url = context.streamUrl(reference);
      expect(url).toBe('/v1/workflows/wf-test-123/streams/export-data');
    });

    it('encodes special characters in key and workflowId', () => {
      const context = createContext();
      const reference: StreamReference = {
        key: 'data/export',
        workflowId: 'wf:special',
        chunkCount: 1,
        totalSizeBytes: 100,
      };

      const url = context.streamUrl(reference);
      expect(url).toBe('/v1/workflows/wf%3Aspecial/streams/data%2Fexport');
    });
  });

  describe('ctx.explain', () => {
    afterEach(() => {
      mock.restore();
    });

    it('enables explain mode', () => {
      const context = createContext();

      // Should not throw
      context.explain();
      expect(context.explainEnabled).toBe(true);
    });

    it('can disable explain mode', () => {
      const context = createContext();

      context.explain(true);
      expect(context.explainEnabled).toBe(true);

      context.explain(false);
      expect(context.explainEnabled).toBe(false);
    });

    it('logs stream operation details when explain mode is enabled', () => {
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
      const context = createContext();
      context.explain(true);

      const generator = context.stream('export-data', async function* () {});
      generator.next();

      expect(consoleSpy).toHaveBeenCalled();
      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('stream');
    });

    it('logs operation details when explain mode is enabled', () => {
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
      const context = createContext();
      context.explain(true);

      const generator = context.run(greet, 'Alice');
      generator.next();

      expect(consoleSpy).toHaveBeenCalled();
      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('run');
    });

    it('logs sleep details when explain mode is enabled', () => {
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
      const context = createContext();
      context.explain(true);

      const generator = context.sleep(5000);
      generator.next();

      expect(consoleSpy).toHaveBeenCalled();
      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('ctx.sleep');
      expect(calls).toContain('5000ms');
    });

    it('logs waitForSignal details when explain mode is enabled', () => {
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
      const context = createContext();
      context.explain(true);

      const generator = context.waitForSignal('approval');
      generator.next();

      expect(consoleSpy).toHaveBeenCalled();
      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('ctx.waitForSignal');
      expect(calls).toContain('approval');
    });

    it('logs waitForUpdate details when explain mode is enabled', () => {
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
      const context = createContext();
      context.explain(true);

      const generator = context.waitForUpdate('price-update');
      generator.next();

      expect(consoleSpy).toHaveBeenCalled();
      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('ctx.waitForUpdate');
      expect(calls).toContain('price-update');
    });

    it('does not log sleep when explain mode is disabled', () => {
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
      const context = createContext();

      const generator = context.sleep(1000);
      generator.next();

      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('logs offload details when explain mode is enabled', () => {
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
      const context = createContext();
      context.explain(true);

      const generator = context.offload('report-data', async () => ({ large: 'dataset' }));
      generator.next();

      expect(consoleSpy).toHaveBeenCalled();
      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('ctx.offload');
      expect(calls).toContain('report-data');
    });

    it('logs load details when explain mode is enabled', () => {
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
      const context = createContext();
      context.explain(true);

      const ref: OffloadReference = {
        key: 'report-data',
        workflowId: 'wf-test',
        sizeBytes: 1024,
      };
      const generator = context.load(ref);
      generator.next();

      expect(consoleSpy).toHaveBeenCalled();
      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('ctx.load');
      expect(calls).toContain('report-data');
    });

    it('logs archive details when explain mode is enabled', () => {
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
      const context = createContext();
      context.explain(true);

      const generator = context.archive('snapshot', { key: 'value' });
      generator.next();

      expect(consoleSpy).toHaveBeenCalled();
      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('ctx.archive');
      expect(calls).toContain('snapshot');
    });

    it('logs runAll details when explain mode is enabled', () => {
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
      const context = createContext();
      context.explain(true);

      const branches = {
        fetch: [taskA] as [Function],
        compute: [taskB] as [Function],
      };
      const generator = context.runAll(branches);
      generator.next();

      expect(consoleSpy).toHaveBeenCalled();
      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('ctx.runAll');
      expect(calls).toContain('fetch');
      expect(calls).toContain('compute');
      expect(calls).toContain('2 named branches');
    });

    it('logs startChild details when explain mode is enabled', () => {
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
      const context = createContext();
      context.explain(true);

      const generator = context.startChild('payment-process', { amount: 100 });
      generator.next();

      expect(consoleSpy).toHaveBeenCalled();
      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('ctx.startChild');
      expect(calls).toContain('payment-process');
    });

    it('logs cached result for startChild when explain mode is enabled', () => {
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
      const context = createContext({
        accumulatedResults: new Map([[0, 'cached-child-result']]),
      });
      context.explain(true);

      const generator = context.startChild('payment-process', { amount: 100 });
      const result = generator.next();

      expect(result.done).toBe(true);
      expect(result.value).toBe('cached-child-result');
      expect(consoleSpy).toHaveBeenCalled();
      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('Returning cached result');
    });

    it('logs cached result for ctx.run when explain mode is enabled', () => {
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
      const context = createContext({
        accumulatedResults: new Map([[0, 'cached-run-result']]),
      });
      context.explain(true);

      const generator = context.run(greet, 'Alice');
      const result = generator.next();

      expect(result.done).toBe(true);
      expect(result.value).toBe('cached-run-result');
      expect(consoleSpy).toHaveBeenCalled();
      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('Returning cached result');
    });
  });

  describe('callerStack', () => {
    it('ctx.run yields a request with callerStack', () => {
      const context = createContext();
      const generator = context.run(greet, 'Alice');
      const request = expectRequest(generator.next(), 'activity');

      expect(request.callerStack).toBeDefined();
      expect(typeof request.callerStack).toBe('string');
      expect(request.callerStack!.length).toBeGreaterThan(0);
    });

    it('ctx.startChild yields a request with callerStack', () => {
      const context = createContext();
      const generator = context.startChild('child-type', { key: 'value' });
      const request = expectRequest(generator.next(), 'child-workflow');

      expect(request.callerStack).toBeDefined();
      expect(typeof request.callerStack).toBe('string');
      expect(request.callerStack!.length).toBeGreaterThan(0);
    });

    it('ctx.startChild passes through the supported child workflow id option', () => {
      const context = createContext();
      const generator = context.startChild(
        'child-type',
        { key: 'value' },
        {
          id: 'child-123',
        },
      );
      const request = expectRequest(generator.next(), 'child-workflow');

      expect(request.options).toEqual({
        id: 'child-123',
      });
    });

    it('ctx.offload yields a request with callerStack', () => {
      const context = createContext();
      const fn = async () => ({ large: 'data' });
      const generator = context.offload('key', fn);
      const request = expectRequest(generator.next(), 'offload');

      expect(request.callerStack).toBeDefined();
      expect(typeof request.callerStack).toBe('string');
    });

    it('ctx.stream yields a request with callerStack', () => {
      const context = createContext();
      const generator = context.stream('key', async function* () {});
      const request = expectRequest(generator.next(), 'stream');

      expect(request.callerStack).toBeDefined();
      expect(typeof request.callerStack).toBe('string');
    });

    it('ctx.runAll yields a request with callerStack', () => {
      const context = createContext();
      const branches = {
        a: [taskA] as [Function],
        b: [taskB] as [Function],
      };
      const generator = context.runAll(branches);
      const request = expectRequest(generator.next(), 'run-all');

      expect(request.callerStack).toBeDefined();
      expect(typeof request.callerStack).toBe('string');
    });

    it('ctx.sleep yields a request with callerStack', () => {
      const context = createContext();
      const generator = context.sleep(5000);
      const request = expectRequest(generator.next(), 'sleep');

      expect(request.callerStack).toBeDefined();
      expect(typeof request.callerStack).toBe('string');
      expect(request.callerStack!.length).toBeGreaterThan(0);
    });

    it('ctx.waitForSignal yields a request with callerStack', () => {
      const context = createContext();
      const generator = context.waitForSignal('my-signal');
      const request = expectRequest(generator.next(), 'wait-signal');

      expect(request.callerStack).toBeDefined();
      expect(typeof request.callerStack).toBe('string');
      expect(request.callerStack!.length).toBeGreaterThan(0);
    });

    it('ctx.waitForUpdate yields a request with callerStack', () => {
      const context = createContext();
      const generator = context.waitForUpdate('my-update');
      const request = expectRequest(generator.next(), 'wait-update');

      expect(request.callerStack).toBeDefined();
      expect(typeof request.callerStack).toBe('string');
      expect(request.callerStack!.length).toBeGreaterThan(0);
    });

    it('ctx.review yields a request with callerStack', () => {
      const context = createContext();
      const generator = context.review({ artifact: { data: 'test' }, reviewType: 'approval' });
      const request = expectRequest(generator.next(), 'wait-review');

      expect(request.callerStack).toBeDefined();
      expect(typeof request.callerStack).toBe('string');
      expect(request.callerStack!.length).toBeGreaterThan(0);
    });

    it('ctx.memo yields a request with callerStack', () => {
      const context = createContext();
      const generator = context.memo('cache-key', () => 42);
      const request = expectRequest(generator.next(), 'memo');

      expect(request.callerStack).toBeDefined();
      expect(typeof request.callerStack).toBe('string');
      expect(request.callerStack!.length).toBeGreaterThan(0);
    });

    it('ctx.load yields a request with callerStack', () => {
      const context = createContext();
      const reference: OffloadReference = { key: 'test-key', workflowId: 'wf-1', sizeBytes: 100 };
      const generator = context.load(reference);
      const request = expectRequest(generator.next(), 'load');

      expect(request.callerStack).toBeDefined();
      expect(typeof request.callerStack).toBe('string');
      expect(request.callerStack!.length).toBeGreaterThan(0);
    });

    it('ctx.archive yields a request with callerStack', () => {
      const context = createContext();
      const generator = context.archive('archive-key', { data: 'value' });
      const request = expectRequest(generator.next(), 'archive');

      expect(request.callerStack).toBeDefined();
      expect(typeof request.callerStack).toBe('string');
      expect(request.callerStack!.length).toBeGreaterThan(0);
    });
  });
});
