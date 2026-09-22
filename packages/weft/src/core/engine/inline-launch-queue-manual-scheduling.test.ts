/**
 * COR-74: the inline launch queue's scheduling primitive is deterministically
 * testable.
 *
 * Every inline workflow's first turn is deferred through
 * `queueInlineWorkflowExecutionStart` (`inline-launch-queue.ts`), which
 * schedules a flush via a `MessageChannel` `postMessage` (or `setTimeout(0)`
 * when `MessageChannel` is unavailable) constructed once, at engine
 * construction, when an inline strategy is set. Both are real event-loop
 * macrotasks with no injection point: Bun's fake-timer seam
 * (`useFakeTimers()`/`jest.advanceTimersByTime`) intercepts `setTimeout`, but
 * not `MessageChannel`, so a deterministic test cannot drive the queued first
 * turn without waiting on a real tick — even under fake timers.
 *
 * `EngineOptions.inlineLaunchScheduling: 'manual'` (default: `'event-loop'`,
 * today's unchanged behavior) skips constructing the channel and never
 * self-schedules a flush. `engine.flushInlineLaunches()` then drains the
 * queue directly, on demand, running every queued start's REAL first turn
 * (and any further turns a `MemoryStorage`-backed run can complete without an
 * external event) through the exact same `startQueuedInlineWorkflowExecution`
 * path the scheduled flush uses — no step execution is skipped or stubbed.
 */
import { describe, expect, it, jest } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { restoreRealTimers, useFakeTimers } from '../../testing/fake-timers.test-support.ts';
import { activity, workflow, type WorkflowContext } from '../types.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';

describe('inline launch queue: manual scheduling (COR-74)', () => {
  it('runs a multi-step inline workflow to completion via flushInlineLaunches() with no real macrotask', async () => {
    useFakeTimers();

    try {
      const stepOne = activity({
        name: 'cor-74-step-one',
        execute: async () => 1,
      });
      const stepTwo = activity({
        name: 'cor-74-step-two',
        execute: async (input: unknown) => (input as number) + 1,
      });
      const stepThree = activity({
        name: 'cor-74-step-three',
        execute: async (input: unknown) => (input as number) + 1,
      });

      const engine = new Engine({
        storage: new MemoryStorage(),
        // New in COR-74. 'manual' skips constructing
        // `queuedInlineWorkflowStartChannel` and never self-schedules a flush —
        // the queued launch only advances when a caller explicitly drives it
        // via `flushInlineLaunches()`.
        inlineLaunchScheduling: 'manual',
      });

      engine.register(
        workflow({ name: 'cor-74-multi-step' }).execute(async function* (ctx: WorkflowContext) {
          const a = yield* ctx.run(stepOne);
          const b = yield* ctx.run(stepTwo, a);
          const c = yield* ctx.run(stepThree, b);
          return c;
        }),
      );

      // No MessageChannel was constructed for manual scheduling.
      expect(getInternals(engine).queuedInlineWorkflowStartChannel).toBeNull();

      // Baseline AFTER construction (not zero: the default
      // `backgroundTasks: 'automatic'` profile already arms an unrelated
      // update-response-cleanup interval). What this test isolates is that
      // queuing, and then flushing, an inline launch never arms an ADDITIONAL
      // timer of its own.
      const timerCountAfterConstruction = jest.getTimerCount();

      const handle = await engine.start('cor-74-multi-step', null, {
        id: 'cor-74-multi-step-1',
      });

      // Nothing scheduled itself: no setTimeout(0) fallback fired either.
      // Under fake timers, a real timer would already be pending here if
      // manual scheduling fell back to one.
      expect(jest.getTimerCount()).toBe(timerCountAfterConstruction);

      // Deterministically drive the queued launch — and every further real
      // turn this multi-step workflow needs to reach completion — without
      // waiting on a real event-loop tick.
      await engine.flushInlineLaunches();

      expect(await handle.result()).toBe(3);
      // Still no timer was ever armed to get there.
      expect(jest.getTimerCount()).toBe(timerCountAfterConstruction);

      await engine[Symbol.asyncDispose]();
    } finally {
      restoreRealTimers();
    }
  });
});
