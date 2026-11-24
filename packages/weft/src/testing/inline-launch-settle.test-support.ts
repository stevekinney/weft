import { jest } from 'bun:test';

import {
  advanceTimersByTime,
  flushMicrotasks,
  waitForCondition,
} from "../../test-support/embedded/testing/src/fake-timers.ts";

/**
 * How many promise turns one pass drains after the scheduled launches have started. The turns
 * are a property of the engine's promise chains (storage, checkpoint writes, step results), never
 * of host load: a pass that needs more fails the same way on every run.
 */
const SETTLE_MICROTASK_TURNS = 1_000;

/**
 * Let every queued inline workflow start run its first turn, then drain the promise chains those
 * turns left behind.
 *
 * An engine defers the first turn of an inline workflow behind a `MessageChannel` message, so a
 * test that starts a workflow and reads its state needs that message delivered first. This waits
 * for the state that says so (no engine has a scheduled flush left) instead of yielding one
 * event-loop turn and hoping the flush landed within it, then drains microtasks, which is all
 * that remains for a workflow on in-memory storage. A start queued by a turn that just ran
 * (`ctx.startChild`) is waited for the same way.
 *
 * Under Bun's fake timers it advances the virtual clock by 10 ms, as the one-turn pause it
 * replaces did.
 */
export async function settleInlineLaunches(): Promise<void> {
  if (jest.isFakeTimers()) {
    await advanceTimersByTime(10);
    return;
  }

  // Loaded here, not at the top of the file: the engine modules form an import cycle whose
  // evaluation order installs the `Symbol.observable` polyfill, and a test file that has already
  // imported the engine has evaluated it in the right order by the time this runs.
  const { isAnyEngineAwaitingScheduledInlineFlushForTesting } =
    await import('../core/engine/inline-launch-queue.ts');

  do {
    await waitForCondition(() => !isAnyEngineAwaitingScheduledInlineFlushForTesting(), {
      label: 'queued inline workflow starts to begin their first turn',
    });
    await flushMicrotasks(SETTLE_MICROTASK_TURNS);
  } while (isAnyEngineAwaitingScheduledInlineFlushForTesting());
}
