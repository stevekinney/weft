/**
 * #453: cooperative activity cancellation — the TRUE behavior.
 *
 * Weft activity cancellation is cooperative AND fires only on WORKFLOW
 * cancellation. `ActivityContext.signal` is derived from the per-workflow
 * AbortController, which `engine.cancel()` aborts. A `ctx.race()` branch LOSS
 * does NOT abort the losing activity's signal — the race is a result-selection
 * primitive, not a cancellation primitive: it stops awaiting the loser but lets
 * it run to completion. These tests pin both directions so the docs (and users
 * migrating from Temporal's CancellationScope) describe what actually happens.
 */
import { describe, expect, it } from 'bun:test';

import { flushMicrotasks, waitForCondition } from '../../testing/fake-timers.test-support.ts';
import type { ActivityContext, WorkflowContext } from '../types.ts';
import { activity, workflow } from '../types.ts';
import { Engine } from './index.ts';

describe('#453 cooperative activity cancellation', () => {
  it('does NOT abort a losing activity signal when a ctx.race branch wins', async () => {
    await using engine = new Engine();
    let losingActivityStarted = false;
    let losingSignalAborted = false;
    let losingActivityCompleted = false;
    let releaseLoser: () => void = () => {};

    const slowLoser = activity({
      name: 'slow-loser',
      execute: async (_input: unknown, ctx?: ActivityContext) => {
        losingActivityStarted = true;
        ctx?.signal.addEventListener('abort', () => {
          losingSignalAborted = true;
        });
        await new Promise<void>((resolve) => {
          releaseLoser = resolve;
        });
        losingActivityCompleted = true;
        return 'loser-done';
      },
    });

    engine.register(
      workflow({ name: 'race-loss' })
        .activities({ 'slow-loser': slowLoser })
        .execute(async function* (ctx: WorkflowContext) {
          // The signal branch wins; the activity branch loses.
          return yield* ctx.race([ctx.run('slow-loser'), ctx.waitForSignal<string>('go')]);
        }),
    );

    const handle = await engine.start('race-loss', null, { id: 'race-loss-1' });
    await waitForCondition(() => losingActivityStarted, {
      timeoutMs: 2000,
      label: 'losing activity started',
    });
    await engine.signal('race-loss-1', 'go', 'signal-wins');

    const winner = await handle.result();
    expect(winner).toBe('signal-wins');
    // Drain pending microtasks so that if a race loss WERE going to abort the
    // loser's signal, the abort listener would have fired by now. It must not.
    await flushMicrotasks();
    // The race settled — but the losing activity's signal was NOT aborted.
    expect(losingSignalAborted).toBe(false);
    // The loser is still running (we never released it); it was abandoned, not
    // cancelled. Release it so it does not leak.
    expect(losingActivityCompleted).toBe(false);
    releaseLoser();
  });

  it('DOES abort the activity signal when the workflow is cancelled', async () => {
    await using engine = new Engine();
    let activityStarted = false;
    let signalAborted = false;
    let observedThrow = false;

    const longActivity = activity({
      name: 'long',
      execute: async (_input: unknown, ctx?: ActivityContext) => {
        activityStarted = true;
        ctx?.signal.addEventListener('abort', () => {
          signalAborted = true;
        });
        try {
          await new Promise<void>((_resolve, reject) => {
            ctx?.signal.addEventListener('abort', () =>
              reject(ctx.signal.reason ?? new Error('aborted')),
            );
          });
          return 'long-done';
        } catch {
          observedThrow = true;
          throw new Error('activity-aborted');
        }
      },
    });

    engine.register(
      workflow({ name: 'cancel-wf' })
        .activities({ long: longActivity })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run('long');
        }),
    );

    const handle = await engine.start('cancel-wf', null, { id: 'cancel-1' });
    await waitForCondition(() => activityStarted, {
      timeoutMs: 2000,
      label: 'long activity started',
    });
    // The result rejects once cancellation tears the workflow down; swallow it so
    // the rejection is observed rather than surfacing as an unhandled rejection.
    const settled = handle.result().then(
      () => 'resolved',
      () => 'rejected',
    );
    await engine.cancel('cancel-1');

    // The per-workflow AbortController fired, so the in-flight activity's signal
    // aborted and the activity observed it.
    await waitForCondition(() => signalAborted, {
      timeoutMs: 2000,
      label: 'activity signal aborted on workflow cancel',
    });
    expect(signalAborted).toBe(true);
    expect(observedThrow).toBe(true);
    expect(await settled).toBe('rejected');
  });

  it('lets a polling activity bail out synchronously via signal.throwIfAborted()', async () => {
    // The canonical cooperative-cancellation pattern in the docs: a polling loop
    // calls `ctx.signal.throwIfAborted()` at the top of each iteration so the
    // activity stops the moment the workflow is cancelled — no iteration runs after
    // the abort, and the throw propagates as the activity failure. The loop is
    // gated on a test-controlled promise per iteration (a deterministic stand-in
    // for "wait for the next poll tick") so cancellation can interleave between
    // polls without relying on wall-clock timing.
    await using engine = new Engine();
    let iterations = 0;
    let started = false;
    let bailedOut = false;

    let releaseNextPoll: () => void = () => {};
    const nextPollGate = (): Promise<void> =>
      new Promise<void>((resolve) => {
        releaseNextPoll = resolve;
      });
    let pollGate = nextPollGate();

    const pollingActivity = activity({
      name: 'poll',
      execute: async (_input: unknown, ctx?: ActivityContext) => {
        started = true;
        // Bounded loop so a missed abort fails as a wrong iteration count, never hangs.
        for (let index = 0; index < 1000; index += 1) {
          try {
            ctx?.signal.throwIfAborted();
          } catch (error) {
            bailedOut = true;
            throw error;
          }
          iterations += 1;
          await pollGate;
          pollGate = nextPollGate();
        }
        return 'poll-done';
      },
    });

    engine.register(
      workflow({ name: 'poll-wf' })
        .activities({ poll: pollingActivity })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run('poll');
        }),
    );

    const handle = await engine.start('poll-wf', null, { id: 'poll-1' });
    await waitForCondition(() => started, { timeoutMs: 2000, label: 'polling activity started' });
    const settled = handle.result().then(
      () => 'resolved',
      () => 'rejected',
    );

    // Let a couple of polls run, then cancel while the activity is parked on the gate.
    releaseNextPoll();
    await flushMicrotasks();
    releaseNextPoll();
    await flushMicrotasks();
    const iterationsBeforeCancel = iterations;
    expect(iterationsBeforeCancel).toBeGreaterThanOrEqual(2);

    await engine.cancel('poll-1');
    // Release the gate so the loop resumes — its next `throwIfAborted()` must bail.
    releaseNextPoll();

    await waitForCondition(() => bailedOut, {
      timeoutMs: 2000,
      label: 'polling activity bailed out via throwIfAborted',
    });
    expect(bailedOut).toBe(true);
    expect(await settled).toBe('rejected');

    // The bail-out happened at the top of the resumed iteration: no further poll ran.
    expect(iterations).toBe(iterationsBeforeCancel);
  });
});
