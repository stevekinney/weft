import { describe, expect, it } from 'bun:test';
import { sleepForTesting, waitForever } from '../testing/fake-timers.test-support.ts';

import { KEYS } from '../storage/interface.ts';
import { TestEngine } from '../testing/test-engine.ts';
import { decode } from './codec.ts';
import { WorkflowTimedOutEvent } from './events.ts';
import { WorkflowTimeoutError } from './timeouts.ts';
import type { WorkflowContext, WorkflowState } from './types.ts';
import { workflow } from './types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function flush(): Promise<void> {
  await sleepForTesting(10);
}

const slowActivity = async (..._args: unknown[]) => {
  await waitForever();
  return 'done';
};

/** Suppress unhandled rejection from a handle's result promise. */
function suppressResult(handle: { result(): Promise<unknown> }): void {
  handle.result().catch(() => {});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Execution Timeouts', () => {
  it('sets workflow status to "timed-out" when deadline expires', async () => {
    const engine = new TestEngine();

    const slowWorkflow = workflow({ name: 'slow' }).execute(async function* (ctx: WorkflowContext) {
      yield* ctx.run(slowActivity);
      return 'never';
    });
    engine.register(slowWorkflow);

    const handle = await engine.start('slow', undefined, {
      executionTimeout: '1 second',
    });
    suppressResult(handle);

    // Advance past the deadline
    await engine.advanceTime('2 seconds');
    await flush();

    // Check workflow state in storage
    const stateBytes = await engine.storage.get(KEYS.workflow(handle.id));
    expect(stateBytes).not.toBeNull();
    const state = decode(stateBytes!) as WorkflowState;
    expect(state.status).toBe('timed-out');

    engine[Symbol.dispose]();
  });

  it('dispatches WorkflowTimedOutEvent when deadline expires', async () => {
    const engine = new TestEngine();
    const events: WorkflowTimedOutEvent[] = [];

    engine.addEventListener(WorkflowTimedOutEvent.type, ((event: WorkflowTimedOutEvent) => {
      events.push(event);
    }) as EventListener);

    const slowWorkflow2 = workflow({ name: 'slow' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.run(slowActivity);
      return 'never';
    });
    engine.register(slowWorkflow2);

    const handle = await engine.start('slow', undefined, {
      executionTimeout: '5 seconds',
    });
    suppressResult(handle);

    await engine.advanceTime('6 seconds');
    await flush();

    expect(events.length).toBe(1);
    expect(events[0]!.workflowId).toBe(handle.id);
    expect(events[0]!.timeoutType).toBe('execution');
    expect(events[0]!.elapsed).toBeGreaterThanOrEqual(5000);

    engine[Symbol.dispose]();
  });

  it('rejects result promise with WorkflowTimeoutError', async () => {
    const engine = new TestEngine();

    const slowWorkflow3 = workflow({ name: 'slow' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.run(slowActivity);
      return 'never';
    });
    engine.register(slowWorkflow3);

    const handle = await engine.start('slow', undefined, {
      executionTimeout: '1 second',
    });

    // Catch inline to avoid unhandled rejection during advanceTime
    const resultPromise = handle.result().catch((error: unknown) => error);

    await engine.advanceTime('2 seconds');
    await flush();

    const error = await resultPromise;
    expect(error).toBeInstanceOf(WorkflowTimeoutError);
    const timeoutError = error as WorkflowTimeoutError;
    expect(timeoutError.workflowId).toBe(handle.id);
    expect(timeoutError.timeoutType).toBe('execution');
    expect(timeoutError.elapsed).toBeGreaterThanOrEqual(1000);

    engine[Symbol.dispose]();
  });

  it('does not dispatch WorkflowCancelledEvent on timeout', async () => {
    const engine = new TestEngine();
    let cancelledCount = 0;

    engine.addEventListener('workflow:cancelled', () => {
      cancelledCount++;
    });

    const slowWorkflow4 = workflow({ name: 'slow' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.run(slowActivity);
      return 'never';
    });
    engine.register(slowWorkflow4);

    const handle = await engine.start('slow', undefined, {
      executionTimeout: '1 second',
    });
    suppressResult(handle);

    await engine.advanceTime('2 seconds');
    await flush();

    expect(cancelledCount).toBe(0);

    engine[Symbol.dispose]();
  });

  it('ctx.executionTimeRemaining returns correct value during execution', async () => {
    const engine = new TestEngine();
    let capturedRemaining: number | undefined;

    const captureRemaining = async (...args: unknown[]) => {
      capturedRemaining = args[0] as number;
      return capturedRemaining;
    };

    const checkTimeWorkflow = workflow({ name: 'check-time' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const remaining = ctx.executionTimeRemaining;
      yield* ctx.run(captureRemaining, remaining);
      return remaining;
    });
    engine.register(checkTimeWorkflow);

    await engine.start('check-time', undefined, {
      executionTimeout: '10 seconds',
    });

    await flush();

    // The remaining time should be close to 10 seconds (10000ms)
    expect(capturedRemaining).toBeDefined();
    expect(capturedRemaining!).toBeLessThanOrEqual(10_000);
    expect(capturedRemaining!).toBeGreaterThan(9_000);

    engine[Symbol.dispose]();
  });

  it('ctx.executionTimeRemaining returns Infinity when no timeout set', async () => {
    const engine = new TestEngine();
    let capturedRemaining: number | undefined;

    const captureRemaining = async (...args: unknown[]) => {
      capturedRemaining = args[0] as number;
      return capturedRemaining;
    };

    const noTimeoutWorkflow = workflow({ name: 'no-timeout' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const remaining = ctx.executionTimeRemaining;
      yield* ctx.run(captureRemaining, remaining);
      return remaining;
    });
    engine.register(noTimeoutWorkflow);

    await engine.start('no-timeout', undefined);
    await flush();

    expect(capturedRemaining).toBe(Infinity);

    engine[Symbol.dispose]();
  });

  it('cleans up deadline timer when workflow completes before timeout', async () => {
    const engine = new TestEngine();
    let timedOutCount = 0;

    engine.addEventListener(WorkflowTimedOutEvent.type, () => {
      timedOutCount++;
    });

    const fastActivity = async () => 'fast';

    const fastWorkflow = workflow({ name: 'fast' }).execute(async function* (ctx: WorkflowContext) {
      const result = yield* ctx.run(fastActivity);
      return result;
    });
    engine.register(fastWorkflow);

    const handle = await engine.start('fast', undefined, {
      executionTimeout: '10 seconds',
    });

    const result = await handle.result();
    expect(result).toBe('fast');

    // Advance past the original deadline — should NOT trigger a timeout
    await engine.advanceTime('15 seconds');
    await flush();

    // Verify the workflow is still completed, not timed-out
    const stateBytes = await engine.storage.get(KEYS.workflow(handle.id));
    const state = decode(stateBytes!) as WorkflowState;
    expect(state.status).toBe('completed');
    expect(timedOutCount).toBe(0);

    engine[Symbol.dispose]();
  });

  it('cleans up deadline timer when workflow is cancelled before timeout', async () => {
    const engine = new TestEngine();
    let timedOutCount = 0;

    engine.addEventListener(WorkflowTimedOutEvent.type, () => {
      timedOutCount++;
    });

    const cancellableWorkflow = workflow({ name: 'cancellable' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.run(slowActivity);
      return 'never';
    });
    engine.register(cancellableWorkflow);

    const handle = await engine.start('cancellable', undefined, {
      executionTimeout: '10 seconds',
    });
    suppressResult(handle);

    // Cancel before the deadline
    await handle.cancel();
    await flush();

    // Advance past the original deadline
    await engine.advanceTime('15 seconds');
    await flush();

    // Should not have timed out — was already cancelled
    expect(timedOutCount).toBe(0);

    engine[Symbol.dispose]();
  });

  it('cleans up deadline timer when workflow fails before timeout', async () => {
    const engine = new TestEngine();
    let timedOutCount = 0;

    engine.addEventListener(WorkflowTimedOutEvent.type, () => {
      timedOutCount++;
    });

    const failingActivity = async () => {
      throw new Error('boom');
    };

    const failingWorkflow = workflow({ name: 'failing' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      // Yield through an activity so the deadline timer is committed to storage
      yield* ctx.run(failingActivity);
      return 'never';
    });
    engine.register(failingWorkflow);

    const handle = await engine.start('failing', undefined, {
      executionTimeout: '10 seconds',
    });

    // Let the failure propagate
    try {
      await handle.result();
    } catch {
      // expected
    }
    await flush();

    // Advance past the original deadline
    await engine.advanceTime('15 seconds');
    await flush();

    // Should not have timed out — was already failed
    expect(timedOutCount).toBe(0);

    engine[Symbol.dispose]();
  });

  it('does not overwrite completed status if deadline fires after completion', async () => {
    const engine = new TestEngine();
    let timedOutCount = 0;

    engine.addEventListener(WorkflowTimedOutEvent.type, () => {
      timedOutCount++;
    });

    const fastActivity = async () => 'fast';

    const completesFirstWorkflow = workflow({ name: 'completes-first' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const result = yield* ctx.run(fastActivity);
      return result;
    });
    engine.register(completesFirstWorkflow);

    const handle = await engine.start('completes-first', undefined, {
      executionTimeout: '5 seconds',
    });

    // Wait for completion
    const result = await handle.result();
    expect(result).toBe('fast');
    await flush();

    // Manually fire the scheduler at a time past the deadline to simulate a race
    await engine.advanceTime('10 seconds');
    await flush();

    // State must remain completed, not overwritten to timed-out
    const stateBytes = await engine.storage.get(KEYS.workflow(handle.id));
    const state = decode(stateBytes!) as WorkflowState;
    expect(state.status).toBe('completed');
    expect(timedOutCount).toBe(0);

    engine[Symbol.dispose]();
  });

  it('forwards WorkflowTimedOutEvent to workflow handle', async () => {
    const engine = new TestEngine();
    const handleEvents: WorkflowTimedOutEvent[] = [];

    const slowWorkflow5 = workflow({ name: 'slow' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.run(slowActivity);
      return 'never';
    });
    engine.register(slowWorkflow5);

    const handle = await engine.start('slow', undefined, {
      executionTimeout: '1 second',
    });
    suppressResult(handle);

    handle.addEventListener(WorkflowTimedOutEvent.type, ((event: WorkflowTimedOutEvent) => {
      handleEvents.push(event);
    }) as EventListener);

    await engine.advanceTime('2 seconds');
    await flush();

    expect(handleEvents.length).toBe(1);
    expect(handleEvents[0]!.workflowId).toBe(handle.id);

    engine[Symbol.dispose]();
  });
});
