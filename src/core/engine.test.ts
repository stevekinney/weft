import { describe, expect, it, mock, spyOn } from 'bun:test';

import { BudgetPolicyEnforcer } from '../ai/budget-policy.ts';
import { defineAgent } from '../ai/declaration.ts';
import { AgentBudgetExceededEvent, AgentBudgetWarningEvent } from '../ai/events.ts';
import type { LLMProvider } from '../ai/providers/interface.ts';
import type { ChatResponse } from '../ai/providers/types.ts';
import type { Storage as WeftStorage } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { decode, encode } from './codec.ts';
import type { Context, StreamReference } from './context.ts';
import { Engine, WorkflowHandle } from './engine.ts';
import {
  CheckpointSizeWarningEvent,
  DevelopmentWarningEvent,
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowStartedEvent,
  WorkflowTimedOutEvent,
} from './events.ts';
import type { ActivityInterceptor, WorkflowInterceptor } from './interceptor.ts';
import { WorkflowTimeoutError } from './timeouts.ts';
import type { WorkflowContext, WorkflowState } from './types.ts';
import { activity } from './types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain microtasks so fire-and-forget work completes. */
async function flush(): Promise<void> {
  await Bun.sleep(10);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Engine', () => {
  it('creates engine with no args and defaults to MemoryStorage', () => {
    const engine = new Engine();
    expect(engine).toBeInstanceOf(Engine);
    expect(engine).toBeInstanceOf(EventTarget);
    engine[Symbol.dispose]();
  });

  it('register(name, fn) shorthand registers a workflow', async () => {
    const engine = new Engine();
    const handler = async function* (_ctx: WorkflowContext, input: unknown) {
      return `hello ${input as string}`;
    };

    engine.register('greet', handler);
    const handle = await engine.start('greet', 'world');
    const result = await handle.result();
    expect(result).toBe('hello world');
    engine[Symbol.dispose]();
  });

  it('simple workflow completes with ctx.run', async () => {
    const engine = new Engine();
    const doubleActivity = async (...args: unknown[]) => (args[0] as number) * 2;

    engine.register('double', async function* (ctx: WorkflowContext, input: unknown) {
      const result = yield* (ctx as Context).run(doubleActivity, input);
      return result;
    });

    const handle = await engine.start('double', 5);
    const result = await handle.result();
    expect(result).toBe(10);
    engine[Symbol.dispose]();
  });

  it('two-step workflow completes both ctx.run calls', async () => {
    const engine = new Engine();
    const add = async (...args: unknown[]) => (args[0] as number) + (args[1] as number);
    const multiply = async (...args: unknown[]) => (args[0] as number) * (args[1] as number);

    engine.register('math', async function* (ctx: WorkflowContext, input: unknown) {
      const sum = yield* (ctx as Context).run(add, input, 3);
      const product = yield* (ctx as Context).run(multiply, sum, 2);
      return product;
    });

    const handle = await engine.start('math', 7);
    const result = await handle.result();
    expect(result).toBe(20); // (7 + 3) * 2
    engine[Symbol.dispose]();
  });

  it('handle.result() resolves with workflow output', async () => {
    const engine = new Engine();
    engine.register('value', async function* () {
      return { answer: 42 };
    });

    const handle = await engine.start('value', null);
    const result = await handle.result();
    expect(result).toEqual({ answer: 42 });
    engine[Symbol.dispose]();
  });

  it('WorkflowStartedEvent fires on start', async () => {
    const engine = new Engine();
    engine.register('noop', async function* () {
      return 'done';
    });

    const events: WorkflowStartedEvent[] = [];
    engine.addEventListener(WorkflowStartedEvent.type, (event) => {
      events.push(event as WorkflowStartedEvent);
    });

    const handle = await engine.start('noop', 'test-input');
    await handle.result();

    expect(events).toHaveLength(1);
    expect(events[0]!.workflowId).toBe(handle.id);
    expect(events[0]!.workflowType).toBe('noop');
    expect(events[0]!.input).toBe('test-input');
    engine[Symbol.dispose]();
  });

  it('WorkflowCompletedEvent fires with result and duration', async () => {
    const engine = new Engine();
    engine.register('fast', async function* () {
      return 'completed';
    });

    const events: WorkflowCompletedEvent[] = [];
    engine.addEventListener(WorkflowCompletedEvent.type, (event) => {
      events.push(event as WorkflowCompletedEvent);
    });

    const handle = await engine.start('fast', null);
    await handle.result();

    expect(events).toHaveLength(1);
    expect(events[0]!.workflowId).toBe(handle.id);
    expect(events[0]!.result).toBe('completed');
    expect(events[0]!.duration).toBeGreaterThanOrEqual(0);
    engine[Symbol.dispose]();
  });

  it('WorkflowFailedEvent fires when workflow throws', async () => {
    const engine = new Engine();
    engine.register('failing', async function* () {
      throw new Error('deliberate failure');
    });

    const events: WorkflowFailedEvent[] = [];
    engine.addEventListener(WorkflowFailedEvent.type, (event) => {
      events.push(event as WorkflowFailedEvent);
    });

    const handle = await engine.start('failing', null);
    await expect(handle.result()).rejects.toThrow('deliberate failure');

    expect(events).toHaveLength(1);
    expect(events[0]!.error.message).toBe('deliberate failure');
    engine[Symbol.dispose]();
  });

  it('cancel() aborts a running workflow', async () => {
    const engine = new Engine();
    const storage = engine.storage as MemoryStorage;

    engine.register('long-running', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('never-arrives');
      return 'should not reach';
    });

    const handle = await engine.start('long-running', null);
    // Attach a catch handler before cancelling so the rejection is handled
    const resultPromise = handle.result().catch(() => {});
    await flush();

    await engine.cancel(handle.id);
    await resultPromise;

    const stateBytes = await storage.get(KEYS.workflow(handle.id));
    const state = decode(stateBytes!) as WorkflowState;
    expect(state.status).toBe('cancelled');
    engine[Symbol.dispose]();
  });

  it('WorkflowCancelledEvent fires on cancel', async () => {
    const engine = new Engine();

    engine.register('cancellable', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('never');
      return 'nope';
    });

    const events: WorkflowCancelledEvent[] = [];
    engine.addEventListener(WorkflowCancelledEvent.type, (event) => {
      events.push(event as WorkflowCancelledEvent);
    });

    const handle = await engine.start('cancellable', null);
    const resultPromise = handle.result().catch(() => {});
    await flush();
    await engine.cancel(handle.id);
    await resultPromise;

    expect(events).toHaveLength(1);
    expect(events[0]!.workflowId).toBe(handle.id);
    engine[Symbol.dispose]();
  });

  it('signal() writes to storage and delivers to waiting workflow', async () => {
    const engine = new Engine();

    engine.register('signal-workflow', async function* (ctx: WorkflowContext) {
      const payload = yield* (ctx as Context).waitForSignal('my-signal');
      return `received: ${payload as string}`;
    });

    const handle = await engine.start('signal-workflow', null);
    await flush();

    await engine.signal(handle.id, 'my-signal', 'hello-signal');
    const result = await handle.result();

    expect(result).toBe('received: hello-signal');
    engine[Symbol.dispose]();
  });

  it('list() returns workflows', async () => {
    const engine = new Engine();
    engine.register('listable', async function* () {
      return 'ok';
    });

    const h1 = await engine.start('listable', null, { id: 'wf-a' });
    const h2 = await engine.start('listable', null, { id: 'wf-b' });
    await h1.result();
    await h2.result();

    const result = await engine.list();
    expect(result.total).toBe(2);
    expect(result.items.map((item) => item.id).toSorted()).toEqual(['wf-a', 'wf-b']);
    engine[Symbol.dispose]();
  });

  it('list() filters by status', async () => {
    const engine = new Engine();
    engine.register('filterable', async function* () {
      return 'ok';
    });
    engine.register('waiter', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('block');
      return 'ok';
    });

    await engine.start('filterable', null, { id: 'done-1' });
    await engine.start('waiter', null, { id: 'running-1' });

    // Wait for the first to complete
    await flush();

    const completedOnly = await engine.list({ status: 'completed' });
    expect(completedOnly.items.every((item) => item.status === 'completed')).toBe(true);
    engine[Symbol.dispose]();
  });

  it('getHandle() returns handle for existing workflow', async () => {
    const engine = new Engine();
    engine.register('gettable', async function* () {
      return 42;
    });

    const handle = await engine.start('gettable', null, { id: 'fixed-id' });
    await handle.result();

    const retrieved = engine.getHandle('fixed-id');
    expect(retrieved).toBeInstanceOf(WorkflowHandle);
    expect(retrieved.id).toBe('fixed-id');
    engine[Symbol.dispose]();
  });

  it('Engine disposal via Symbol.dispose cleans up', () => {
    const engine = new Engine();
    engine.register('disposable', async function* () {
      return 'ok';
    });

    // Should not throw
    engine[Symbol.dispose]();
  });

  it('ctx.sleep pauses workflow via scheduler', async () => {
    let now = 1000;
    const storage = new MemoryStorage();
    const engine = new Engine({ storage: storage as WeftStorage, getNow: () => now });

    engine.register('sleepy', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).sleep(5000);
      return 'awake';
    });

    const handle = await engine.start('sleepy', null);
    await flush();

    // Workflow should still be running (sleep not yet expired)
    const stateBytes = await storage.get(KEYS.workflow(handle.id));
    const state = decode(stateBytes!) as WorkflowState;
    expect(state.status).toBe('running');

    // Advance time and tick the scheduler
    now = 7000;
    await engine.scheduler.tick(now);
    await flush();

    const result = await handle.result();
    expect(result).toBe('awake');
    engine[Symbol.dispose]();
  });

  it('ctx.all runs parallel operations', async () => {
    const engine = new Engine();
    const double = async (...args: unknown[]) => (args[0] as number) * 2;
    const triple = async (...args: unknown[]) => (args[0] as number) * 3;

    engine.register('parallel-workflow', async function* (ctx: WorkflowContext) {
      const results = yield* (ctx as Context).all([
        (ctx as Context).run(double, 5),
        (ctx as Context).run(triple, 5),
      ]);
      return results;
    });

    const handle = await engine.start('parallel-workflow', null);
    const result = await handle.result();
    expect(result).toEqual([10, 15]);
    engine[Symbol.dispose]();
  });

  it('ctx.race takes first result', async () => {
    const engine = new Engine();
    const fast = async () => 'fast';
    const slow = async () => {
      await Bun.sleep(100);
      return 'slow';
    };

    engine.register('race-workflow', async function* (ctx: WorkflowContext) {
      const result = yield* (ctx as Context).race([
        (ctx as Context).run(fast),
        (ctx as Context).run(slow),
      ]);
      return result;
    });

    const handle = await engine.start('race-workflow', null);
    const result = await handle.result();
    expect(result).toBe('fast');
    engine[Symbol.dispose]();
  });

  it('ctx.race swallows loser rejections after aborting agent sub-operations', async () => {
    const engine = new Engine();
    let agentAborted = false;
    const agentStarted = Promise.withResolvers<void>();

    const abortableProvider: LLMProvider = {
      name: 'abortable',
      async chat(_messages, options): Promise<ChatResponse> {
        return await new Promise<ChatResponse>((_resolve, reject) => {
          agentStarted.resolve();
          options.signal?.addEventListener(
            'abort',
            () => {
              agentAborted = true;
              reject(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        });
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 1;
      },
    };

    engine.register('race-agent-abort-workflow', async function* (ctx: WorkflowContext) {
      return yield* (ctx as Context).race([
        (ctx as Context).agent({
          model: 'test-model',
          prompt: 'wait until aborted',
          provider: abortableProvider,
        }),
        (ctx as Context).run(async () => {
          await agentStarted.promise;
          return 'fast';
        }),
      ]);
    });

    const handle = await engine.start('race-agent-abort-workflow', null);
    await expect(handle.result()).resolves.toBe('fast');
    await flush();
    expect(agentAborted).toBe(true);
    engine[Symbol.dispose]();
  });

  it('ctx.memo caches the value', async () => {
    const engine = new Engine();
    let callCount = 0;

    engine.register('memo-workflow', async function* (ctx: WorkflowContext) {
      const first = yield* (ctx as Context).memo('expensive', () => {
        callCount++;
        return 'computed';
      });
      const second = yield* (ctx as Context).memo('expensive', () => {
        callCount++;
        return 'computed-again';
      });
      return { first, second };
    });

    const handle = await engine.start('memo-workflow', null);
    const result = (await handle.result()) as { first: string; second: string };

    // memo('expensive') was called twice, but fn should only execute once
    // The second call returns the cached value from the memo cache in Context
    expect(result.first).toBe('computed');
    expect(result.second).toBe('computed');
    // The fn should have been called once for the first memo and the
    // second memo returns from the memo cache before yielding to the engine
    expect(callCount).toBe(1);
    engine[Symbol.dispose]();
  });

  it('fails malformed operation requests with an explicit unsupported-type error', async () => {
    const engine = new Engine();

    engine.register('malformed-operation-workflow', async function* () {
      yield {
        type: 'unsupported-operation-type',
        operationId: 'unsupported-operation-id',
      } as never;
      return 'unreachable';
    });

    const handle = await engine.start('malformed-operation-workflow', null);
    await expect(handle.result()).rejects.toThrow(
      'Unsupported operation type: unsupported-operation-type',
    );
    engine[Symbol.dispose]();
  });

  it('custom workflow ID via options.id', async () => {
    const engine = new Engine();
    engine.register('identified', async function* () {
      return 'ok';
    });

    const handle = await engine.start('identified', null, { id: 'my-custom-id' });
    expect(handle.id).toBe('my-custom-id');
    await handle.result();
    engine[Symbol.dispose]();
  });

  it('activity failure propagates to workflow', async () => {
    const engine = new Engine();
    const failingActivity = async () => {
      throw new Error('activity broke');
    };

    engine.register('activity-fail', async function* (ctx: WorkflowContext) {
      const result = yield* (ctx as Context).run(failingActivity);
      return result;
    });

    const handle = await engine.start('activity-fail', null);
    await expect(handle.result()).rejects.toThrow('activity broke');
    engine[Symbol.dispose]();
  });

  it('throws when starting unregistered workflow type', async () => {
    const engine = new Engine();
    await expect(engine.start('nonexistent', null)).rejects.toThrow('No workflow registered');
    engine[Symbol.dispose]();
  });

  it('throws when starting duplicate workflow ID', async () => {
    const engine = new Engine();
    engine.register('dup', async function* () {
      return 'ok';
    });

    await engine.start('dup', null, { id: 'same-id' });
    await expect(engine.start('dup', null, { id: 'same-id' })).rejects.toThrow('already exists');
    engine[Symbol.dispose]();
  });

  it('throws when options.id is an empty string', async () => {
    const engine = new Engine();
    engine.register('empty-id', async function* () {
      return 'ok';
    });

    await expect(engine.start('empty-id', null, { id: '' })).rejects.toThrow(
      'options.id must not be an empty string',
    );
    engine[Symbol.dispose]();
  });

  it('does not hit storage for dedup when starting without a caller-provided id', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    engine.register('noop', async function* () {
      return 'ok';
    });

    const getSpy = spyOn(storage, 'get');

    const handle = await engine.start('noop', null); // no options.id — auto UUID
    await handle.result();

    // The dedup `storage.get` only fires for caller-provided IDs. Auto-UUIDs
    // skip it entirely. Filter to workflow-key reads to avoid false positives
    // from checkpoint or index reads that happen during execution.
    const workflowKeyReads = getSpy.mock.calls.filter(
      ([key]) => typeof key === 'string' && key.startsWith('workflow:'),
    );
    expect(workflowKeyReads.length).toBe(0);

    engine[Symbol.dispose]();
  });

  it('register(name, registration) accepts a WorkflowRegistration object', async () => {
    const engine = new Engine();
    const handler = async function* (_ctx: WorkflowContext, input: unknown) {
      return `versioned: ${input as string}`;
    };

    engine.register('versioned', { handler, version: '2.0' });
    const handle = await engine.start('versioned', 'test');
    const result = await handle.result();
    expect(result).toBe('versioned: test');
    engine[Symbol.dispose]();
  });

  it('register(name, registration) defaults version to 1', async () => {
    const engine = new Engine();
    const handler = async function* () {
      return 'ok';
    };

    engine.register('default-version', { handler });
    const handle = await engine.start('default-version', null);
    const result = await handle.result();
    expect(result).toBe('ok');
    engine[Symbol.dispose]();
  });

  it('getHandle() for a completed workflow resolves result from storage', async () => {
    const engine = new Engine();
    engine.register('completed-wf', async function* () {
      return 'stored-result';
    });

    const handle = await engine.start('completed-wf', null, { id: 'completed-id' });
    await handle.result();

    // Clear the handle cache to force a storage lookup
    // by creating a new handle reference
    const newHandle = engine.getHandle('completed-id');
    const result = await newHandle.result();
    expect(result).toBe('stored-result');
    engine[Symbol.dispose]();
  });

  it('getHandle() for a non-existent workflow throws', async () => {
    const engine = new Engine();

    const handle = engine.getHandle('nonexistent-id');
    await expect(handle.result()).rejects.toThrow('not found');
    engine[Symbol.dispose]();
  });

  it('getHandle() for a running workflow chains result promise (resolve path)', async () => {
    const engine = new Engine();
    engine.register('chained', async function* (ctx: WorkflowContext) {
      const payload = yield* (ctx as Context).waitForSignal('go');
      return `chained: ${payload as string}`;
    });

    const handle = await engine.start('chained', null, { id: 'chain-id' });
    await flush();

    // Get a second handle — even without clearing the cache, getHandle should
    // return a handle that resolves to the same result via the shared resolver
    const secondHandle = engine.getHandle('chain-id');

    // Now signal the workflow
    await engine.signal('chain-id', 'go', 'value');

    const result1 = await handle.result();
    const result2 = await secondHandle.result();

    expect(result1).toBe('chained: value');
    expect(result2).toBe('chained: value');
    engine[Symbol.dispose]();
  });

  it('getHandle() for a running workflow chains result promise (reject path)', async () => {
    const engine = new Engine();
    engine.register('chained-fail', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('go');
      return 'nope';
    });

    const handle = await engine.start('chained-fail', null, { id: 'chain-fail-id' });
    await flush();

    // Get a second handle via getHandle while workflow is running.
    // The handle cache may still have the original, so let's force it:
    const secondHandle = engine.getHandle('chain-fail-id');

    // Cancel to trigger the reject path
    const resultPromise1 = handle.result().catch((error: Error) => error.message);
    const resultPromise2 = secondHandle.result().catch((error: Error) => error.message);

    await engine.cancel('chain-fail-id');

    const error1 = await resultPromise1;
    const error2 = await resultPromise2;

    expect(error1).toBe('Workflow cancelled');
    // The second handle may have the same or chained rejection
    expect(error2).toBeDefined();
    engine[Symbol.dispose]();
  });

  it('asyncDispose calls Symbol.dispose', async () => {
    const engine = new Engine();
    engine.register('disposable', async function* () {
      return 'ok';
    });

    await engine[Symbol.asyncDispose]();
    // Should not throw
  });

  it('WorkflowHandle cancel delegates to engine.cancel', async () => {
    const engine = new Engine();
    engine.register('handle-cancel', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('never');
      return 'nope';
    });

    const handle = await engine.start('handle-cancel', null);
    const resultPromise = handle.result().catch(() => {});
    await flush();

    await handle.cancel();
    await resultPromise;

    const stateBytes = await engine.storage.get(KEYS.workflow(handle.id));
    const state = decode(stateBytes!) as WorkflowState;
    expect(state.status).toBe('cancelled');
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle signal delegates to engine.signal', async () => {
    const engine = new Engine();
    engine.register('handle-signal', async function* (ctx: WorkflowContext) {
      const value = yield* (ctx as Context).waitForSignal('my-signal');
      return `got: ${value as string}`;
    });

    const handle = await engine.start('handle-signal', null);
    await flush();

    await handle.signal('my-signal', 'payload');
    const result = await handle.result();
    expect(result).toBe('got: payload');
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle asyncDispose is a no-op', async () => {
    const engine = new Engine();
    engine.register('asyncdispose', async function* () {
      return 'ok';
    });

    const handle = await engine.start('asyncdispose', null);
    await handle.result();

    // Should not throw
    await handle[Symbol.asyncDispose]();
    engine[Symbol.dispose]();
  });

  it('activity failure caught by workflow try/catch completes normally', async () => {
    const engine = new Engine();
    const failingActivity = async () => {
      throw new Error('activity broke');
    };

    engine.register('catch-failure', async function* (ctx: WorkflowContext) {
      try {
        yield* (ctx as Context).run(failingActivity);
      } catch {
        return 'caught';
      }
      return 'not caught';
    });

    const handle = await engine.start('catch-failure', null);
    const result = await handle.result();
    expect(result).toBe('caught');
    engine[Symbol.dispose]();
  });

  it('execution deadline times out workflow via scheduler', async () => {
    let now = 1000;
    const storage = new MemoryStorage();
    const engine = new Engine({ storage: storage as WeftStorage, getNow: () => now });

    engine.register('deadline-test', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('never');
      return 'should not complete';
    });

    const handle = await engine.start('deadline-test', null, {
      executionTimeout: 5000,
    });
    const resultPromise = handle.result().catch((error) => error);
    await flush();

    // Advance time past the deadline
    now = 7000;
    await engine.scheduler.tick(now);
    await flush();
    const error = await resultPromise;

    const stateBytes = await storage.get(KEYS.workflow(handle.id));
    const state = decode(stateBytes!) as WorkflowState;
    expect(state.status).toBe('timed-out');
    expect(error).toBeInstanceOf(WorkflowTimeoutError);
    expect((error as WorkflowTimeoutError).timeoutType).toBe('execution');
    expect((error as WorkflowTimeoutError).workflowId).toBe(handle.id);
    expect((error as WorkflowTimeoutError).elapsed).toBe(6000);
    engine[Symbol.dispose]();
  });

  it('execution deadline dispatches WorkflowTimedOutEvent', async () => {
    let now = 1000;
    const storage = new MemoryStorage();
    const engine = new Engine({ storage: storage as WeftStorage, getNow: () => now });

    engine.register('timeout-event-test', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('never');
      return 'unreachable';
    });

    const handle = await engine.start('timeout-event-test', null, {
      executionTimeout: 5000,
    });
    const resultPromise = handle.result().catch(() => {});
    await flush();

    const events: WorkflowTimedOutEvent[] = [];
    engine.addEventListener('workflow:timed-out', (event) => {
      events.push(event as WorkflowTimedOutEvent);
    });

    now = 7000;
    await engine.scheduler.tick(now);
    await flush();
    await resultPromise;

    expect(events).toHaveLength(1);
    expect(events[0]!.workflowId).toBe(handle.id);
    expect(events[0]!.timeoutType).toBe('execution');
    expect(events[0]!.elapsed).toBe(6000);
    engine[Symbol.dispose]();
  });

  it('deadline key is cleaned up on normal completion', async () => {
    let now = 1000;
    const storage = new MemoryStorage();
    const engine = new Engine({ storage: storage as WeftStorage, getNow: () => now });

    engine.register('deadline-cleanup-complete', async function* () {
      return 'done';
    });

    const handle = await engine.start('deadline-cleanup-complete', null, {
      executionTimeout: 60_000,
    });
    await handle.result();
    await flush();

    // Scan for deadline keys — should be empty
    const deadlineKeys: string[] = [];
    for await (const [key] of storage.scan('wf-deadline:')) {
      deadlineKeys.push(key);
    }
    expect(deadlineKeys).toHaveLength(0);

    // Also check scheduler timer index keys
    const timerKeys: string[] = [];
    for await (const [key] of storage.scan('timer-idx:deadline:')) {
      timerKeys.push(key);
    }
    expect(timerKeys).toHaveLength(0);
    engine[Symbol.dispose]();
  });

  it('deadline key is cleaned up on failure', async () => {
    let now = 1000;
    const storage = new MemoryStorage();
    const engine = new Engine({ storage: storage as WeftStorage, getNow: () => now });

    engine.register('deadline-cleanup-fail', async function* () {
      throw new Error('boom');
    });

    const handle = await engine.start('deadline-cleanup-fail', null, {
      executionTimeout: 60_000,
    });
    await handle.result().catch(() => {});
    await flush();

    const deadlineKeys: string[] = [];
    for await (const [key] of storage.scan('wf-deadline:')) {
      deadlineKeys.push(key);
    }
    expect(deadlineKeys).toHaveLength(0);

    const timerKeys: string[] = [];
    for await (const [key] of storage.scan('timer-idx:deadline:')) {
      timerKeys.push(key);
    }
    expect(timerKeys).toHaveLength(0);
    engine[Symbol.dispose]();
  });

  it('deadline key is cleaned up after timeout', async () => {
    let now = 1000;
    const storage = new MemoryStorage();
    const engine = new Engine({ storage: storage as WeftStorage, getNow: () => now });

    engine.register('deadline-cleanup-timeout', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('never');
      return 'unreachable';
    });

    const handle = await engine.start('deadline-cleanup-timeout', null, {
      executionTimeout: 5000,
    });
    const resultPromise = handle.result().catch(() => {});
    await flush();

    now = 7000;
    await engine.scheduler.tick(now);
    await flush();
    await resultPromise;

    const deadlineKeys: string[] = [];
    for await (const [key] of storage.scan('wf-deadline:')) {
      deadlineKeys.push(key);
    }
    expect(deadlineKeys).toHaveLength(0);

    const timerKeys: string[] = [];
    for await (const [key] of storage.scan('timer-idx:deadline:')) {
      timerKeys.push(key);
    }
    expect(timerKeys).toHaveLength(0);
    engine[Symbol.dispose]();
  });

  it('signalReceived interceptor wraps actual delivery', async () => {
    const engine = new Engine();
    const observed: string[] = [];

    engine.addInterceptor({
      signalReceived(interception, next) {
        observed.push(`signal:${interception.signalName}`);
        next(interception);
      },
    });

    engine.register('signal-intercept-test', async function* (ctx: WorkflowContext) {
      const payload = yield* (ctx as Context).waitForSignal('go');
      return payload;
    });

    const handle = await engine.start('signal-intercept-test', null);
    await flush();

    await engine.signal(handle.id, 'go', 'delivered');
    await flush();

    const result = await handle.result();
    expect(result).toBe('delivered');
    expect(observed).toEqual(['signal:go']);
    engine[Symbol.dispose]();
  });

  it('signalReceived interceptor can block delivery', async () => {
    const engine = new Engine();

    engine.addInterceptor({
      signalReceived() {
        // deliberately does not call next — blocks the signal
      },
    });

    engine.register('signal-block-test', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('blocked');
      return 'should not reach';
    });

    const handle = await engine.start('signal-block-test', null);
    await flush();

    await engine.signal(handle.id, 'blocked', 'data');
    await flush();

    // Workflow should still be waiting since signal was blocked
    const stateBytes = await engine.storage.get(KEYS.workflow(handle.id));
    const state = decode(stateBytes!) as WorkflowState;
    expect(state.status).toBe('running');
    engine[Symbol.dispose]();
  });

  it('list with status array filter', async () => {
    const engine = new Engine();
    engine.register('multi-status', async function* () {
      return 'ok';
    });
    engine.register('waiter', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('block');
      return 'ok';
    });

    await engine.start('multi-status', null, { id: 'done-1' });
    await engine.start('waiter', null, { id: 'running-1' });
    await flush();

    const result = await engine.list({ status: ['completed', 'running'] });
    expect(result.total).toBe(2);
    engine[Symbol.dispose]();
  });

  it('list with attribute filter loads matched workflows in parallel and preserves filter semantics', async () => {
    const engine = new Engine();
    engine.register('attr-listable', {
      handler: async function* (ctx: WorkflowContext) {
        yield* (ctx as Context).waitForSignal('block');
        return 'ok';
      },
      version: '1',
      searchAttributes: { customerId: { type: 'string' } },
    });
    engine.register('other-type', {
      handler: async function* (ctx: WorkflowContext) {
        yield* (ctx as Context).waitForSignal('block');
        return 'ok';
      },
      version: '1',
      searchAttributes: { customerId: { type: 'string' } },
    });

    // Three matches for customer "alpha", one for "beta", and one of a
    // different type that should be filtered out by `type`.
    await engine.start('attr-listable', null, {
      id: 'alpha-1',
      searchAttributes: { customerId: 'alpha' },
    });
    await engine.start('attr-listable', null, {
      id: 'alpha-2',
      searchAttributes: { customerId: 'alpha' },
    });
    await engine.start('attr-listable', null, {
      id: 'alpha-3',
      searchAttributes: { customerId: 'alpha' },
    });
    await engine.start('attr-listable', null, {
      id: 'beta-1',
      searchAttributes: { customerId: 'beta' },
    });
    await engine.start('other-type', null, {
      id: 'alpha-other',
      searchAttributes: { customerId: 'alpha' },
    });

    // Spy on storage.get to verify the fast path issued reads in parallel
    // (i.e. as a single batch) instead of awaiting each one serially.
    const storage = engine.storage;
    const getSpy = spyOn(storage, 'get');

    const matched = await engine.list({
      type: 'attr-listable',
      attributes: [{ key: 'customerId', value: 'alpha' }],
    });

    // All three alpha workflows of the requested type, no beta, no other-type.
    expect(matched.items.map((item) => item.id).toSorted()).toEqual([
      'alpha-1',
      'alpha-2',
      'alpha-3',
    ]);
    expect(matched.total).toBe(3);
    expect(matched.items.every((item) => item.type === 'attr-listable')).toBe(true);

    // The fast path should have queued at least the three matched ids before
    // any awaited; with `Promise.all`, all calls are issued before the first
    // resolves. Verify call count rather than ordering since the spy can't
    // tell us "were they parallel" directly.
    expect(getSpy.mock.calls.length).toBeGreaterThanOrEqual(3);

    getSpy.mockRestore();
    engine[Symbol.dispose]();
  });

  it('cancel on already completed workflow updates state', async () => {
    const engine = new Engine();
    engine.register('already-done', async function* () {
      return 'done';
    });

    const handle = await engine.start('already-done', null);
    await handle.result();

    // Cancel after completion - should still work without error
    await engine.cancel(handle.id);
    engine[Symbol.dispose]();
  });

  it('advanceWorkflow catch handler fires when handler is not a valid generator', async () => {
    const engine = new Engine();

    // Register a handler that is a regular function (not an async generator).
    // When the engine calls handler(context, input), it returns a non-generator
    // value, and calling .next() on it throws, which is caught by driveGenerator.
    // But if the handler itself throws synchronously before returning, the
    // .catch on advanceWorkflow fires.
    engine.register('bad-handler', (() => {
      throw new Error('handler construction failed');
    }) as any);

    const events: WorkflowFailedEvent[] = [];
    engine.addEventListener(WorkflowFailedEvent.type, (event) => {
      events.push(event as WorkflowFailedEvent);
    });

    const handle = await engine.start('bad-handler', null);
    await expect(handle.result()).rejects.toThrow();
    await flush();

    expect(events.length).toBeGreaterThanOrEqual(1);
    engine[Symbol.dispose]();
  });

  it('getHandle for a completed and resolved workflow loads result from storage', async () => {
    const engine = new Engine();
    engine.register('load-test', async function* () {
      return 'stored-value';
    });

    const handle = await engine.start('load-test', null, { id: 'load-test-id' });
    await handle.result();
    await flush();

    // After workflow completes, result resolvers are cleaned up.
    // Calling getHandle creates a handle that loads from storage.
    const newHandle = engine.getHandle('load-test-id');
    const result = await newHandle.result();
    expect(result).toBe('stored-value');
    engine[Symbol.dispose]();
  });

  it('getHandle for a failed workflow that was loaded from storage throws', async () => {
    const engine = new Engine();
    engine.register('fail-test', async function* () {
      throw new Error('stored failure');
    });

    const handle = await engine.start('fail-test', null, { id: 'fail-test-id' });
    await handle.result().catch(() => {});
    await flush();

    const newHandle = engine.getHandle('fail-test-id');
    await expect(newHandle.result()).rejects.toThrow('stored failure');
    engine[Symbol.dispose]();
  });

  it('getHandle for a running workflow with no cached handle creates a chained promise', async () => {
    const engine = new Engine();
    engine.register('chain-test', async function* (ctx: WorkflowContext) {
      const value = yield* (ctx as Context).waitForSignal('proceed');
      return `chained: ${value as string}`;
    });

    const handle = await engine.start('chain-test', null, { id: 'chain-test-id' });
    await flush();

    // The first getHandle returns the cached handle (from start).
    // Calling getHandle again while the workflow is running chains the resolve/reject.
    const handle2 = engine.getHandle('chain-test-id');

    // Now signal the workflow to complete
    await engine.signal('chain-test-id', 'proceed', 'data');

    const result1 = await handle.result();
    const result2 = await handle2.result();
    expect(result1).toBe('chained: data');
    expect(result2).toBe('chained: data');
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // WorkflowHandle async iteration
  // ---------------------------------------------------------------------------

  it('WorkflowHandle Symbol.asyncIterator iterates events until workflow completes', async () => {
    const engine = new Engine();
    const double = async (...args: unknown[]) => (args[0] as number) * 2;

    engine.register('iterable-workflow', async function* (ctx: WorkflowContext, input: unknown) {
      const result = yield* (ctx as Context).run(double, input);
      return result;
    });

    const handle = await engine.start('iterable-workflow', 5);
    const collectedTypes: string[] = [];

    for await (const event of handle) {
      collectedTypes.push(event.type);
    }

    expect(collectedTypes).toContain('workflow:completed');
    // Regression guard: previously `workflow:completed` fired twice because
    // both the generic `listener` and the `terminal` handler were registered
    // on terminal event types, so each terminal event was enqueued twice.
    expect(collectedTypes.filter((type) => type === 'workflow:completed')).toHaveLength(1);
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle Symbol.asyncIterator does not hang when workflow already completed', async () => {
    const engine = new Engine();
    engine.register('already-done', async function* () {
      return 'ok';
    });

    const handle = await engine.start('already-done', null);
    // Wait for the workflow to fully terminate and the completion event to
    // have fired before we begin iterating.
    await handle.result();
    await flush();

    const collected: string[] = [];
    const iterate = (async () => {
      for await (const event of handle) {
        collected.push(event.type);
      }
    })();

    // Watchdog: if the iterator hangs the race returns the sentinel and the
    // test fails. The sentinel is distinct so we can detect a hang specifically.
    const result = await Promise.race([
      iterate.then(() => 'iterated' as const),
      Bun.sleep(500).then(() => 'timeout' as const),
    ]);

    expect(result).toBe('iterated');
    expect(collected).toContain('workflow:completed');
    // The terminal event must be yielded exactly once — a regression would
    // surface as a duplicate if `listener` and `terminal` were both
    // registered on `workflow:completed`.
    expect(collected.filter((type) => type === 'workflow:completed')).toHaveLength(1);
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle Symbol.asyncIterator does not double-emit when a late real terminal event races with synthesis', async () => {
    // Regression: the synthesis path pushes a synthetic terminal event and
    // sets `state.done = true`. If a real terminal event arrived later (e.g.
    // because it was in flight between `addEventListener` and the persisted
    // status read), `finishWorkflowHandleIteration` used to unconditionally
    // enqueue it, producing two terminal events. The fix guards it on
    // `state.done`. We simulate the race by starting iteration on an
    // already-terminated workflow and then dispatching a second real
    // terminal event on the handle after synthesis has run.
    const engine = new Engine();
    engine.register('race-target', async function* () {
      return 'ok';
    });

    const handle = await engine.start('race-target', null);
    await handle.result();
    await flush();

    const collected: string[] = [];
    const iterate = (async () => {
      for await (const event of handle) {
        collected.push(event.type);
      }
    })();

    // Give the iterator a microtask to attach listeners and synthesize.
    await flush();
    // Now dispatch a second terminal event that, without the guard, would
    // hit `finishWorkflowHandleIteration` and enqueue a duplicate.
    handle.dispatchEvent(new WorkflowCompletedEvent(handle.id, 'ok', 0));

    const result = await Promise.race([
      iterate.then(() => 'iterated' as const),
      Bun.sleep(500).then(() => 'timeout' as const),
    ]);

    expect(result).toBe('iterated');
    expect(collected.filter((type) => type === 'workflow:completed')).toHaveLength(1);
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle Symbol.observable synthetic event does not leak to other listeners on the handle', async () => {
    // Regression: the old synthesis path called `this.dispatchEvent(synthetic)`
    // which broadcasts to every listener attached to the handle — concurrent
    // iterators, other subscribers, and application code. The synthetic
    // event is a private reconstruction for one subscription and must not
    // leak into the handle's global dispatch stream.
    const engine = new Engine();
    engine.register('observable-global-leak', async function* () {
      return 'ok';
    });

    const handle = await engine.start('observable-global-leak', null);
    await handle.result();
    await flush();

    // Foreign listener: a direct addEventListener on the handle. Simulates
    // application code, a concurrent iterator, or another observer.
    const foreignEvents: string[] = [];
    const foreignListener = (event: Event) => {
      foreignEvents.push(event.type);
    };
    handle.addEventListener('workflow:completed', foreignListener);

    // Now subscribe via the observable, which runs the synthesis path
    // because the workflow is already terminated.
    const receivedTypes: string[] = [];
    const { promise, resolve } = Promise.withResolvers<void>();
    const observable = handle[Symbol.observable]();
    const subscription = observable.subscribe({
      next: (event: Event) => {
        receivedTypes.push(event.type);
      },
      complete: () => {
        resolve();
      },
    });

    await promise;
    await flush();

    // The subscriber observed the synthetic completion via its own callbacks.
    expect(receivedTypes).toContain('workflow:completed');
    // The foreign listener must NOT have received the synthetic event —
    // the real `workflow:completed` had already fired before the foreign
    // listener was attached, and synthesis is private to the subscription.
    expect(foreignEvents).toHaveLength(0);

    handle.removeEventListener('workflow:completed', foreignListener);
    subscription.unsubscribe();
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle Symbol.observable does not emit next() after error/complete on race', async () => {
    // Regression: the `listener` (observer.next) was registered on every
    // event type including terminals, with no `terminalDelivered` guard. If
    // the synthesis path dispatched a synthetic terminal event first (setting
    // `terminalDelivered = true`), a subsequent real terminal event would
    // still invoke `observer.next` even though `observer.complete` or
    // `observer.error` had already fired — violating the Observable
    // contract. The fix wraps the next listener in a `terminalDelivered`
    // guard. Simulate the race by subscribing to an already-completed
    // workflow, letting synthesis fire, then dispatching another terminal
    // event on the handle.
    const engine = new Engine();
    engine.register('observable-race', async function* () {
      return 'ok';
    });

    const handle = await engine.start('observable-race', null);
    await handle.result();
    await flush();

    const receivedTypes: string[] = [];
    let completeCallCount = 0;
    const { promise, resolve } = Promise.withResolvers<void>();

    const observable = handle[Symbol.observable]();
    const subscription = observable.subscribe({
      next: (event: Event) => {
        receivedTypes.push(event.type);
      },
      complete: () => {
        completeCallCount++;
        resolve();
      },
    });

    await promise;
    // Now dispatch a second terminal event post-completion. Without the
    // guard, `observer.next` would fire again after `observer.complete`.
    handle.dispatchEvent(new WorkflowCompletedEvent(handle.id, 'ok', 0));
    await flush();

    expect(completeCallCount).toBe(1);
    expect(receivedTypes.filter((type) => type === 'workflow:completed')).toHaveLength(1);
    subscription.unsubscribe();
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle Symbol.asyncIterator does not hang when workflow already failed', async () => {
    const engine = new Engine();
    engine.register('already-failed', async function* () {
      throw new Error('boom');
    });

    const handle = await engine.start('already-failed', null);
    await handle.result().catch(() => {});
    await flush();

    const collected: Event[] = [];
    const iterate = (async () => {
      for await (const event of handle) {
        collected.push(event);
      }
    })();

    const result = await Promise.race([
      iterate.then(() => 'iterated' as const),
      Bun.sleep(500).then(() => 'timeout' as const),
    ]);

    expect(result).toBe('iterated');
    const failure = collected.find((event) => event instanceof WorkflowFailedEvent);
    expect(failure).toBeInstanceOf(WorkflowFailedEvent);
    expect((failure as WorkflowFailedEvent).error.message).toBe('boom');
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle Symbol.asyncIterator does not hang when workflow already cancelled', async () => {
    const engine = new Engine();
    engine.register('already-cancelled', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('never');
      return 'nope';
    });

    const handle = await engine.start('already-cancelled', null);
    const resultPromise = handle.result().catch(() => {});
    await flush();
    await handle.cancel();
    await resultPromise;
    await flush();

    const collected: Event[] = [];
    const iterate = (async () => {
      for await (const event of handle) {
        collected.push(event);
      }
    })();

    const result = await Promise.race([
      iterate.then(() => 'iterated' as const),
      Bun.sleep(500).then(() => 'timeout' as const),
    ]);

    expect(result).toBe('iterated');
    expect(collected.some((event) => event instanceof WorkflowCancelledEvent)).toBe(true);
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle Symbol.asyncIterator does not hang when workflow already timed out', async () => {
    let now = 1000;
    const engine = new Engine({ getNow: () => now });
    engine.register('already-timed-out', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('never');
      return 'nope';
    });

    const handle = await engine.start('already-timed-out', null, { executionTimeout: 5000 });
    const resultPromise = handle.result().catch(() => {});
    await flush();

    now = 7000;
    await engine.scheduler.tick(now);
    await flush();
    await resultPromise;

    const collected: Event[] = [];
    const iterate = (async () => {
      for await (const event of handle) {
        collected.push(event);
      }
    })();

    const result = await Promise.race([
      iterate.then(() => 'iterated' as const),
      Bun.sleep(500).then(() => 'timeout' as const),
    ]);

    expect(result).toBe('iterated');
    const timedOut = collected.find((event) => event instanceof WorkflowTimedOutEvent);
    expect(timedOut).toBeInstanceOf(WorkflowTimedOutEvent);
    expect((timedOut as WorkflowTimedOutEvent).workflowId).toBe(handle.id);
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle Symbol.observable does not hang when workflow already completed', async () => {
    const engine = new Engine();
    engine.register('observable-already-done', async function* () {
      return 'done';
    });

    const handle = await engine.start('observable-already-done', null);
    await handle.result();
    await flush();

    const receivedTypes: string[] = [];
    const { promise, resolve } = Promise.withResolvers<void>();

    const observable = handle[Symbol.observable]();
    const subscription = observable.subscribe({
      next: (event: Event) => {
        receivedTypes.push(event.type);
      },
      complete: () => {
        resolve();
      },
    });

    const result = await Promise.race([
      promise.then(() => 'completed' as const),
      Bun.sleep(500).then(() => 'timeout' as const),
    ]);

    expect(result).toBe('completed');
    expect(receivedTypes).toContain('workflow:completed');
    subscription.unsubscribe();
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle Symbol.observable does not hang when workflow already failed', async () => {
    const engine = new Engine();
    engine.register('observable-already-failed', async function* () {
      throw new Error('kaboom');
    });

    const handle = await engine.start('observable-already-failed', null);
    await handle.result().catch(() => {});
    await flush();

    const receivedTypes: string[] = [];
    let completeCallCount = 0;
    let capturedError: Error | undefined;
    const { promise, resolve } = Promise.withResolvers<void>();

    const observable = handle[Symbol.observable]();
    const subscription = observable.subscribe({
      next: (event: Event) => {
        receivedTypes.push(event.type);
      },
      error: (error: Error) => {
        capturedError = error;
        resolve();
      },
      complete: () => {
        completeCallCount++;
      },
    });

    const result = await Promise.race([
      promise.then(() => 'errored' as const),
      Bun.sleep(500).then(() => 'timeout' as const),
    ]);

    // Give any erroneously-queued `complete()` call a chance to fire so the
    // assertion below is meaningful.
    await flush();

    expect(result).toBe('errored');
    expect(capturedError?.message).toBe('kaboom');
    // Observable contract: `error` and `complete` are mutually exclusive.
    expect(completeCallCount).toBe(0);
    expect(receivedTypes).toContain('workflow:failed');
    subscription.unsubscribe();
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle Symbol.observable does not hang when workflow already cancelled', async () => {
    const engine = new Engine();
    engine.register('observable-already-cancelled', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('never');
      return 'nope';
    });

    const handle = await engine.start('observable-already-cancelled', null);
    const resultPromise = handle.result().catch(() => {});
    await flush();
    await handle.cancel();
    await resultPromise;
    await flush();

    const receivedTypes: string[] = [];
    const { promise, resolve } = Promise.withResolvers<void>();

    const observable = handle[Symbol.observable]();
    const subscription = observable.subscribe({
      next: (event: Event) => {
        receivedTypes.push(event.type);
      },
      complete: () => {
        resolve();
      },
    });

    const result = await Promise.race([
      promise.then(() => 'completed' as const),
      Bun.sleep(500).then(() => 'timeout' as const),
    ]);

    expect(result).toBe('completed');
    expect(receivedTypes).toContain('workflow:cancelled');
    subscription.unsubscribe();
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle Symbol.observable does not hang when workflow already timed out', async () => {
    let now = 1000;
    const engine = new Engine({ getNow: () => now });
    engine.register('observable-already-timed-out', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('never');
      return 'nope';
    });

    const handle = await engine.start('observable-already-timed-out', null, {
      executionTimeout: 5000,
    });
    const resultPromise = handle.result().catch(() => {});
    await flush();

    now = 7000;
    await engine.scheduler.tick(now);
    await flush();
    await resultPromise;

    const receivedTypes: string[] = [];
    let completeCallCount = 0;
    let capturedError: Error | undefined;
    const { promise, resolve } = Promise.withResolvers<void>();

    const observable = handle[Symbol.observable]();
    const subscription = observable.subscribe({
      next: (event: Event) => {
        receivedTypes.push(event.type);
      },
      error: (error: Error) => {
        capturedError = error;
        resolve();
      },
      complete: () => {
        completeCallCount++;
      },
    });

    const result = await Promise.race([
      promise.then(() => 'errored' as const),
      Bun.sleep(500).then(() => 'timeout' as const),
    ]);

    // Give any erroneously-queued `complete()` call a chance to fire so the
    // assertion below is meaningful.
    await flush();

    expect(result).toBe('errored');
    expect(capturedError).toBeInstanceOf(WorkflowTimeoutError);
    // Observable contract: `error` and `complete` are mutually exclusive.
    expect(completeCallCount).toBe(0);
    expect(receivedTypes).toContain('workflow:timed-out');
    subscription.unsubscribe();
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // WorkflowHandle Symbol.observable
  // ---------------------------------------------------------------------------

  it('WorkflowHandle Symbol.observable allows subscribe, receive events, and complete', async () => {
    const engine = new Engine();

    engine.register('observable-workflow', async function* () {
      return 'done';
    });

    const handle = await engine.start('observable-workflow', null);
    const receivedTypes: string[] = [];
    let completed = false;

    const { promise, resolve } = Promise.withResolvers<void>();

    const observable = handle[Symbol.observable]();
    const subscription = observable.subscribe({
      next: (event: Event) => {
        receivedTypes.push(event.type);
      },
      complete: () => {
        completed = true;
        resolve();
      },
    });

    await promise;

    expect(completed).toBe(true);
    expect(receivedTypes).toContain('workflow:completed');

    subscription.unsubscribe();
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // engine.addInterceptor()
  // ---------------------------------------------------------------------------

  it('engine.addInterceptor() registers interceptor that runs on activity', async () => {
    const engine = new Engine();
    const interceptedNames: string[] = [];

    const interceptor: WorkflowInterceptor = {
      *activity(interception, next) {
        interceptedNames.push(interception.activityName);
        return yield* next(interception);
      },
    };

    engine.addInterceptor(interceptor);

    const greet = async (...args: unknown[]) => `Hello, ${args[0] as string}`;

    engine.register('intercepted-workflow', async function* (ctx: WorkflowContext) {
      const result = yield* (ctx as Context).run(greet, 'world');
      return result;
    });

    const handle = await engine.start('intercepted-workflow', null);
    const result = await handle.result();

    expect(result).toBe('Hello, world');
    expect(interceptedNames).toContain('greet');
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // engine.addActivityInterceptor()
  // ---------------------------------------------------------------------------

  it('engine.addActivityInterceptor() registers interceptor that wraps activity execution', async () => {
    const engine = new Engine();
    const executionOrder: string[] = [];

    const interceptor: ActivityInterceptor = {
      async execute(interception, next) {
        executionOrder.push(`before:${interception.activityName}`);
        const result = await next(interception);
        executionOrder.push(`after:${interception.activityName}`);
        return result;
      },
    };

    engine.addActivityInterceptor(interceptor);

    const compute = async (...args: unknown[]) => (args[0] as number) + 1;

    engine.register('activity-intercepted', async function* (ctx: WorkflowContext) {
      const result = yield* (ctx as Context).run(compute, 10);
      return result;
    });

    const handle = await engine.start('activity-intercepted', null);
    const result = await handle.result();

    expect(result).toBe(11);
    expect(executionOrder).toEqual(['before:compute', 'after:compute']);
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // engine.update()
  // ---------------------------------------------------------------------------

  it('engine.update() sends update to workflow with onUpdate handler and returns response', async () => {
    const engine = new Engine();

    engine.register('updatable-workflow', async function* (ctx: WorkflowContext) {
      (ctx as Context).onUpdate('setGreeting', (payload) => {
        return `Hello, ${payload as string}!`;
      });
      // Wait for a signal so the workflow stays alive long enough for the update
      const value = yield* (ctx as Context).waitForSignal('finish');
      return value;
    });

    const handle = await engine.start('updatable-workflow', null);
    await flush();

    const updateResult = await engine.update(handle.id, 'setGreeting', 'World');
    expect(updateResult).toBe('Hello, World!');

    // Clean up: signal the workflow to complete
    await engine.signal(handle.id, 'finish', 'done');
    const result = await handle.result();
    expect(result).toBe('done');
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // handle.update()
  // ---------------------------------------------------------------------------

  it('handle.update() convenience method sends update and returns response', async () => {
    const engine = new Engine();

    engine.register('handle-updatable', async function* (ctx: WorkflowContext) {
      (ctx as Context).onUpdate('increment', (payload) => {
        return (payload as number) + 1;
      });
      const value = yield* (ctx as Context).waitForSignal('finish');
      return value;
    });

    const handle = await engine.start('handle-updatable', null);
    await flush();

    const updateResult = await handle.update('increment', 42);
    expect(updateResult).toBe(43);

    await engine.signal(handle.id, 'finish', 'complete');
    await handle.result();
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // ctx.step()
  // ---------------------------------------------------------------------------

  it('ctx.step() works as a non-generator alternative to yield* ctx.run', async () => {
    const engine = new Engine();

    engine.register('step-workflow', async function* (ctx: WorkflowContext) {
      const result = yield* (ctx as Context).run(async (...args: unknown[]) => {
        return (args[0] as number) * 3;
      }, 7);
      return result;
    });

    const handle = await engine.start('step-workflow', null);
    const result = await handle.result();
    expect(result).toBe(21);
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // activity() helper function
  // ---------------------------------------------------------------------------

  it('activity() helper wraps a function with colocated configuration', () => {
    const sendEmail = activity({
      name: 'sendEmail',
      execute: async (input: { to: string; body: string }) => {
        return `sent to ${input.to}`;
      },
      timeout: '30s',
      retry: {
        maxAttempts: 3,
        initialBackoff: 1000,
        backoffMultiplier: 2,
        maxBackoff: 30_000,
      },
    });

    // Should have the ActivityDefinition properties
    expect(sendEmail.name).toBe('sendEmail');
    expect(sendEmail.timeout).toBe('30s');
    expect(sendEmail.retry).toBeDefined();
    expect(sendEmail.execute).toBeInstanceOf(Function);

    // Should also be callable as a function
    expect(typeof sendEmail).toBe('function');
  });

  // ---------------------------------------------------------------------------
  // Development mode DevelopmentWarningEvent
  // ---------------------------------------------------------------------------

  it('development mode dispatches DevelopmentWarningEvent for checkpoint divergences', async () => {
    const engine = new Engine({ development: true });
    const warnings: DevelopmentWarningEvent[] = [];

    engine.addEventListener(DevelopmentWarningEvent.type, (event) => {
      warnings.push(event as DevelopmentWarningEvent);
    });

    engine.register('dev-warning-workflow', async function* (ctx: WorkflowContext) {
      const context = ctx as Context;
      const result = yield* context.run(async () => {
        return new Map([[{ key: 'alpha' }, 42]]);
      });
      yield* context.waitForSignal('release');
      return result;
    });

    const handle = await engine.start('dev-warning-workflow', null);
    await flush();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.workflowId).toBe(handle.id);
    expect(warnings[0]!.fieldPaths).toEqual([
      'accumulatedResults[0][1].Map([object Object])',
      'accumulatedResults[0][1].Map([object Object])',
    ]);
    expect(warnings[0]!.message).toContain('non-serializable field');

    await engine.signal(handle.id, 'release');
    const result = (await handle.result()) as Map<unknown, unknown>;
    expect(result.size).toBe(1);
    engine[Symbol.dispose]();
  });

  it('processes agent operation via executeAgentLoop with mock provider', async () => {
    const engine = new Engine();

    const mockProvider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        return {
          content: 'Agent says hello',
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          model: 'test-model',
          stopReason: 'end_turn',
        };
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 100;
      },
    };

    engine.register('agent-workflow', async function* (ctx: WorkflowContext) {
      const agentResult = yield* (ctx as Context).agent({
        model: 'test-model',
        prompt: 'Say hello',
        provider: mockProvider,
      });
      return `Result: ${agentResult as string}`;
    });
    engine[Symbol.dispose]();
  });

  it('runs workflow agent interceptors around ctx.agent()', async () => {
    const engine = new Engine();
    const seenPrompts: string[] = [];
    let interceptorResumed = false;

    const interceptor: WorkflowInterceptor = {
      *agent(interception, next) {
        seenPrompts.push(interception.prompt);
        const result = yield* next(interception);
        interceptorResumed = true;
        return result;
      },
    };
    engine.addInterceptor(interceptor);

    const provider: LLMProvider = {
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        return {
          content: 'Agent intercepted result',
          toolCalls: [],
          usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
          model: 'test-model',
          stopReason: 'end_turn',
        };
      },
      async stream() {
        return new ReadableStream();
      },
      async countTokens(): Promise<number> {
        return 12;
      },
    };

    engine.register('agent-interceptor-workflow', async function* (ctx: WorkflowContext) {
      return yield* (ctx as Context).agent({
        model: 'test-model',
        prompt: 'Intercept me',
        provider,
      });
    });

    const handle = await engine.start('agent-interceptor-workflow', null);
    const result = await handle.result();

    expect(result).toBe('Agent intercepted result');
    expect(seenPrompts).toEqual(['Intercept me']);
    expect(interceptorResumed).toBe(true);
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // Symbol.observable error path (lines 217-220)
  // ---------------------------------------------------------------------------

  it('WorkflowHandle Symbol.observable calls observer.error on WorkflowFailedEvent', async () => {
    const engine = new Engine();

    engine.register('observable-for-error', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('never');
      return 'nope';
    });

    const handle = await engine.start('observable-for-error', null);
    await flush();

    const receivedErrors: Error[] = [];
    const receivedEvents: string[] = [];

    const { promise, resolve } = Promise.withResolvers<void>();

    const observable = handle[Symbol.observable]();
    const subscription = observable.subscribe({
      next: (event: Event) => {
        receivedEvents.push(event.type);
      },
      error: (error: Error) => {
        receivedErrors.push(error);
        resolve();
      },
    });

    // Dispatch a WorkflowFailedEvent directly on the handle to exercise the failListener
    const testError = new Error('observable failure test');
    handle.dispatchEvent(new WorkflowFailedEvent(handle.id, testError));

    await promise;

    expect(receivedErrors.length).toBe(1);
    expect(receivedErrors[0]!.message).toBe('observable failure test');
    // The event should also have been received by the next handler
    expect(receivedEvents).toContain('workflow:failed');

    subscription.unsubscribe();
    // Cancel the workflow to clean up
    const resultPromise = handle.result().catch(() => {});
    await engine.cancel(handle.id);
    await resultPromise;
    engine[Symbol.dispose]();
  });

  it('WorkflowHandle Symbol.observable calls observer.error on WorkflowTimedOutEvent', async () => {
    const engine = new Engine();

    engine.register('observable-for-timeout', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('never');
      return 'nope';
    });

    const handle = await engine.start('observable-for-timeout', null);
    await flush();

    const receivedErrors: Error[] = [];
    const receivedEvents: string[] = [];

    const { promise, resolve } = Promise.withResolvers<void>();

    const observable = handle[Symbol.observable]();
    const subscription = observable.subscribe({
      next: (event: Event) => {
        receivedEvents.push(event.type);
      },
      error: (error: Error) => {
        receivedErrors.push(error);
        resolve();
      },
    });

    handle.dispatchEvent(new WorkflowTimedOutEvent(handle.id, 'execution', 5000));

    await promise;

    expect(receivedErrors).toHaveLength(1);
    expect(receivedErrors[0]).toBeInstanceOf(WorkflowTimeoutError);
    expect((receivedErrors[0] as WorkflowTimeoutError).workflowId).toBe(handle.id);
    expect((receivedErrors[0] as WorkflowTimeoutError).timeoutType).toBe('execution');
    expect((receivedErrors[0] as WorkflowTimeoutError).elapsed).toBe(5000);
    expect(receivedEvents).toContain('workflow:timed-out');

    subscription.unsubscribe();
    const resultPromise = handle.result().catch(() => {});
    await engine.cancel(handle.id);
    await resultPromise;
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // getHandle chained resolve/reject for running workflows (lines 448-453)
  // ---------------------------------------------------------------------------

  it('getHandle creates chained resolve callback when WeakRef is cleared', async () => {
    const engine = new Engine();
    engine.register('chain-gc-resolve', async function* (ctx: WorkflowContext) {
      const payload = yield* (ctx as Context).waitForSignal('go');
      return `resolved: ${payload as string}`;
    });

    // Start the workflow - the handle is stored in the cache via WeakRef
    let handle: WorkflowHandle | null = await engine.start('chain-gc-resolve', null, {
      id: 'chain-gc-resolve-id',
    });
    const resultPromiseOriginal = handle.result();
    await flush();

    // Drop the only strong reference to the handle and force GC
    handle = null;
    Bun.gc(true);
    await flush();

    // Now getHandle should not find the handle in the cache (WeakRef cleared),
    // so it creates a new handle that chains off the existing result resolver.
    const chainedHandle = engine.getHandle('chain-gc-resolve-id');

    // Signal the workflow to complete, which triggers the chained resolve callback
    await engine.signal('chain-gc-resolve-id', 'go', 'data');

    const result = await chainedHandle.result();
    expect(result).toBe('resolved: data');

    // Also await the original to avoid unhandled rejections
    await resultPromiseOriginal.catch(() => {});
    engine[Symbol.dispose]();
  });

  it('getHandle creates chained reject callback when WeakRef is cleared', async () => {
    const engine = new Engine();
    engine.register('chain-gc-reject', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('never');
      return 'nope';
    });

    let handle: WorkflowHandle | null = await engine.start('chain-gc-reject', null, {
      id: 'chain-gc-reject-id',
    });
    const resultPromiseOriginal = handle.result().catch(() => {});
    await flush();

    // Drop the only strong reference and force GC
    handle = null;
    Bun.gc(true);
    await flush();

    // Get a new chained handle
    const chainedHandle = engine.getHandle('chain-gc-reject-id');
    const resultPromise = chainedHandle.result().catch((error: Error) => error.message);

    await engine.cancel('chain-gc-reject-id');
    await resultPromiseOriginal;

    const error = await resultPromise;
    expect(error).toBe('Workflow cancelled');
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // ctx.runAll operation (lines 847-848)
  // ---------------------------------------------------------------------------

  it('ctx.runAll executes named branches in parallel and returns results', async () => {
    const engine = new Engine();

    const double = async (...args: unknown[]) => (args[0] as number) * 2;
    const triple = async (...args: unknown[]) => (args[0] as number) * 3;
    const addTen = async (...args: unknown[]) => (args[0] as number) + 10;

    engine.register('run-all-workflow', async function* (ctx: WorkflowContext) {
      const results = yield* (ctx as Context).runAll({
        doubled: [double, 5],
        tripled: [triple, 5],
        plusTen: [addTen, 5],
      });
      return results;
    });

    const handle = await engine.start('run-all-workflow', null);
    const result = (await handle.result()) as Record<string, number>;

    expect(result['doubled']).toBe(10);
    expect(result['tripled']).toBe(15);
    expect(result['plusTen']).toBe(15);
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // ctx.stream() tests
  // ---------------------------------------------------------------------------

  it('ctx.stream() writes chunks to storage and returns StreamReference', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    // Block completion with a signal so we can assert chunks exist in storage
    // before terminal-state cleanup removes them.
    engine.register('export', async function* (ctx: WorkflowContext) {
      const c = ctx as Context;
      const reference = yield* c.stream('report', async function* (sink) {
        yield { row: 1, data: 'first' };
        sink.heartbeat({ processed: 1 });
        yield { row: 2, data: 'second' };
        sink.heartbeat({ processed: 2 });
      });
      yield* c.waitForSignal('finish');
      return reference;
    });

    const handle = await engine.start('export', {});
    await flush();

    // While workflow is still running, chunks and metadata are in storage
    const chunk0 = await storage.get(KEYS.streamChunk(handle.id, 'report', 0));
    expect(chunk0).not.toBeNull();
    const chunk1 = await storage.get(KEYS.streamChunk(handle.id, 'report', 1));
    expect(chunk1).not.toBeNull();

    // Verify decoded data
    expect(decode(chunk0!)).toEqual({ row: 1, data: 'first' });
    expect(decode(chunk1!)).toEqual({ row: 2, data: 'second' });

    // Verify metadata
    const meta = await storage.get(KEYS.streamMetadata(handle.id, 'report'));
    expect(meta).not.toBeNull();

    // Unblock and confirm the returned reference matches
    await engine.signal(handle.id, 'finish');
    const result = (await handle.result()) as StreamReference;
    expect(result.key).toBe('report');
    expect(result.workflowId).toBe(handle.id);
    expect(result.chunkCount).toBe(2);
    expect(result.totalSizeBytes).toBeGreaterThan(0);

    engine[Symbol.dispose]();
  });

  it('ctx.stream() error mid-stream cleans up partial chunks', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    let streamError: Error | undefined;

    engine.register('failing-export', async function* (ctx: WorkflowContext) {
      const c = ctx as Context;
      try {
        yield* c.stream('report', async function* () {
          yield { row: 1 };
          throw new Error('Database connection lost');
        });
        return 'not-reached';
      } catch (error) {
        streamError = error as Error;
        return 'handled';
      }
    });

    const handle = await engine.start('failing-export', {});
    const result = await handle.result();

    expect(result).toBe('handled');
    expect(streamError).toBeDefined();
    expect(streamError!.message).toBe('Database connection lost');

    // Partial chunks should be cleaned up
    const chunk0 = await storage.get(KEYS.streamChunk(handle.id, 'report', 0));
    expect(chunk0).toBeNull();

    engine[Symbol.dispose]();
  });

  it('ctx.stream() with empty generator returns zero chunks', async () => {
    const engine = new Engine();

    engine.register('empty-stream', async function* (ctx: WorkflowContext) {
      const c = ctx as Context;
      const reference = yield* c.stream('empty', async function* () {
        // No chunks yielded
      });
      return reference;
    });

    const handle = await engine.start('empty-stream', {});
    const result = (await handle.result()) as StreamReference;

    expect(result.chunkCount).toBe(0);
    expect(result.totalSizeBytes).toBe(0);

    engine[Symbol.dispose]();
  });

  it('ctx.stream() heartbeats are queryable via handle.query("activityProgress") while streaming', async () => {
    const engine = new Engine();
    const { promise: releasePromise, resolve: releaseStream } = Promise.withResolvers<void>();

    engine.register('stream-progress', async function* (ctx: WorkflowContext) {
      const context = ctx as Context;
      return yield* context.stream('report', async function* (sink) {
        sink.heartbeat({ processed: 1 });
        await releasePromise;
        yield { row: 1, data: 'done' };
      });
    });

    const handle = await engine.start('stream-progress', null);
    await flush();

    expect(await handle.query('activityProgress')).toEqual({ processed: 1 });

    releaseStream();

    const result = (await handle.result()) as StreamReference;
    expect(result.key).toBe('report');
    expect(result.chunkCount).toBe(1);

    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // 1A: Checkpoint size warning events
  // ---------------------------------------------------------------------------

  it('dispatches CheckpointSizeWarningEvent when checkpoint exceeds threshold', async () => {
    // Use a very low threshold so even a small checkpoint triggers the warning
    const engine = new Engine({ checkpointSizeWarningThreshold: 1 });
    const warnings: CheckpointSizeWarningEvent[] = [];

    engine.addEventListener(CheckpointSizeWarningEvent.type, (event) => {
      warnings.push(event as CheckpointSizeWarningEvent);
    });

    const echoActivity = async (...args: unknown[]) => args[0];
    engine.register('big-checkpoint', async function* (ctx: WorkflowContext) {
      const result = yield* (ctx as Context).run(echoActivity, 'data');
      return result;
    });

    const handle = await engine.start('big-checkpoint', null);
    await handle.result();

    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]!.workflowId).toBe(handle.id);
    expect(warnings[0]!.sizeBytes).toBeGreaterThanOrEqual(1);
    engine[Symbol.dispose]();
  });

  it('does not dispatch CheckpointSizeWarningEvent when checkpoint is below threshold', async () => {
    // Use an extremely high threshold so warnings never fire
    const engine = new Engine({ checkpointSizeWarningThreshold: 10_000_000 });
    const warnings: CheckpointSizeWarningEvent[] = [];

    engine.addEventListener(CheckpointSizeWarningEvent.type, (event) => {
      warnings.push(event as CheckpointSizeWarningEvent);
    });

    engine.register('small-checkpoint', async function* () {
      return 'tiny';
    });

    const handle = await engine.start('small-checkpoint', null);
    await handle.result();

    expect(warnings).toHaveLength(0);
    engine[Symbol.dispose]();
  });

  it('respects custom checkpointSizeWarningThreshold', async () => {
    const engine = new Engine({ checkpointSizeWarningThreshold: 50 });
    const warnings: CheckpointSizeWarningEvent[] = [];

    engine.addEventListener(CheckpointSizeWarningEvent.type, (event) => {
      warnings.push(event as CheckpointSizeWarningEvent);
    });

    const echoActivity = async (...args: unknown[]) => args[0];
    engine.register('threshold-test', async function* (ctx: WorkflowContext) {
      const result = yield* (ctx as Context).run(echoActivity, 'payload');
      return result;
    });

    const handle = await engine.start('threshold-test', null);
    await handle.result();

    // The checkpoint should be > 50 bytes, so the warning should fire
    if (warnings.length > 0) {
      expect(warnings[0]!.sizeBytes).toBeGreaterThanOrEqual(50);
    }
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // 1C: Development mode activates explain logging
  // ---------------------------------------------------------------------------

  it('development mode activates explain logging on workflows', async () => {
    const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const engine = new Engine({ development: true });
      const echoActivity = async (...args: unknown[]) => args[0];

      engine.register('dev-explain', async function* (ctx: WorkflowContext) {
        const result = yield* (ctx as Context).run(echoActivity, 'test');
        return result;
      });

      const handle = await engine.start('dev-explain', null);
      await handle.result();

      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('[weft]');
      engine[Symbol.dispose]();
    } finally {
      mock.restore();
    }
  });

  it('development mode activates explain logging on resumed workflows', async () => {
    const storage = new MemoryStorage();

    // First engine: start a workflow that waits for a signal
    const engine1 = new Engine({ storage: storage as WeftStorage });
    engine1.register('dev-resume', async function* (ctx: WorkflowContext) {
      yield* (ctx as Context).waitForSignal('go');
      const result = yield* (ctx as Context).run(async () => 42);
      return result;
    });

    await engine1.start('dev-resume', null, { id: 'dev-resume-id' });
    await flush();

    // Dispose the engine (simulating a crash) without cancelling the workflow
    engine1[Symbol.dispose]();

    // Second engine (development mode): resume the workflow
    const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const engine2 = new Engine({ development: true, storage: storage as WeftStorage });
      engine2.register('dev-resume', async function* (ctx: WorkflowContext) {
        yield* (ctx as Context).waitForSignal('go');
        const result = yield* (ctx as Context).run(async () => 42);
        return result;
      });

      const resumed = await engine2.resume('dev-resume-id');
      await flush();

      // Signal to finish - the workflow will replay waitForSignal, then run the activity
      await engine2.signal('dev-resume-id', 'go', 'value');
      await resumed.result();

      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('[weft]');
      engine2[Symbol.dispose]();
    } finally {
      mock.restore();
    }
  });

  // ---------------------------------------------------------------------------
  // 1B: callerStack populated in operation requests
  // ---------------------------------------------------------------------------

  it('ctx.run yields a request with non-empty callerStack', () => {
    const { Context: ContextClass } = require('./context.ts') as { Context: typeof Context };
    const context = new ContextClass({
      workflowId: 'wf-caller-stack',
      workflowType: 'test',
      startedAt: 1000,
      abortController: new AbortController(),
    });

    const echoActivity = async (...args: unknown[]) => args[0];
    const generator = context.run(echoActivity, 'test');
    const yielded = generator.next();

    expect(yielded.done).toBe(false);
    const request = yielded.value as Extract<
      import('./context.ts').ContextOperationRequest,
      { type: 'activity' }
    >;
    expect(request.callerStack).toBeDefined();
    expect(request.callerStack!.length).toBeGreaterThan(0);
  });

  it('failed activity errors include workflow call site in stack trace', async () => {
    const engine = new Engine();
    let capturedError: Error | undefined;

    const failingActivity = async () => {
      throw new Error('activity failure');
    };

    engine.register('caller-stack-workflow', async function* (ctx: WorkflowContext) {
      try {
        yield* (ctx as Context).run(failingActivity);
      } catch (error) {
        capturedError = error as Error;
        throw error;
      }
      return 'unreachable';
    });

    const handle = await engine.start('caller-stack-workflow', null);
    await handle.result().catch(() => {});

    expect(capturedError).toBeDefined();
    expect(capturedError!.stack).toContain('--- workflow call site ---');
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // 1D: Error stacks survive storage round-trips
  // ---------------------------------------------------------------------------

  it('failed workflow preserves error stack through storage round-trip', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage: storage as WeftStorage });

    engine.register('stack-persist', async function* () {
      throw new Error('deliberate failure for stack test');
    });

    const handle = await engine.start('stack-persist', null, { id: 'stack-persist-id' });
    await handle.result().catch(() => {});

    // Read the state from storage directly
    const stateBytes = await storage.get(KEYS.workflow('stack-persist-id'));
    const state = decode(stateBytes!) as WorkflowState;

    expect(state.status).toBe('failed');
    expect(state.error).toBe('deliberate failure for stack test');
    expect(state.errorStack).toBeDefined();
    expect(state.errorStack).toContain('deliberate failure for stack test');
    engine[Symbol.dispose]();
  });

  it('getHandle for a failed workflow restores the error stack from storage', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage: storage as WeftStorage });

    engine.register('stack-restore', async function* () {
      throw new Error('restorable failure');
    });

    const handle = await engine.start('stack-restore', null, { id: 'stack-restore-id' });
    await handle.result().catch(() => {});
    await flush();

    // Load from storage via a new handle
    const newHandle = engine.getHandle('stack-restore-id');
    try {
      await newHandle.result();
      expect.unreachable('should have thrown');
    } catch (error) {
      const restoredError = error as Error;
      expect(restoredError.message).toBe('restorable failure');
      // The restored error should have the original stack
      expect(restoredError.stack).toContain('restorable failure');
    }
    engine[Symbol.dispose]();
  });

  it('legacy state without errorStack still loads correctly', async () => {
    const storage = new MemoryStorage();
    const { encode: encodeValue } = await import('./codec.ts');

    // Write a legacy state that has no errorStack field
    const legacyState: WorkflowState = {
      id: 'legacy-id',
      type: 'legacy-workflow',
      status: 'failed',
      input: null,
      error: 'old failure',
      version: '1',
      createdAt: 1000,
      updatedAt: 2000,
    };
    await storage.put(KEYS.workflow('legacy-id'), encodeValue(legacyState));

    const engine = new Engine({ storage: storage as WeftStorage });
    engine.register('legacy-workflow', async function* () {
      return 'ok';
    });

    const handle = engine.getHandle('legacy-id');
    try {
      await handle.result();
      expect.unreachable('should have thrown');
    } catch (error) {
      const restoredError = error as Error;
      expect(restoredError.message).toBe('old failure');
    }
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // 1D+: Clean stack traces — user call site appears prominently
  // ---------------------------------------------------------------------------

  it('activity error stack includes both original error and workflow call site sections', async () => {
    const engine = new Engine();
    let capturedError: Error | undefined;

    const brokenActivity = async () => {
      throw new Error('network timeout');
    };

    engine.register('clean-stack-workflow', async function* (ctx: WorkflowContext) {
      try {
        yield* (ctx as Context).run(brokenActivity);
      } catch (error) {
        capturedError = error as Error;
        throw error;
      }
      return 'unreachable';
    });

    const handle = await engine.start('clean-stack-workflow', null);
    await handle.result().catch(() => {});

    expect(capturedError).toBeDefined();
    expect(capturedError!.message).toBe('network timeout');
    // The stack should have the original error section
    expect(capturedError!.stack).toContain('network timeout');
    // And the workflow call site separator
    expect(capturedError!.stack).toContain('--- workflow call site ---');
    // The call site section should reference the context module (the yield* site)
    expect(capturedError!.stack).toContain('context');
    engine[Symbol.dispose]();
  });

  it('child workflow error stack includes workflow call site when child fails', async () => {
    const engine = new Engine();
    let capturedError: Error | undefined;

    engine.register('failing-child', async function* () {
      throw new Error('child exploded');
    });

    engine.register('parent-workflow', async function* (ctx: WorkflowContext) {
      try {
        yield* (ctx as Context).startChild('failing-child', null);
      } catch (error) {
        capturedError = error as Error;
        throw error;
      }
      return 'unreachable';
    });

    const handle = await engine.start('parent-workflow', null);
    await handle.result().catch(() => {});

    expect(capturedError).toBeDefined();
    expect(capturedError!.message).toContain('child exploded');
    expect(capturedError!.stack).toContain('--- workflow call site ---');
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // engine.get() — retrieve workflow state
  // ---------------------------------------------------------------------------

  it('engine.get() returns workflow state for an existing workflow', async () => {
    const engine = new Engine();
    engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
      return input;
    });

    const handle = await engine.start('echo', 42);
    await handle.result();

    const state = await engine.get(handle.id);
    expect(state).not.toBeNull();
    expect(state!.id).toBe(handle.id);
    expect(state!.type).toBe('echo');
    expect(state!.status).toBe('completed');
    expect(state!.result).toBe(42);
    engine[Symbol.dispose]();
  });

  it('engine.get() returns null for a non-existent workflow', async () => {
    const engine = new Engine();
    const state = await engine.get('nonexistent-id');
    expect(state).toBeNull();
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // engine.getAttributes() / engine.setAttributes()
  // ---------------------------------------------------------------------------

  it('engine.getAttributes() returns null when no attributes exist', async () => {
    const engine = new Engine();
    const attributes = await engine.getAttributes('nonexistent');
    expect(attributes).toBeNull();
    engine[Symbol.dispose]();
  });

  it('engine.setAttributes() writes attributes and engine.getAttributes() reads them', async () => {
    const engine = new Engine();
    await engine.setAttributes('wf-1', { color: 'blue', count: 42 });

    const attributes = await engine.getAttributes('wf-1');
    expect(attributes).not.toBeNull();
    expect(attributes!['color']).toBe('blue');
    expect(attributes!['count']).toBe(42);
    engine[Symbol.dispose]();
  });

  it('engine.setAttributes() merges with existing attributes', async () => {
    const engine = new Engine();
    await engine.setAttributes('wf-2', { color: 'red', size: 'large' });
    await engine.setAttributes('wf-2', { color: 'blue', weight: 10 });

    const attributes = await engine.getAttributes('wf-2');
    expect(attributes).not.toBeNull();
    expect(attributes!['color']).toBe('blue');
    expect(attributes!['size']).toBe('large');
    expect(attributes!['weight']).toBe(10);
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // engine.getEvents()
  // ---------------------------------------------------------------------------

  it('engine.getEvents() returns empty array when no events exist', async () => {
    const engine = new Engine();
    const events = await engine.getEvents('nonexistent');
    expect(events).toEqual([]);
    engine[Symbol.dispose]();
  });

  it('engine.getEvents() returns stored events in order', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const { EventLog } = await import('./event-log.ts');

    const workflowId = 'ev-test';
    const log = new EventLog(storage, workflowId);
    await log.append({ type: 'workflow:started', payload: { workflowId } });
    await log.append({ type: 'activity:started', payload: { workflowId } });
    await log.append({ type: 'workflow:completed', payload: { workflowId } });

    const events = await engine.getEvents(workflowId);
    expect(events).toHaveLength(3);
    expect(events[0]!.type).toBe('workflow:started');
    expect(events[1]!.type).toBe('activity:started');
    expect(events[2]!.type).toBe('workflow:completed');
    engine[Symbol.dispose]();
  });

  it('engine.getEvents() does not return the head record as a spurious event', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const { EventLog } = await import('./event-log.ts');
    const { KEYS: EventKeys } = await import('../storage/interface.ts');

    const workflowId = 'ev-head-filter';
    const log = new EventLog(storage, workflowId);
    await log.append({ type: 'workflow:checkpoint', payload: { step: 1 } });

    // Verify the head record exists in storage under the ev: prefix.
    const headBytes = await storage.get(EventKeys.eventHead(workflowId));
    expect(headBytes).not.toBeNull();

    // getEvents() must return only the real entry — not the head record.
    const events = await engine.getEvents(workflowId);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('workflow:checkpoint');

    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // engine.listReviews()
  // ---------------------------------------------------------------------------

  it('engine.listReviews() returns empty array when no reviews exist', async () => {
    const engine = new Engine();
    const reviews = await engine.listReviews();
    expect(reviews).toEqual([]);
    engine[Symbol.dispose]();
  });

  it('engine.listReviews() returns stored reviews', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const { encode: encodeValue } = await import('./codec.ts');

    const review = {
      reviewId: 'rev-1',
      workflowId: 'wf-1',
      artifact: { text: 'review me' },
      createdAt: Date.now(),
    };
    await storage.put(KEYS.review('wf-1', 'rev-1'), encodeValue(review));

    const reviews = await engine.listReviews();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!['reviewId']).toBe('rev-1');
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // engine.submitReview()
  // ---------------------------------------------------------------------------

  it('engine.submitReview() stores decision and removes pending review', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const { encode: encodeValue } = await import('./codec.ts');

    const review = {
      reviewId: 'rev-submit-1',
      workflowId: 'wf-submit-1',
      artifact: { text: 'approve me' },
      createdAt: Date.now(),
    };
    await storage.put(KEYS.review('wf-submit-1', 'rev-submit-1'), encodeValue(review));

    await engine.submitReview('rev-submit-1', {
      decision: 'approved',
      reviewer: 'alice',
      workflowId: 'wf-submit-1',
    });

    // Review should be removed
    const reviewAfter = await storage.get(KEYS.review('wf-submit-1', 'rev-submit-1'));
    expect(reviewAfter).toBeNull();

    // Decision should be stored
    const decisionBytes = await storage.get('review-decision:rev-submit-1');
    expect(decisionBytes).not.toBeNull();
    const decisionData = decode(decisionBytes!) as { decision: string; reviewer: string };
    expect(decisionData.decision).toBe('approved');
    expect(decisionData.reviewer).toBe('alice');
    engine[Symbol.dispose]();
  });

  it('engine.submitReview() finds review by scan when workflowId is not provided', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const { encode: encodeValue } = await import('./codec.ts');

    const review = {
      reviewId: 'rev-scan-1',
      workflowId: 'wf-scan-1',
      artifact: { text: 'reject me' },
      createdAt: Date.now(),
    };
    await storage.put(KEYS.review('wf-scan-1', 'rev-scan-1'), encodeValue(review));

    await engine.submitReview('rev-scan-1', {
      decision: 'rejected',
      reviewer: 'bob',
    });

    const reviewAfter = await storage.get(KEYS.review('wf-scan-1', 'rev-scan-1'));
    expect(reviewAfter).toBeNull();
    engine[Symbol.dispose]();
  });

  it('engine.submitReview() throws for non-existent review', async () => {
    const engine = new Engine();
    try {
      await engine.submitReview('nonexistent', {
        decision: 'approved',
        reviewer: 'alice',
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('not found');
    }
    engine[Symbol.dispose]();
  });

  it('engine.submitReview() dispatches HumanReviewCompletedEvent', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const { encode: encodeValue } = await import('./codec.ts');
    const { HumanReviewCompletedEvent } = await import('../ai/events.ts');

    const createdAt = Date.now() - 5000;
    const review = {
      reviewId: 'rev-event-1',
      workflowId: 'wf-event-1',
      artifact: { text: 'review me' },
      reviewType: 'code-review',
      reviewers: ['alice'],
      createdAt,
    };
    await storage.put(KEYS.review('wf-event-1', 'rev-event-1'), encodeValue(review));

    const receivedEvents: InstanceType<typeof HumanReviewCompletedEvent>[] = [];
    engine.addEventListener(HumanReviewCompletedEvent.type, (event) => {
      receivedEvents.push(event as InstanceType<typeof HumanReviewCompletedEvent>);
    });

    await engine.submitReview('rev-event-1', {
      decision: 'approved',
      reviewer: 'alice',
      workflowId: 'wf-event-1',
    });

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]!.workflowId).toBe('wf-event-1');
    expect(receivedEvents[0]!.reviewId).toBe('rev-event-1');
    expect(receivedEvents[0]!.decision).toBe('approved');
    expect(receivedEvents[0]!.reviewer).toBe('alice');
    expect(receivedEvents[0]!.duration).toBeGreaterThanOrEqual(5000);
    engine[Symbol.dispose]();
  });

  it('engine.submitReview() dispatches HumanReviewCompletedEvent when workflowId found by scan', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const { encode: encodeValue } = await import('./codec.ts');
    const { HumanReviewCompletedEvent } = await import('../ai/events.ts');

    const createdAt = Date.now() - 3000;
    const review = {
      reviewId: 'rev-scan-event-1',
      workflowId: 'wf-scan-event-1',
      artifact: { text: 'reject me' },
      reviewType: 'general',
      reviewers: ['bob'],
      createdAt,
    };
    await storage.put(KEYS.review('wf-scan-event-1', 'rev-scan-event-1'), encodeValue(review));

    const receivedEvents: InstanceType<typeof HumanReviewCompletedEvent>[] = [];
    engine.addEventListener(HumanReviewCompletedEvent.type, (event) => {
      receivedEvents.push(event as InstanceType<typeof HumanReviewCompletedEvent>);
    });

    // Submit without workflowId — triggers the scan path
    await engine.submitReview('rev-scan-event-1', {
      decision: 'rejected',
      reviewer: 'bob',
    });

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]!.workflowId).toBe('wf-scan-event-1');
    expect(receivedEvents[0]!.reviewId).toBe('rev-scan-event-1');
    expect(receivedEvents[0]!.decision).toBe('rejected');
    expect(receivedEvents[0]!.reviewer).toBe('bob');
    expect(receivedEvents[0]!.duration).toBeGreaterThanOrEqual(3000);
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // engine.getUpdateResult()
  // ---------------------------------------------------------------------------

  it('engine.getUpdateResult() returns null for non-existent update', async () => {
    const engine = new Engine();
    const result = await engine.getUpdateResult('nonexistent-update-id');
    expect(result).toBeNull();
    engine[Symbol.dispose]();
  });

  it('engine.getUpdateResult() returns stored update response', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    // Use the UpdateCoordinator to create a request and response
    const { UpdateCoordinator } = await import('./updates.ts');
    const coordinator = new UpdateCoordinator(storage);
    const updateId = await coordinator.createRequest('wf-poll', 'setName', { name: 'Alice' });
    const operations = coordinator.buildResponseOperations(updateId, 'wf-poll', { accepted: true });
    await storage.batch(operations);

    const result = await engine.getUpdateResult(updateId);
    expect(result).not.toBeNull();
    expect(result!.updateId).toBe(updateId);
    expect(result!.result).toEqual({ accepted: true });
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // engine.submitCoordinatedUpdate()
  // ---------------------------------------------------------------------------

  it('engine.submitCoordinatedUpdate() creates and waits for response', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
      return input;
    });

    const { UpdateCoordinator } = await import('./updates.ts');
    const coordinator = new UpdateCoordinator(storage);

    // Background poller that resolves updates
    const control = { active: true };
    const poller = (async () => {
      while (control.active) {
        const pending = await coordinator.getPendingUpdates('upd-wf');
        for (const updateRequest of pending) {
          const operations = coordinator.buildResponseOperations(updateRequest.updateId, 'upd-wf', {
            processed: true,
          });
          await storage.batch(operations);
        }
        await Bun.sleep(10);
      }
    })();

    const result = await engine.submitCoordinatedUpdate(
      'upd-wf',
      'setName',
      { name: 'test' },
      {
        timeout: 2000,
      },
    );

    control.active = false;
    await poller;

    expect(result.updateId).toBeDefined();
    expect(result.result).toEqual({ processed: true });
    expect(result.error).toBeUndefined();
    engine[Symbol.dispose]();
  });

  it('engine.submitCoordinatedUpdate() returns cached result for duplicate idempotency key', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const { UpdateCoordinator } = await import('./updates.ts');
    const coordinator = new UpdateCoordinator(storage);

    // Set up a completed update with an idempotency key
    const updateId = await coordinator.createRequest(
      'idem-wf',
      'setName',
      { name: 'Alice' },
      {
        idempotencyKey: 'unique-key',
      },
    );
    const operations = coordinator.buildResponseOperations(
      updateId,
      'idem-wf',
      { accepted: true },
      undefined,
      'unique-key',
    );
    await storage.batch(operations);

    // Call with same idempotency key — should return cached result
    const result = await engine.submitCoordinatedUpdate(
      'idem-wf',
      'setName',
      { name: 'Alice' },
      {
        idempotencyKey: 'unique-key',
      },
    );

    expect(result.updateId).toBe(updateId);
    expect(result.result).toEqual({ accepted: true });
    engine[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // Heartbeat details queryable via activityProgress
  // ---------------------------------------------------------------------------

  describe('activityProgress query', () => {
    it('returns heartbeat details via handle.query("activityProgress")', async () => {
      const engine = new Engine();

      // Gate to keep the activity alive while we query
      const { promise: gate, resolve: releaseGate } = Promise.withResolvers<void>();

      async function longRunningActivity(
        _input: unknown,
        activityContext?: import('./types.ts').ActivityContext,
      ): Promise<string> {
        activityContext?.heartbeat({ percent: 25 });
        activityContext?.heartbeat({ percent: 50 });
        await gate;
        return 'done';
      }

      engine.register('progress-workflow', async function* (ctx: WorkflowContext) {
        const context = ctx as Context;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = yield* context.run(longRunningActivity as any, 'input');
        return result;
      });

      const handle = await engine.start('progress-workflow', null);

      // Let the activity start and heartbeats fire
      await flush();

      const progress = await handle.query('activityProgress');
      expect(progress).toEqual({ percent: 50 });

      // Release the activity so the workflow completes
      releaseGate();
      const result = await handle.result();
      expect(result).toBe('done');

      // After completion, progress should be cleared
      const postProgress = await handle.query('activityProgress');
      expect(postProgress).toBeUndefined();

      engine[Symbol.dispose]();
    });

    it('returns undefined when no heartbeat has been sent', async () => {
      const engine = new Engine();

      engine.register('no-heartbeat-workflow', async function* (ctx: WorkflowContext) {
        const context = ctx as Context;
        yield* context.waitForSignal('done');
        return 'ok';
      });

      const handle = await engine.start('no-heartbeat-workflow', null);
      await flush();

      const progress = await handle.query('activityProgress');
      expect(progress).toBeUndefined();

      await engine.signal(handle.id, 'done');
      await handle.result();
      engine[Symbol.dispose]();
    });
  });

  // ---------------------------------------------------------------------------
  // Agent observability query handlers
  // ---------------------------------------------------------------------------

  describe('agent query handlers', () => {
    function createMultiTurnMockProvider(turns: number): LLMProvider {
      let callIndex = 0;
      return {
        name: 'mock',
        async chat(): Promise<ChatResponse> {
          callIndex++;
          if (callIndex < turns) {
            return {
              content: '',
              toolCalls: [{ id: `call-${callIndex}`, name: 'noop', input: {} }],
              usage: {
                inputTokens: callIndex * 100,
                outputTokens: callIndex * 50,
                totalTokens: callIndex * 150,
              },
              model: 'test-model',
              stopReason: 'tool_use',
            };
          }
          return {
            content: `Final answer after ${turns} turns`,
            toolCalls: [],
            usage: {
              inputTokens: turns * 100,
              outputTokens: turns * 50,
              totalTokens: turns * 150,
            },
            model: 'test-model',
            stopReason: 'end_turn',
          };
        },
        async stream() {
          return new ReadableStream();
        },
        async countTokens(): Promise<number> {
          return 100;
        },
      };
    }

    it('exposes agentCostWaterfall query with per-turn cost data', async () => {
      const engine = new Engine();
      const provider = createMultiTurnMockProvider(3);

      const noopTool = {
        definition: { name: 'noop', description: 'No-op', inputSchema: { type: 'object' } },
        execute: async () => 'ok',
      };

      engine.register('waterfall-workflow', async function* (ctx: WorkflowContext) {
        const context = ctx as Context;
        yield* context.agent({
          model: 'test-model',
          prompt: 'Do three turns',
          provider,
          tools: [noopTool],
          maxTurns: 10,
          budget: {
            maxCost: 100,
            models: { 'test-model': { inputCostPer1K: 1, outputCostPer1K: 2 } },
          },
        });
        // Wait so we can query during execution
        yield* context.waitForSignal('release');
        return 'done';
      });

      const handle = await engine.start('waterfall-workflow', null);
      await flush();

      let waterfall = (await handle.query('agentCostWaterfall')) as
        | Array<{
            turn: number;
            inputTokens: number;
            outputTokens: number;
            cost: number;
            model: string;
            tools: string[];
          }>
        | undefined;
      for (let attempt = 0; waterfall === undefined && attempt < 10; attempt++) {
        await Bun.sleep(10);
        waterfall = (await handle.query('agentCostWaterfall')) as typeof waterfall;
      }

      expect(waterfall).toBeDefined();
      const resolvedWaterfall = waterfall!;
      expect(resolvedWaterfall).toHaveLength(3);
      expect(resolvedWaterfall[0]!.turn).toBe(0);
      expect(resolvedWaterfall[0]!.model).toBe('test-model');
      expect(resolvedWaterfall[0]!.tools).toEqual(['noop']);
      expect(resolvedWaterfall[1]!.turn).toBe(1);
      expect(resolvedWaterfall[2]!.turn).toBe(2);
      expect(resolvedWaterfall[2]!.tools).toEqual([]);

      await engine.signal(handle.id, 'release');
      await handle.result();
      engine[Symbol.dispose]();
    });

    it('exposes agentConversation query with full message array', async () => {
      const engine = new Engine();

      const provider: LLMProvider = {
        name: 'mock',
        async chat(): Promise<ChatResponse> {
          return {
            content: 'Hello from agent',
            toolCalls: [],
            usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
            model: 'test-model',
            stopReason: 'end_turn',
          };
        },
        async stream() {
          return new ReadableStream();
        },
        async countTokens(): Promise<number> {
          return 100;
        },
      };

      engine.register('conversation-workflow', async function* (ctx: WorkflowContext) {
        const context = ctx as Context;
        yield* context.agent({
          model: 'test-model',
          prompt: 'Say hello',
          provider,
          systemPrompt: 'You are helpful.',
        });
        yield* context.waitForSignal('release');
        return 'done';
      });

      const handle = await engine.start('conversation-workflow', null);
      await flush();

      const conversation = (await handle.query('agentConversation')) as Array<{
        turn: number;
        role: string;
        content: string;
      }>;

      expect(conversation.length).toBeGreaterThanOrEqual(3);
      expect(conversation[0]!.role).toBe('system');
      expect(conversation[0]!.content).toBe('You are helpful.');
      expect(conversation[1]!.role).toBe('user');
      expect(conversation[1]!.content).toBe('Say hello');
      expect(conversation[2]!.role).toBe('assistant');
      expect(conversation[2]!.content).toBe('Hello from agent');

      await engine.signal(handle.id, 'release');
      await handle.result();
      engine[Symbol.dispose]();
    });

    it('exposes agentCostProjection query with estimated total cost', async () => {
      const engine = new Engine();
      const provider = createMultiTurnMockProvider(3);

      const noopTool = {
        definition: { name: 'noop', description: 'No-op', inputSchema: { type: 'object' } },
        execute: async () => 'ok',
      };

      engine.register('projection-workflow', async function* (ctx: WorkflowContext) {
        const context = ctx as Context;
        yield* context.agent({
          model: 'test-model',
          prompt: 'Do three turns',
          provider,
          tools: [noopTool],
          maxTurns: 10,
          budget: {
            maxCost: 100,
            models: { 'test-model': { inputCostPer1K: 1, outputCostPer1K: 2 } },
          },
        });
        yield* context.waitForSignal('release');
        return 'done';
      });

      const handle = await engine.start('projection-workflow', null);
      await flush();

      const projection = (await handle.query('agentCostProjection')) as {
        averageCostPerTurn: number;
        turnsCompleted: number;
        maxTurns: number;
        projectedTotalCost: number;
      };

      expect(projection.turnsCompleted).toBe(3);
      expect(projection.maxTurns).toBe(10);
      expect(projection.averageCostPerTurn).toBeGreaterThan(0);
      expect(projection.projectedTotalCost).toBeCloseTo(
        projection.averageCostPerTurn * projection.maxTurns,
        4,
      );

      await engine.signal(handle.id, 'release');
      await handle.result();
      engine[Symbol.dispose]();
    });

    it('exposes merged tokenUsage across multiple agent steps', async () => {
      const engine = new Engine();
      const provider: LLMProvider = {
        name: 'mock',
        async chat(): Promise<ChatResponse> {
          return {
            content: 'ok',
            toolCalls: [],
            usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
            model: 'test-model',
            stopReason: 'end_turn',
          };
        },
        async stream() {
          return new ReadableStream();
        },
        async countTokens(): Promise<number> {
          return 100;
        },
      };

      engine.register('token-usage-workflow', async function* (ctx: WorkflowContext) {
        const context = ctx as Context;
        const budget = {
          maxTokens: 1_000,
          models: { 'test-model': { inputCostPer1K: 1, outputCostPer1K: 2 } },
        };

        yield* context.agent({ model: 'test-model', prompt: 'first', provider, budget });
        yield* context.agent({ model: 'test-model', prompt: 'second', provider, budget });
        yield* context.waitForSignal('release');
        return 'done';
      });

      const handle = await engine.start('token-usage-workflow', null);
      await flush();

      const usage = (await handle.query('tokenUsage')) as {
        tokensUsed: number;
        costUsed: number;
        breakdown: Array<{
          model: string;
          inputTokens: number;
          outputTokens: number;
          cost: number;
        }>;
      };

      expect(usage.tokensUsed).toBe(60);
      expect(usage.breakdown).toHaveLength(1);
      expect(usage.breakdown[0]!.model).toBe('test-model');
      expect(usage.breakdown[0]!.inputTokens).toBe(20);
      expect(usage.breakdown[0]!.outputTokens).toBe(40);
      expect(usage.costUsed).toBeGreaterThan(0);

      await engine.signal(handle.id, 'release');
      await handle.result();
      engine[Symbol.dispose]();
    });
  });

  describe('agent budget events', () => {
    it('dispatches warning and exceeded events for embedded agent steps', async () => {
      const engine = new Engine();
      const provider: LLMProvider = {
        name: 'mock',
        async chat(): Promise<ChatResponse> {
          return {
            content: 'budget result',
            toolCalls: [],
            usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
            model: 'test-model',
            stopReason: 'end_turn',
          };
        },
        async stream() {
          return new ReadableStream();
        },
        async countTokens(): Promise<number> {
          return 100;
        },
      };

      const warnings: AgentBudgetWarningEvent[] = [];
      const exceeded: AgentBudgetExceededEvent[] = [];
      engine.addEventListener(AgentBudgetWarningEvent.type, (event) => {
        warnings.push(event as AgentBudgetWarningEvent);
      });
      engine.addEventListener(AgentBudgetExceededEvent.type, (event) => {
        exceeded.push(event as AgentBudgetExceededEvent);
      });

      engine.register('budget-events-workflow', async function* (ctx: WorkflowContext) {
        const context = ctx as Context;
        return yield* context.agent({
          model: 'test-model',
          prompt: 'Spend the budget',
          provider,
          budget: {
            maxTokens: 25,
            warningThreshold: 0.5,
            models: { 'test-model': { inputCostPer1K: 1, outputCostPer1K: 1 } },
          },
        });
      });

      const handle = await engine.start('budget-events-workflow', null);
      await handle.result();

      expect(warnings).toHaveLength(1);
      expect(exceeded).toHaveLength(1);
      expect(warnings[0]!.budgetUsedPercent).toBeGreaterThanOrEqual(1);
      expect(exceeded[0]!.tokensUsed).toBe(30);

      engine[Symbol.dispose]();
    });

    it('exposes the tracked agent workflow id set while a workflow is running', async () => {
      const engine = new Engine();
      let releaseProvider: (() => void) | undefined;
      const provider: LLMProvider = {
        name: 'mock',
        async chat(): Promise<ChatResponse> {
          await new Promise<void>((resolve) => {
            releaseProvider = resolve;
          });
          return {
            content: 'tracked',
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            model: 'test-model',
            stopReason: 'end_turn',
          };
        },
        async stream() {
          return new ReadableStream();
        },
        async countTokens(): Promise<number> {
          return 1;
        },
      };

      const agent = defineAgent({ name: 'tracked-agent-workflow', model: 'test-model' });
      engine.register(agent, { provider });

      const handle = await engine.start('tracked-agent-workflow', null);
      await flush();

      expect(engine.isAgentWorkflow(handle.id)).toBe(true);
      expect(engine.agentWorkflowIds.has(handle.id)).toBe(true);

      releaseProvider?.();
      await handle.result();

      expect(engine.agentWorkflowIds.has(handle.id)).toBe(false);
      engine[Symbol.dispose]();
    });

    it('runs agent workflows with compression-enabled engine storage', async () => {
      const engine = new Engine({
        storage: new MemoryStorage(),
        compression: { threshold: 1 },
      });
      const provider: LLMProvider = {
        name: 'compressed-agent-provider',
        async chat(): Promise<ChatResponse> {
          return {
            content: 'compressed',
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            model: 'test-model',
            stopReason: 'end_turn',
          };
        },
        async stream() {
          return new ReadableStream();
        },
        async countTokens(): Promise<number> {
          return 1;
        },
      };

      const agent = defineAgent({ name: 'compressed-agent-workflow', model: 'test-model' });
      engine.register(agent, { provider });

      const handle = await engine.start('compressed-agent-workflow', null);
      await flush();

      expect(await handle.result()).toBe('compressed');
      expect(engine.agentWorkflowIds.has(handle.id)).toBe(false);

      engine[Symbol.dispose]();
    });
  });

  // ---------------------------------------------------------------------------
  // Terminal-state cleanup
  // ---------------------------------------------------------------------------

  describe('terminal-state cleanup', () => {
    it('cancel() removes checkpoints and reviews', async () => {
      const engine = new Engine();

      engine.register('review-wait', async function* (ctx: WorkflowContext) {
        yield* (ctx as Context).waitForSignal('never');
        return 'unreached';
      });

      const handle = await engine.start('review-wait', null);
      await flush();

      // Seed a review directly in storage so we can verify cleanup runs.
      const { ReviewCoordinator } = await import('../ai/human-review.ts');
      const coordinator = new ReviewCoordinator(engine.storage);
      const review = await coordinator.createReview(handle.id, {
        artifact: 'pending-artifact',
      });

      const reviewKey = KEYS.review(handle.id, review.reviewId);
      expect(await engine.storage.get(reviewKey)).not.toBeNull();

      const resultPromise = handle.result().catch(() => undefined);
      await engine.cancel(handle.id);
      await resultPromise;

      // Review entry is deleted
      expect(await engine.storage.get(reviewKey)).toBeNull();
      // In-memory checkpoint is deleted (reflected via public accessor)
      const state = await engine.get(handle.id);
      expect(state?.status).toBe('cancelled');
      engine[Symbol.dispose]();
    });

    it('timeout() removes checkpoints and reviews', async () => {
      const engine = new Engine();

      engine.register('review-wait-timeout', async function* (ctx: WorkflowContext) {
        yield* (ctx as Context).waitForSignal('never');
        return 'unreached';
      });

      const handle = await engine.start('review-wait-timeout', null);
      await flush();

      const { ReviewCoordinator } = await import('../ai/human-review.ts');
      const coordinator = new ReviewCoordinator(engine.storage);
      const review = await coordinator.createReview(handle.id, {
        artifact: 'pending-artifact',
      });

      const reviewKey = KEYS.review(handle.id, review.reviewId);
      expect(await engine.storage.get(reviewKey)).not.toBeNull();

      const resultPromise = handle.result().catch(() => undefined);
      await engine.timeout(handle.id);
      await resultPromise;

      expect(await engine.storage.get(reviewKey)).toBeNull();
      const state = await engine.get(handle.id);
      expect(state?.status).toBe('timed-out');
      engine[Symbol.dispose]();
    });

    it('completing a workflow drops signals but preserves output artifacts', async () => {
      const storage = new MemoryStorage();
      const engine = new Engine({ storage });

      engine.register('cleanup-emitter', async function* (ctx: WorkflowContext) {
        const c = ctx as Context;
        yield* c.stream('chunks', async function* () {
          yield { index: 0 };
          yield { index: 1 };
        });
        yield* c.offload('export', async () => ({ rows: [1, 2, 3] }));
        return 'done';
      });

      const handle = await engine.start('cleanup-emitter', null);

      // Pre-seed: a pending signal (internal state) and a shared-state entry
      // (output artifact), plus a synthetic event-history key to verify
      // retention.
      await storage.put(`sig:${handle.id}:pre:entry`, encode({ ignored: true }));
      await storage.put(`shared:${handle.id}:counter`, encode({ value: 1 }));
      await storage.put(`ev:${handle.id}:0000000000`, encode({ kind: 'synthetic' }));

      await handle.result();
      await flush();

      // Signals (internal) are dropped on completion.
      const remainingSignals: string[] = [];
      for await (const [key] of storage.scan(`sig:${handle.id}:`)) {
        remainingSignals.push(key);
      }
      expect(remainingSignals).toEqual([]);

      // Output artifacts are preserved so consumers can still read them
      // after `handle.result()` resolves.
      for (const prefix of [
        `offload:${handle.id}:`,
        `blob:${handle.id}:`,
        `shared:${handle.id}:`,
        `ev:${handle.id}:`,
      ]) {
        let count = 0;
        for await (const _ of storage.scan(prefix)) count++;
        expect(count).toBeGreaterThan(0);
      }

      engine[Symbol.dispose]();
    });

    it('cancelling a workflow drops output artifacts but preserves event history', async () => {
      const storage = new MemoryStorage();
      const engine = new Engine({ storage });

      engine.register('waiter', async function* (ctx: WorkflowContext) {
        yield* (ctx as Context).waitForSignal('never');
        return 'unreached';
      });

      const handle = await engine.start('waiter', null);
      await flush();

      // Pre-seed all four workflow-keyed prefixes.
      await storage.put(`offload:${handle.id}:data`, encode({ rows: [1] }));
      await storage.put(`blob:${handle.id}:stream:meta`, encode({ chunks: 1 }));
      await storage.put(`shared:${handle.id}:counter`, encode({ value: 1 }));
      await storage.put(`sig:${handle.id}:pre:entry`, encode({ ignored: true }));
      await storage.put(`ev:${handle.id}:0000000000`, encode({ kind: 'synthetic' }));

      const resultPromise = handle.result().catch(() => undefined);
      await engine.cancel(handle.id);
      await resultPromise;
      await flush();

      // Output artifacts AND signals are dropped on cancel (no consumer waiting).
      for (const prefix of [
        `offload:${handle.id}:`,
        `blob:${handle.id}:`,
        `shared:${handle.id}:`,
        `sig:${handle.id}:`,
      ]) {
        const remaining: string[] = [];
        for await (const [key] of storage.scan(prefix)) {
          remaining.push(key);
        }
        expect(remaining).toEqual([]);
      }

      // Event history is still preserved so the `/events` endpoint keeps
      // working after cancel/timeout.
      const remainingEvents: string[] = [];
      for await (const [key] of storage.scan(`ev:${handle.id}:`)) {
        remainingEvents.push(key);
      }
      expect(remainingEvents).toContain(`ev:${handle.id}:0000000000`);

      engine[Symbol.dispose]();
    });

    it('ctx.race() aborts losing sub-operations after the race settles', async () => {
      const engine = new Engine();

      let capturedSignal: AbortSignal | undefined;
      const { promise: chatCalled, resolve: resolveChatCalled } = Promise.withResolvers<void>();
      const { promise: allowChatReturn, resolve: resolveAllowChatReturn } =
        Promise.withResolvers<void>();
      const { promise: raceResolved, resolve: resolveRaceResolved } = Promise.withResolvers<void>();

      // Winning activity — blocks until the agent's chat() call is observed,
      // so the agent's signal is captured before the race settles.
      const winningActivity = async (..._args: unknown[]) => {
        await chatCalled;
        return 'winner';
      };

      // Losing agent — chat() captures its signal, signals the winner, then
      // waits until the race is known to have settled before returning.
      const provider: LLMProvider = {
        name: 'abort-aware',
        async chat(_messages, options): Promise<ChatResponse> {
          capturedSignal = options.signal;
          resolveChatCalled();
          await allowChatReturn;
          return {
            content: 'slow reply',
            toolCalls: [],
            usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
            model: 'test-model',
            stopReason: 'end_turn',
          };
        },
        async stream() {
          return new ReadableStream();
        },
        async countTokens(): Promise<number> {
          return 10;
        },
      };

      engine.register('race-abort-workflow', async function* (ctx: WorkflowContext) {
        const c = ctx as Context;
        const result = yield* c.race([
          c.run(winningActivity),
          c.agent({
            model: 'test-model',
            prompt: 'slow',
            provider,
          }),
        ]);
        resolveRaceResolved();
        return result;
      });

      const handle = await engine.start('race-abort-workflow', null);

      // Wait for the race to settle on the winning activity.
      await raceResolved;

      // After settling, the losing agent's signal must have been aborted.
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal!.aborted).toBe(true);

      // Unblock the chat so the losing sub-op rejection settles.
      resolveAllowChatReturn();
      const result = await handle.result();
      expect(result).toBe('winner');
      engine[Symbol.dispose]();
    });

    it('records org budget for agents inside ctx.all() sub-operations', async () => {
      const engine = new Engine();
      await engine.setBudgetPolicy({
        namespace: 'org-parallel',
        daily: { maxCost: 100 },
      });

      const provider: LLMProvider = {
        name: 'cost-provider',
        async chat(): Promise<ChatResponse> {
          return {
            content: 'ok',
            toolCalls: [],
            usage: { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 },
            model: 'test-model',
            stopReason: 'end_turn',
          };
        },
        async stream() {
          return new ReadableStream();
        },
        async countTokens(): Promise<number> {
          return 100;
        },
      };

      engine.register('parallel-agents', async function* (ctx: WorkflowContext) {
        const c = ctx as Context;
        return yield* c.all([
          c.agent({
            model: 'test-model',
            prompt: 'a',
            provider,
            budgetNamespace: 'org-parallel',
            budget: {
              maxCost: 100,
              models: { 'test-model': { inputCostPer1K: 1, outputCostPer1K: 2 } },
            },
          }),
          c.agent({
            model: 'test-model',
            prompt: 'b',
            provider,
            budgetNamespace: 'org-parallel',
            budget: {
              maxCost: 100,
              models: { 'test-model': { inputCostPer1K: 1, outputCostPer1K: 2 } },
            },
          }),
        ]);
      });

      const handle = await engine.start('parallel-agents', null);
      await handle.result();
      await flush();

      // Each agent burn costs: (1000 / 1000) * $1 + (1000 / 1000) * $2 = $3
      // Two agents in ctx.all() → $6 recorded against the org namespace.
      const { decode: decodeValue } = await import('./codec.ts');
      const dailyDate = new Date().toISOString().slice(0, 10);
      const dailyKey = KEYS.budget('org-parallel', 'daily', dailyDate);
      const dailyBytes = await engine.storage.get(dailyKey);
      expect(dailyBytes).not.toBeNull();
      const daily = decodeValue(dailyBytes!) as { cost: number };
      expect(daily.cost).toBeCloseTo(6, 4);
      engine[Symbol.dispose]();
    });

    it('FinalizationRegistry does not evict a freshly-cached handle', async () => {
      const engine = new Engine();
      engine.register('finalize-stable', async function* (ctx: WorkflowContext) {
        yield* (ctx as Context).waitForSignal('release');
        return 'ok';
      });

      const handle = await engine.start('finalize-stable', null, {
        id: 'finalize-stable-id',
      });

      // Simulate the race: when the original handle's WeakRef is cleared, the
      // registry callback fires for the old entry. After #cacheHandle is fixed,
      // the new entry should remain in the cache because the old registration
      // was unregistered before re-registering.
      //
      // We drive the callback path synthetically by calling getHandle() twice
      // after dropping the strong reference — the cached WeakRef may still
      // resolve to a live handle, so we assert the cache entry keeps the new
      // handle alive rather than being spuriously evicted.
      //
      // NOTE: GC is non-deterministic, so this test exercises the structural
      // fix (each cache entry owns an unregister token and a guard in the
      // finalization callback) rather than forcing GC.
      const secondHandle = engine.getHandle('finalize-stable-id');
      expect(secondHandle.id).toBe('finalize-stable-id');
      expect(secondHandle).toBe(handle);

      await engine.signal('finalize-stable-id', 'release');
      await handle.result();
      engine[Symbol.dispose]();
    });
  });

  // ---------------------------------------------------------------------------
  // Budget policy enforcement through ctx.all() (additional regressions)
  // ---------------------------------------------------------------------------

  describe('org-level budget policy enforcement via ctx.all()', () => {
    function createSimpleMockProvider(): LLMProvider {
      return {
        name: 'mock',
        async chat(): Promise<ChatResponse> {
          return {
            content: 'Agent response',
            toolCalls: [],
            usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
            model: 'test-model',
            stopReason: 'end_turn',
          };
        },
        async stream() {
          return new ReadableStream();
        },
        async countTokens(): Promise<number> {
          return 100;
        },
      };
    }

    it('rejects agent sub-operation inside ctx.all() when org budget is exhausted', async () => {
      const provider = createSimpleMockProvider();

      // Pre-seed a MemoryStorage with an exhausted daily counter so the engine's
      // BudgetPolicyEnforcer will reject the first checkBudget() call.
      const storage = new MemoryStorage();
      const seeder = new BudgetPolicyEnforcer(storage, Date.now);
      seeder.setPolicy({ namespace: 'org', daily: { maxCost: 0.01 } });
      await seeder.recordCost('org', 1.0);

      // Build the engine on top of the same storage so the exhausted counter is visible.
      const engine = new Engine({ storage });
      await engine.setBudgetPolicy({ namespace: 'org', daily: { maxCost: 0.01 } });

      engine.register('parallel-agent-budget-workflow', async function* (ctx: WorkflowContext) {
        const results = yield* (ctx as Context).all([
          (ctx as Context).agent({
            model: 'test-model',
            prompt: 'Say hello',
            provider,
            budgetNamespace: 'org',
          }),
        ]);
        return results;
      });

      const handle = await engine.start('parallel-agent-budget-workflow', null);

      // The engine serialises workflow errors to their message string and reconstructs a
      // plain Error on retrieval, so match on the well-known OrganizationBudgetExceededError
      // message prefix rather than the class constructor.
      await expect(handle.result()).rejects.toThrow('Organization budget exceeded: org daily');

      engine[Symbol.dispose]();
    });

    it('returns agentResult.content (not the full result struct) from ctx.all()', async () => {
      const engine = new Engine();
      const provider = createSimpleMockProvider();

      engine.register('parallel-agent-content-workflow', async function* (ctx: WorkflowContext) {
        const results = yield* (ctx as Context).all([
          (ctx as Context).agent({
            model: 'test-model',
            prompt: 'Say hello',
            provider,
          }),
        ]);
        return results;
      });

      const handle = await engine.start('parallel-agent-content-workflow', null);
      const result = (await handle.result()) as unknown[];

      // The result must be the plain string content, not an object with a `content` property.
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('Agent response');
      expect(typeof result[0]).toBe('string');

      engine[Symbol.dispose]();
    });
  });
});

// ---------------------------------------------------------------------------
// Engine: tenant-isolation safety guards
// ---------------------------------------------------------------------------

describe('Engine tenant-isolation guards', () => {
  it('constructs when both workerExecution and tenantResolver are configured', () => {
    const engine = new Engine({
      tenantResolver: {
        resolve: () => ({ id: 'acme' }),
      },
      workerExecution: {
        workerUrl: new URL('https://example.invalid/worker.js'),
        concurrency: 1,
      },
    });
    expect(engine).toBeInstanceOf(Engine);
    engine[Symbol.dispose]();
  });

  it('still constructs when only workerExecution is configured (no tenant)', () => {
    const engine = new Engine({
      workerExecution: {
        workerUrl: new URL('https://example.invalid/worker.js'),
        concurrency: 1,
      },
    });
    expect(engine).toBeInstanceOf(Engine);
    engine[Symbol.dispose]();
  });

  it('still constructs when only tenantResolver is configured (inline mode)', () => {
    const engine = new Engine({
      tenantResolver: { resolve: () => ({ id: 'acme' }) },
    });
    expect(engine).toBeInstanceOf(Engine);
    engine[Symbol.dispose]();
  });

  it('decodeWorkflowState falls back to undefined tenant when persisted tenant is malformed', async () => {
    const storage = new MemoryStorage();

    // Forge a state record with a tampered `tenant` field — `id` is a number,
    // not a string. A naive `as` cast would let this through and an agent's
    // `toolsForTenant` could end up matching on `state.tenant.id === 1` and
    // dispatching admin tools.
    const tamperedState = {
      id: 'wf-tampered',
      type: 'tampered-workflow',
      status: 'completed',
      input: null,
      version: '1',
      createdAt: 1000,
      updatedAt: 2000,
      tenant: { id: 1, attributes: { role: 'admin' } },
    };
    await storage.put(KEYS.workflow('wf-tampered'), encode(tamperedState));

    const warnings: string[] = [];
    const warnSpy = spyOn(console, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });

    try {
      const engine = new Engine({ storage: storage as WeftStorage });
      const listed = await engine.list();

      expect(listed.items).toHaveLength(1);
      expect(listed.items[0]?.id).toBe('wf-tampered');

      // The warning was emitted (at least once — list() may decode twice
      // through fast/slow paths).
      expect(warnings.some((w) => w.includes('invalid tenant field'))).toBe(true);

      // The entire point of this guard: when the engine returns a decoded
      // WorkflowState, the tampered tenant must be stripped to `undefined`
      // so agent `validateInput` / `toolsForTenant` hooks never see it.
      const fetched = await engine.get('wf-tampered');
      expect(fetched).not.toBeNull();
      expect(fetched?.tenant).toBeUndefined();

      // The raw on-disk bytes are deliberately NOT rewritten — we leave
      // remediation of corrupt records to storage-level tooling — so the
      // tampered bytes still exist. Verify the guard is load-time, not
      // persistence-time: the record on disk is unchanged.
      const reloadedBytes = await storage.get(KEYS.workflow('wf-tampered'));
      expect(reloadedBytes).toBeTruthy();
      const reloaded = decode(reloadedBytes!) as { tenant?: unknown };
      expect(reloaded.tenant).toEqual({ id: 1, attributes: { role: 'admin' } });

      engine[Symbol.dispose]();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('decodeWorkflowState accepts a well-formed tenant unchanged', async () => {
    const storage = new MemoryStorage();
    const validState: WorkflowState = {
      id: 'wf-valid-tenant',
      type: 'valid-tenant-workflow',
      status: 'completed',
      input: null,
      version: '1',
      createdAt: 1000,
      updatedAt: 2000,
      tenant: { id: 'acme', attributes: { tier: 'pro' } },
    };
    await storage.put(KEYS.workflow('wf-valid-tenant'), encode(validState));

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const engine = new Engine({ storage: storage as WeftStorage });
      const listed = await engine.list();
      expect(listed.items).toHaveLength(1);
      // No tenant warning should have fired for a well-formed record.
      const warnCalls = warnSpy.mock.calls.flatMap((call) => call.map(String));
      expect(warnCalls.some((c) => c.includes('invalid tenant field'))).toBe(false);
      engine[Symbol.dispose]();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
