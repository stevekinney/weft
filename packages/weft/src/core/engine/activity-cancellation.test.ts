/**
 * #453 / #584: cooperative activity cancellation — the CURRENT behavior.
 *
 * `ActivityContext.signal` is composed from three sources: the per-workflow
 * AbortController (fired by `engine.cancel()`), an optional per-attempt timeout
 * controller, and the coordinator's AbortController when the activity runs as a
 * `ctx.race()` branch (#584 contract reversal).
 *
 * As of #584, a `ctx.race()` branch LOSS fires the losing activity's `ctx.signal`
 * via the coordinator's AbortController — consistent with how losing sleep and
 * wait-signal branches are torn down, and enabling the supersede idiom to signal
 * cooperative cancellation without application-level generation fencing.
 *
 * These tests pin the current behavior so comparisons with Temporal's
 * CancellationScope remain accurate.
 */
import { describe, expect, it } from 'bun:test';

import { flushMicrotasks, waitForCondition } from '../../testing/fake-timers.test-support.ts';
import type { ActivityContext, WorkflowContext } from '../types.ts';
import { activity, workflow } from '../types.ts';
import { Engine } from './index.ts';

describe('#453/#584 cooperative activity cancellation', () => {
  it('DOES abort a losing activity signal when a ctx.race sibling wins (#584)', async () => {
    await using engine = new Engine();
    let losingActivityStarted = false;
    let losingSignalAborted = false;
    let releaseLoser: () => void = () => {};

    const slowLoser = activity({
      name: 'slow-loser',
      execute: async (_input: unknown, ctx?: ActivityContext) => {
        losingActivityStarted = true;
        ctx?.signal.addEventListener('abort', () => {
          losingSignalAborted = true;
        });
        // Park until released or the coordinator aborts the signal.
        await new Promise<void>((resolve) => {
          releaseLoser = resolve;
          ctx?.signal.addEventListener('abort', () => resolve());
        });
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
    // The race coordinator aborts its controller when a sibling wins, which
    // propagates into the losing activity's ctx.signal (#584).
    await waitForCondition(() => losingSignalAborted, {
      timeoutMs: 2000,
      label: 'losing activity signal aborted after race loss',
    });
    expect(losingSignalAborted).toBe(true);
    // Release the loser in case the abort listener did not already resolve it.
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
    // the abort. The throw stops the activity, but the workflow handle still rejects
    // with the engine's terminal cancellation error ("Workflow cancelled"), not the
    // activity's own thrown error, since `engine.cancel()` tears the run down. The
    // loop is gated on a test-controlled promise per iteration (a deterministic
    // stand-in for "wait for the next poll tick") so cancellation can interleave
    // between polls without relying on wall-clock timing.
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
      () => ({ outcome: 'resolved' as const, message: '' }),
      (error: unknown) => ({
        outcome: 'rejected' as const,
        message: error instanceof Error ? error.message : String(error),
      }),
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
    // The workflow rejects with the engine's stable terminal cancellation error,
    // not the activity's own thrown error.
    const result = await settled;
    expect(result.outcome).toBe('rejected');
    expect(result.message).toContain('Workflow cancelled');

    // The bail-out happened at the top of the resumed iteration: no further poll ran.
    expect(iterations).toBe(iterationsBeforeCancel);
  });

  it('#584 supersede: waitForSignal win fires the concurrent activity ctx.signal', async () => {
    // Regression test for #584. The canonical supersede idiom:
    //   ctx.race([ ctx.run('longActivity', ...), ctx.waitForSignal('supersede') ])
    // When the signal wins, the losing activity's ctx.signal must be aborted so
    // cooperative activities can stop writing stale output. Before #584, the
    // coordinator AbortController was not threaded into activity ctx.signal, so
    // the activity ran to completion silently.
    await using engine = new Engine();
    let activityAbortObserved = false;
    let activityStarted = false;
    let releaseActivity: () => void = () => {};

    const longActivity = activity({
      name: 'analyze',
      execute: async (_input: unknown, ctx?: ActivityContext) => {
        activityStarted = true;
        ctx?.signal.addEventListener('abort', () => {
          activityAbortObserved = true;
        });
        // Park until signal fires (supersede) or explicit release.
        await new Promise<void>((resolve) => {
          releaseActivity = resolve;
          ctx?.signal.addEventListener('abort', () => resolve());
        });
        return 'analysis-result';
      },
    });

    engine.register(
      workflow({ name: 'supersede-wf' })
        .activities({ analyze: longActivity })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.race([
            ctx.run('analyze', null),
            ctx.waitForSignal<string>('supersede'),
          ]);
        }),
    );

    const handle = await engine.start('supersede-wf', null, { id: 'supersede-1' });
    await waitForCondition(() => activityStarted, {
      timeoutMs: 2000,
      label: 'long activity started',
    });

    // The supersede signal arrives while the activity is in-flight.
    await engine.signal('supersede-1', 'supersede', 'newer-event');
    const winner = await handle.result();
    expect(winner).toBe('newer-event');

    // The activity's ctx.signal must have been aborted by the coordinator.
    await waitForCondition(() => activityAbortObserved, {
      timeoutMs: 2000,
      label: 'in-flight activity ctx.signal aborted by supersede',
    });
    expect(activityAbortObserved).toBe(true);
    // Release in case the abort listener did not already unpark the activity.
    releaseActivity();
  });
});
