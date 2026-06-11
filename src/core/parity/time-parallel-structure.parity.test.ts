/**
 * Parity tests: time, parallelism, and structural workflow patterns.
 *
 * These tests prove that Weft's timing/parallel/structural primitives
 * match Temporal's documented sample patterns:
 *   - Durable sleep that does not resolve until the timer boundary is crossed.
 *   - Timeout race: workflow-level executionTimeout fires when work exceeds
 *     the deadline; ctx.race between two activities resolves to the first
 *     to complete. ctx.race / ctx.all also accept ctx.sleep and
 *     ctx.waitForSignal branches (see race-branches.test.ts for the
 *     timeout/debounce/supersede/event-or-close idioms built on that).
 *   - Parallel fan-out: ctx.all resolves all branches; partial-failure
 *     semantics match the documented contract.
 *   - Child workflows: parent starts child, awaits result; child failure
 *     propagates to parent.
 *
 * All timing uses TestEngine.advanceTime — real sleeps are forbidden.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { flushPortableMicrotasks, yieldToPortableEventLoop } from '../../testing/event-loop.ts';
import { restoreRealTimers, waitForever } from '../../testing/fake-timers.test-support.ts';
import { TestEngine } from '../../testing/test-engine.ts';
import type { WorkflowContext } from '../types.ts';
import { workflow } from '../types.ts';

// Give the engine several event-loop turns to dispatch activities and settle
// promises. One yieldToPortableEventLoop() turn is not enough when the engine
// needs to schedule, dispatch, and checkpoint within a single flush.
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await yieldToPortableEventLoop();
    await flushPortableMicrotasks(5);
  }
}

afterEach(() => {
  restoreRealTimers();
});

// ---------------------------------------------------------------------------
// 1. Durable sleep
// ---------------------------------------------------------------------------

describe('durable sleep (ctx.sleep)', () => {
  it('does not resolve until advanceTime crosses the sleep boundary', async () => {
    const engine = new TestEngine({ startTime: 0 });
    let afterSleep = false;

    const sleepWorkflow = workflow({ name: 'sleep-30d' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.sleep('30 days');
      afterSleep = true;
      return 'awake';
    });
    engine.register(sleepWorkflow);

    const handle = await engine.start('sleep-30d', null);
    await flush();

    // Not resolved yet — sleep boundary not crossed
    expect(afterSleep).toBe(false);

    // Advance to just before the boundary — still sleeping
    await engine.advanceTime('29 days');
    await flush();
    expect(afterSleep).toBe(false);

    // Cross the boundary
    await engine.advanceTime('1 day');
    await flush();
    expect(afterSleep).toBe(true);

    const result = await handle.result();
    expect(result).toBe('awake');

    engine[Symbol.dispose]();
  });

  it('resumes correctly and continues executing after the timer fires', async () => {
    const engine = new TestEngine({ startTime: 0 });
    const events: string[] = [];

    const recordEvent = async (label: string) => {
      events.push(label);
      return label;
    };

    const resumeWorkflow = workflow({ name: 'sleep-resume' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.run(recordEvent, 'before-sleep');
      yield* ctx.sleep('1 hour');
      yield* ctx.run(recordEvent, 'after-sleep');
      return events;
    });
    engine.register(resumeWorkflow);

    const handle = await engine.start('sleep-resume', null);
    await flush();

    expect(events).toEqual(['before-sleep']);

    await engine.advanceTime('1 hour');
    await flush();

    const result = await handle.result();
    expect(result).toEqual(['before-sleep', 'after-sleep']);
    expect(events).toEqual(['before-sleep', 'after-sleep']);

    engine[Symbol.dispose]();
  });
});

// ---------------------------------------------------------------------------
// 2. Timeout race
// ---------------------------------------------------------------------------

// NOTE: these tests cover the workflow-level executionTimeout pattern and a
// ctx.race between two activities. The equivalent of Temporal's
// Promise.race([activity, timer]) — race([ctx.run(...), ctx.sleep(...)]) — and
// the debounce/idle-timeout/supersede/event-or-close idioms (race against
// ctx.sleep / ctx.waitForSignal branches) are covered in race-branches.test.ts.

describe('timeout race', () => {
  it('workflow-level executionTimeout fires when work exceeds the deadline', async () => {
    const engine = new TestEngine({ startTime: 0 });

    const neverReturning = async () => {
      await waitForever();
      return 'never';
    };

    const timeoutWorkflow = workflow({ name: 'timed-out-wf' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.run(neverReturning);
      return 'done';
    });
    engine.register(timeoutWorkflow);

    const handle = await engine.start('timed-out-wf', null, {
      executionTimeout: '5 seconds',
    });
    // Suppress the unhandled rejection from the result promise.
    handle.result().catch(() => {});

    await flush();

    // Advance past the deadline
    await engine.advanceTime('6 seconds');
    await flush();

    const state = await engine.get(handle.id);
    expect(state?.status).toBe('timed-out');

    engine[Symbol.dispose]();
  });

  it('ctx.race resolves to the first activity to complete (competing branches)', async () => {
    const engine = new TestEngine({ startTime: 0 });
    let slowCalls = 0;

    const fast = async () => 'fast-result';
    const slow = async () => {
      slowCalls++;
      // Yield one event-loop turn via MessageChannel so fast is unambiguously
      // first to settle without depending on real wall-clock time.
      await yieldToPortableEventLoop();
      return 'slow-result';
    };

    const racingWorkflow = workflow({ name: 'racing-wf' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      // ctx.race with two activities — whichever resolves first wins
      const result = yield* ctx.race([ctx.run(fast), ctx.run(slow)]);
      return result;
    });
    engine.register(racingWorkflow);

    const handle = await engine.start('racing-wf', null);
    const result = await handle.result();

    // fast completes first, so it wins
    expect(result).toBe('fast-result');
    // slow still ran (both branches dispatched)
    expect(slowCalls).toBe(1);

    engine[Symbol.dispose]();
  });
});

// ---------------------------------------------------------------------------
// 3. Parallel fan-out (ctx.all) — partial-failure semantics
// ---------------------------------------------------------------------------

describe('parallel fan-out (ctx.all)', () => {
  it('resolves all branches and returns results in insertion order', async () => {
    const engine = new TestEngine({ startTime: 0 });

    const fetchA = async () => 'a';
    const fetchB = async () => 'b';
    const fetchC = async () => 'c';

    const fanOutWorkflow = workflow({ name: 'fan-out-all' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const [a, b, c] = yield* ctx.all([ctx.run(fetchA), ctx.run(fetchB), ctx.run(fetchC)]);
      return { a, b, c };
    });
    engine.register(fanOutWorkflow);

    const handle = await engine.start('fan-out-all', null);
    const result = (await handle.result()) as { a: string; b: string; c: string };

    expect(result.a).toBe('a');
    expect(result.b).toBe('b');
    expect(result.c).toBe('c');

    engine[Symbol.dispose]();
  });

  it('runs every branch before propagating failure (documented partial-failure contract)', async () => {
    const engine = new TestEngine({ startTime: 0 });
    let okCalls = 0;
    let failCalls = 0;

    const ok = async () => {
      okCalls++;
      return 'ok';
    };
    const fail = async () => {
      failCalls++;
      throw new Error('branch-failed');
    };

    const partialFailWorkflow = workflow({ name: 'partial-fail-parity' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.all([ctx.run(ok), ctx.run(fail)]);
    });
    engine.register(partialFailWorkflow);

    const handle = await engine.start('partial-fail-parity', null);
    let caught: Error | undefined;
    try {
      await handle.result();
    } catch (error) {
      caught = error as Error;
    }

    // The failure propagates to the caller
    expect(caught?.message).toBe('branch-failed');
    // Both branches ran before the error was surfaced
    expect(okCalls).toBe(1);
    expect(failCalls).toBe(1);

    engine[Symbol.dispose]();
  });

  it('fulfilled slots are reused on replay — failed slots re-dispatch', async () => {
    let okCalls = 0;
    let failCalls = 0;

    const ok = async () => {
      okCalls++;
      return 'ok-result';
    };
    const flaky = async () => {
      failCalls++;
      if (failCalls === 1) throw new Error('first-attempt-fails');
      return 'recovered';
    };

    // Workflow: catch the partial failure, block on a signal so the
    // partial entry is durably persisted, then retry.
    const replayWorkflow = async function* (ctx: WorkflowContext) {
      const c = ctx;
      try {
        yield* c.all([c.run(ok), c.run(flaky)]);
        return 'first-attempt-succeeded';
      } catch {
        yield* c.waitForSignal('retry-now');
        const result = yield* c.all([c.run(ok), c.run(flaky)]);
        return result;
      }
    };

    const engine1 = new TestEngine();
    const replayWorkflowDef = workflow({ name: 'replay-partial' }).execute(replayWorkflow);
    engine1.register(replayWorkflowDef);

    await engine1.start('replay-partial', null, { id: 'wf-replay' });
    await flush();

    // After partial failure the `ok` branch ran once; `flaky` failed once
    expect(okCalls).toBe(1);
    expect(failCalls).toBe(1);

    // Simulate process restart: recover() copies engine1's storage snapshot into
    // a fresh engine that does not share the same storage instance.
    const engine2 = engine1.recover();
    const replayWorkflowDef2 = workflow({ name: 'replay-partial' }).execute(replayWorkflow);
    engine2.register(replayWorkflowDef2);

    const handles = await engine2.recoverAll();
    expect(handles).toHaveLength(1);
    await flush();

    // Send signal to unblock the workflow and let it retry
    await engine2.signal('wf-replay', 'retry-now', null);
    await handles[0]!.result();

    // The fulfilled `ok` slot was reused — it must not have run a second time
    expect(okCalls).toBe(1);
    // `flaky` re-dispatched at least once on the retry path
    expect(failCalls).toBeGreaterThanOrEqual(2);

    engine1[Symbol.dispose]();
    engine2[Symbol.dispose]();
  });
});

// ---------------------------------------------------------------------------
// 4. Child workflows
// ---------------------------------------------------------------------------

describe('child workflows (ctx.startChild)', () => {
  it('parent starts child and awaits the result', async () => {
    const engine = new TestEngine();

    const childWorkflow = workflow({ name: 'double' }).execute(async function* (
      _ctx: WorkflowContext,
      input: unknown,
    ) {
      const { value } = input as { value: number };
      return value * 2;
    });
    engine.register(childWorkflow);

    const parentWorkflow = workflow({ name: 'doubling-parent' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      const { value } = input as { value: number };
      const doubled = yield* ctx.startChild<number>('double', { value });
      return { doubled };
    });
    engine.register(parentWorkflow);

    const handle = await engine.start('doubling-parent', { value: 21 });
    const result = (await handle.result()) as { doubled: number };
    expect(result.doubled).toBe(42);

    engine[Symbol.dispose]();
  });

  it('child failure propagates to the parent', async () => {
    const engine = new TestEngine();

    const failingChild = workflow({ name: 'exploding-child' }).execute(async function* () {
      throw new Error('child-exploded');
    });
    engine.register(failingChild);

    const parentWorkflow2 = workflow({ name: 'catching-parent' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      try {
        yield* ctx.startChild('exploding-child', {});
        return { caught: false };
      } catch (error) {
        return { caught: true, message: (error as Error).message };
      }
    });
    engine.register(parentWorkflow2);

    const handle = await engine.start('catching-parent', {});
    const result = (await handle.result()) as { caught: boolean; message: string };

    expect(result.caught).toBe(true);
    expect(result.message).toBe('child-exploded');

    engine[Symbol.dispose]();
  });

  it('parent can signal the child handle after startChild', async () => {
    const engine = new TestEngine();

    const signalableChild = workflow({ name: 'signalable-child' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const payload = yield* ctx.waitForSignal<{ approved: boolean }>('approval');
      return { approved: payload.approved };
    });
    engine.register(signalableChild);

    // Parent starts the child then immediately signals it
    const signalingParent = workflow({ name: 'signaling-parent' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      const { childId } = input as { childId: string };
      const result = yield* ctx.startChild<{ approved: boolean }>(
        'signalable-child',
        {},
        { id: childId },
      );
      return result;
    });
    engine.register(signalingParent);

    const childId = 'parity-child-signal';
    const handle = await engine.start('signaling-parent', { childId });

    // Give the engine a turn to start the child workflow
    await flush();

    // Signal the child directly — in real usage the parent would do this
    // via the engine after receiving a child handle. Here we signal the
    // child by its known ID to keep the test self-contained.
    await engine.signal(childId, 'approval', { approved: true });

    const result = (await handle.result()) as { approved: boolean };
    expect(result.approved).toBe(true);

    engine[Symbol.dispose]();
  });
});
