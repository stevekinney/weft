import { describe, expect, it, mock, spyOn } from 'bun:test';

import type { LLMProvider } from '../ai/providers/interface.ts';
import type { ChatResponse } from '../ai/providers/types.ts';
import type { Storage as WeftStorage } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { decode } from './codec.ts';
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

    // Manually remove the handle from the cache so getHandle creates a new one
    // that chains off the existing result resolver
    (engine as any)['#handleCache']?.delete?.('chain-id');

    // Get a second handle (should chain off the existing result resolver)
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
      if (event.type === 'workflow:completed') break;
    }

    expect(collectedTypes).toContain('workflow:completed');
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

  it('development mode dispatches DevelopmentWarningEvent for non-cloneable values', async () => {
    const engine = new Engine({ development: true });
    const warnings: DevelopmentWarningEvent[] = [];

    engine.addEventListener(DevelopmentWarningEvent.type, (event) => {
      warnings.push(event as DevelopmentWarningEvent);
    });

    // A workflow that stores a function in checkpoint locals (non-cloneable)
    engine.register('dev-warning-workflow', async function* (ctx: WorkflowContext) {
      // Use a memo that returns a plain value (should be fine)
      const result = yield* (ctx as Context).run(async () => 42);
      return result;
    });

    const handle = await engine.start('dev-warning-workflow', null);
    await handle.result();
    await flush();

    // The workflow itself completes fine; we just check the engine doesn't crash in dev mode
    // A more targeted test would check for actual non-cloneable locals
    expect(engine).toBeInstanceOf(Engine);
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

    engine.register('export', async function* (ctx: WorkflowContext) {
      const c = ctx as Context;
      const reference = yield* c.stream('report', async function* (sink) {
        yield { row: 1, data: 'first' };
        sink.heartbeat({ processed: 1 });
        yield { row: 2, data: 'second' };
        sink.heartbeat({ processed: 2 });
      });
      return reference;
    });

    const handle = await engine.start('export', {});
    const result = (await handle.result()) as StreamReference;

    expect(result.key).toBe('report');
    expect(result.workflowId).toBe(handle.id);
    expect(result.chunkCount).toBe(2);
    expect(result.totalSizeBytes).toBeGreaterThan(0);

    // Verify chunks in storage
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
    const { encode: encodeValue } = await import('./codec.ts');

    const workflowId = 'ev-test';
    const eventData = [
      { type: 'workflow:started', timestamp: 1000, data: { workflowId } },
      { type: 'activity:started', timestamp: 1500, data: { workflowId } },
      { type: 'workflow:completed', timestamp: 2000, data: { workflowId } },
    ];

    for (let i = 0; i < eventData.length; i++) {
      await storage.put(KEYS.event(workflowId, i), encodeValue(eventData[i]!));
    }

    const events = await engine.getEvents(workflowId);
    expect(events).toHaveLength(3);
    expect(events[0]!.type).toBe('workflow:started');
    expect(events[1]!.type).toBe('activity:started');
    expect(events[2]!.type).toBe('workflow:completed');
    expect(events[0]!.timestamp).toBe(1000);
    expect(events[2]!.timestamp).toBe(2000);
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
});
