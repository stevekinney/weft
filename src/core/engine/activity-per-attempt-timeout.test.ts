/**
 * #494: `ActivityCallOptions.timeout` — an INLINE per-attempt wall-clock cap.
 *
 * Unlike `scheduleToCloseTimeout` (a cross-attempt budget enforced at the retry
 * boundary), `timeout` bounds a single attempt's wall clock and is measured fresh
 * on every attempt. When it fires, the workflow stops awaiting the attempt and the
 * activity's `AbortSignal` is aborted so a cooperating activity can stop — but Weft
 * cannot forcibly preempt the activity function, so a non-cooperating activity
 * keeps running in the background. The timed-out attempt is retried (with a fresh
 * cap) when a retry policy permits. Enforcement is inline-only; worker-mode
 * per-attempt bounds are governed by `visibilityTimeout`.
 */
import { describe, expect, it } from 'bun:test';

import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import {
  ActivityPerAttemptTimeoutError,
  MAX_PER_ATTEMPT_TIMEOUT_MS,
  parsePerAttemptTimeoutMs,
} from '../context/activity-schedule-to-close.ts';
import { isActivityCallOptions } from '../context/session-state.ts';
import { classifyErrorAsFailureCategory } from '../failure-categories.ts';
import type { ActivityContext, WorkflowContext } from '../types.ts';
import { activity, workflow } from '../types.ts';
import { resolvePerAttemptTimeout } from './activity-per-attempt-timeout.ts';
import { Engine } from './index.ts';
import type { EngineInternals } from './internals.ts';

/** A promise that never settles, so the per-attempt timer is the only way out. */
function hangForever(signal?: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    // Honor abort so the dangling promise is cleaned up when the test ends, but
    // only AFTER the deadline has already rejected the awaiting workflow — this
    // models a NON-cooperating-then-cleanup activity, not a cooperating one.
    signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
}

describe('#494 per-attempt timeout', () => {
  it('treats `timeout` as a call option only alongside another discriminator key', () => {
    // `timeout` is a valid ActivityCallOptions key but deliberately NOT a
    // standalone discriminator (a bare `{ timeout }` is ambiguous with input data).
    // It is recognized once paired with an unambiguous discriminator like `queue`.
    expect(isActivityCallOptions({ timeout: '5s' })).toBe(false);
    expect(isActivityCallOptions({ timeout: '5s', queue: 'gpu' })).toBe(true);
  });

  it('fails a hung inline attempt with ActivityPerAttemptTimeoutError once the cap elapses', async () => {
    await using engine = new Engine();

    const hangs = activity({
      name: 'hangs',
      timeout: 50,
      execute: async (_input?: unknown, ctx?: ActivityContext) => hangForever(ctx?.signal),
    });

    engine.register(
      workflow({ name: 'per-attempt-wf' })
        .activities({ hangs })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run(hangs);
        }),
    );

    const handle = await engine.start('per-attempt-wf', null, { id: 'pat-1' });
    await expect(handle.result()).rejects.toThrow(
      'attempt 1 exceeded its per-attempt timeout of 50ms',
    );
    const failed = await engine.get('pat-1');
    expect(failed?.status).toBe('failed');
  });

  it('lets an attempt that completes before the cap succeed normally', async () => {
    await using engine = new Engine();

    const quick = activity({
      name: 'quick',
      timeout: 1000,
      execute: async () => 'done',
    });

    engine.register(
      workflow({ name: 'quick-wf' })
        .activities({ quick })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run(quick);
        }),
    );

    const handle = await engine.start('quick-wf', null, { id: 'quick-1' });
    await expect(handle.result()).resolves.toBe('done');
  });

  it('aborts the activity AbortSignal when the per-attempt cap fires', async () => {
    await using engine = new Engine();
    let signalAborted = false;

    const watches = activity({
      name: 'watches',
      timeout: 50,
      execute: async (_input?: unknown, ctx?: ActivityContext) => {
        ctx?.signal.addEventListener('abort', () => {
          signalAborted = true;
        });
        return hangForever(ctx?.signal);
      },
    });

    engine.register(
      workflow({ name: 'abort-wf' })
        .activities({ watches })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run(watches);
        }),
    );

    const handle = await engine.start('abort-wf', null, { id: 'abort-1' });
    // The error crosses the durable boundary as a message string (the class is not
    // reconstructed), so assert on the message — the failure-category test below
    // pins the class + classification directly.
    await expect(handle.result()).rejects.toThrow('exceeded its per-attempt timeout of 50ms');
    // The deadline fired the per-attempt AbortController, so the activity's composite
    // signal saw the abort — a cooperating activity could have stopped on it.
    expect(signalAborted).toBe(true);
  });

  it('lets a cooperating activity stop promptly on the aborted signal', async () => {
    await using engine = new Engine();
    // A deferred the activity resolves from its abort cleanup path; the test awaits
    // it to PROVE the activity observed the abort, rather than inferring it.
    let observedAbort!: () => void;
    const observed = new Promise<void>((resolve) => {
      observedAbort = resolve;
    });

    const cooperates = activity({
      name: 'cooperates',
      timeout: 50,
      execute: async (_input?: unknown, ctx?: ActivityContext) => {
        // Resolve as soon as the signal aborts — a well-behaved long-running
        // activity that honors cancellation.
        await new Promise<void>((resolve) => {
          if (ctx?.signal.aborted) return resolve();
          ctx?.signal.addEventListener('abort', () => resolve());
        });
        observedAbort();
        return 'stopped-cooperatively';
      },
    });

    engine.register(
      workflow({ name: 'coop-wf' })
        .activities({ cooperates })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run(cooperates);
        }),
    );

    const handle = await engine.start('coop-wf', null, { id: 'coop-1' });
    // The workflow still fails with the per-attempt timeout (the deadline already
    // rejected the awaited result), even though the activity itself stopped — the
    // cooperative stop frees resources but does not retroactively succeed the run.
    await expect(handle.result()).rejects.toThrow('exceeded its per-attempt timeout of 50ms');
    // Proves the activity actually observed the abort and ran its cleanup path —
    // resolves only when `observedAbort()` fired inside the activity.
    await observed;
  });

  it('returns the timeout error (not the activity result) when the activity settles from its abort listener', async () => {
    // Regression for the abort-before-reject race: an activity that resolves
    // SYNCHRONOUSLY from its abort listener must NOT win the race — the deadline
    // rejection is locked in first, so the workflow always sees the timeout error.
    await using engine = new Engine();

    const racesAbort = activity({
      name: 'racesAbort',
      timeout: 50,
      execute: async (_input?: unknown, ctx?: ActivityContext) =>
        new Promise<string>((resolve) => {
          ctx?.signal.addEventListener('abort', () => resolve('activity-won-the-race'));
        }),
    });

    engine.register(
      workflow({ name: 'race-tie-wf' })
        .activities({ racesAbort })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run(racesAbort);
        }),
    );

    const handle = await engine.start('race-tie-wf', null, { id: 'race-tie-1' });
    await expect(handle.result()).rejects.toThrow('exceeded its per-attempt timeout of 50ms');
    const failed = await engine.get('race-tie-1');
    expect(failed?.status).toBe('failed');
  });

  it('retries a timed-out attempt with a fresh cap when a retry policy permits', async () => {
    await using engine = new Engine();
    let attempts = 0;

    const flakyThenFast = activity({
      name: 'flakyThenFast',
      timeout: 50,
      retry: { maxAttempts: 3, initialBackoff: 0, backoffMultiplier: 1, maxBackoff: 0 },
      execute: async (_input?: unknown, ctx?: ActivityContext) => {
        attempts += 1;
        if (attempts === 1) return hangForever(ctx?.signal); // first attempt overruns the cap
        return 'recovered';
      },
    });

    engine.register(
      workflow({ name: 'retry-cap-wf' })
        .activities({ flakyThenFast })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run(flakyThenFast);
        }),
    );

    const handle = await engine.start('retry-cap-wf', null, { id: 'retry-cap-1' });
    await expect(handle.result()).resolves.toBe('recovered');
    expect(attempts).toBe(2);
  });

  it('aborts ctx.signal and fails with cancellation (not timeout) when the workflow is cancelled mid-attempt', async () => {
    // #528: the workflow-cancel × per-attempt-timeout composite-signal path. The
    // activity's `ctx.signal` is `AbortSignal.any([workflowSignal, attemptSignal])`,
    // so workflow cancellation must propagate through the composite to abort it —
    // and the run must fail with a CANCELLATION error, not a per-attempt timeout.
    // The per-attempt cap is generous (10s) so the cancel deterministically wins:
    // the timer never fires in-test, so there is no timeout-error contamination.
    await using engine = new Engine();
    let activityStarted = false;
    let signalAborted = false;

    const watchesCancel = activity({
      name: 'watchesCancel',
      timeout: 10_000,
      execute: async (_input?: unknown, ctx?: ActivityContext) => {
        activityStarted = true;
        ctx?.signal.addEventListener('abort', () => {
          signalAborted = true;
        });
        // Reject when the composite signal aborts, modeling a cooperating activity
        // that bails on cancellation (so the run tears down rather than hanging).
        await new Promise<void>((_resolve, reject) => {
          ctx?.signal.addEventListener('abort', () =>
            reject(ctx.signal.reason ?? new Error('aborted')),
          );
        });
        return 'never-reached';
      },
    });

    engine.register(
      workflow({ name: 'cancel-mid-attempt-wf' })
        .activities({ watchesCancel })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run(watchesCancel);
        }),
    );

    const handle = await engine.start('cancel-mid-attempt-wf', null, { id: 'cancel-mid-1' });
    await waitForCondition(() => activityStarted, {
      timeoutMs: 2000,
      label: 'activity started before cancel',
    });
    // Subscribe to the result BEFORE cancelling so the rejection is observed, not an
    // unhandled rejection. Cancel deterministically while the activity runs, well
    // before the 10s per-attempt cap could fire.
    const settled = handle.result().then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await engine.cancel('cancel-mid-1');

    // Workflow cancellation propagated through the composite signal to the activity.
    await waitForCondition(() => signalAborted, {
      timeoutMs: 2000,
      label: 'activity signal aborted on workflow cancel',
    });
    expect(signalAborted).toBe(true);
    // The run fails with the cancellation error, NOT the per-attempt timeout error.
    expect(await settled).toBe('Workflow cancelled');
    const cancelled = await engine.get('cancel-mid-1');
    expect(cancelled?.status).toBe('cancelled');
  });

  it('a per-attempt timeout abort does not poison the workflow controller (next retry signal is live)', async () => {
    // #528: `AbortSignal.any` is uni-directional. Aborting the per-attempt
    // controller must NOT reach back to the workflow's `AbortController`, so the
    // NEXT retry gets a fresh, un-aborted `ctx.signal`. Capture `ctx.signal.aborted`
    // synchronously at attempt-2 entry: `false` proves both that the fresh
    // per-attempt controller is not pre-aborted AND that attempt 1's timeout abort
    // did not poison the workflow-wide signal.
    await using engine = new Engine();
    let attempts = 0;
    let secondAttemptSignalAbortedAtEntry: boolean | undefined;

    const timesOutThenInspects = activity({
      name: 'timesOutThenInspects',
      timeout: 50,
      retry: { maxAttempts: 3, initialBackoff: 0, backoffMultiplier: 1, maxBackoff: 0 },
      execute: async (_input?: unknown, ctx?: ActivityContext) => {
        attempts += 1;
        if (attempts === 1) return hangForever(ctx?.signal); // first attempt overruns the cap
        // Second attempt: record whether the fresh signal is already aborted.
        secondAttemptSignalAbortedAtEntry = ctx?.signal.aborted;
        return 'recovered';
      },
    });

    engine.register(
      workflow({ name: 'no-poison-wf' })
        .activities({ timesOutThenInspects })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run(timesOutThenInspects);
        }),
    );

    const handle = await engine.start('no-poison-wf', null, { id: 'no-poison-1' });
    await expect(handle.result()).resolves.toBe('recovered');
    expect(attempts).toBe(2);
    // The retry's fresh signal was NOT aborted — the timeout abort stayed contained
    // to attempt 1's per-attempt controller.
    expect(secondAttemptSignalAbortedAtEntry).toBe(false);
  });

  it('composes with scheduleToCloseTimeout: per-attempt cap fires, retry runs, then the cross-attempt budget closes it', async () => {
    // `timeout` (per-attempt) and `scheduleToCloseTimeout` (cross-attempt budget)
    // are orthogonal. Every attempt overruns the tiny per-attempt cap; the
    // cross-attempt budget then bars a further retry at the retry boundary, so the
    // run fails on the budget after more than one attempt has run.
    //
    // The budget is driven by a CONTROLLED clock (`getNow`), not real wall time, so
    // the close happens at a PRECISE attempt count regardless of CPU contention —
    // the previous real-timer ratio (50ms cap vs 120ms budget) was flake-prone
    // because a single attempt could overrun the budget under load (#528). Only the
    // per-attempt cap remains a tiny REAL timer: it just has to fire to end each
    // attempt, and it never gates the budget decision (which reads `getNow` only).
    //
    // Each attempt advances the virtual clock by 400ms; the budget is measured as
    // ELAPSED time from the first dispatch (clock starts at an arbitrary 1_000_000
    // baseline), checked against the 1000ms budget at the retry boundary:
    //   attempt 1 fails at +400ms  -> next dispatch projects +400 < 1000 -> retry
    //   attempt 2 fails at +800ms  -> next dispatch projects +800 < 1000 -> retry
    //   attempt 3 fails at +1200ms -> next dispatch projects +1200 >= 1000 -> close
    // So exactly 3 attempts run before the budget bars the next retry (well short of
    // maxAttempts: 5), and the terminal error is the budget error, not per-attempt.
    let now = 1_000_000;
    await using engine = new Engine({ getNow: () => now });
    let attempts = 0;

    const alwaysHangs = activity({
      name: 'alwaysHangs',
      timeout: 20,
      scheduleToCloseTimeout: 1000,
      retry: { maxAttempts: 5, initialBackoff: 0, backoffMultiplier: 1, maxBackoff: 0 },
      execute: async (_input?: unknown, ctx?: ActivityContext) => {
        attempts += 1;
        now += 400;
        return hangForever(ctx?.signal);
      },
    });

    engine.register(
      workflow({ name: 'compose-wf' })
        .activities({ alwaysHangs })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run(alwaysHangs);
        }),
    );

    const handle = await engine.start('compose-wf', null, { id: 'compose-1' });
    // The terminal failure is the cross-attempt budget (scheduleToCloseTimeout),
    // reached after the per-attempt timeouts consumed the budget.
    await expect(handle.result()).rejects.toThrow('scheduleToCloseTimeout budget');
    // Exactly three attempts ran: the per-attempt cap did not collapse the run on
    // attempt 1, and the budget barred the fourth at the retry boundary. Pinning the
    // exact count (not just > 1) locks in the deterministic virtual-clock timeline.
    expect(attempts).toBe(3);
  });

  it('classifies the per-attempt timeout error as a timeout failure category', () => {
    const error = new ActivityPerAttemptTimeoutError('hangs', 2, 1000);
    expect(classifyErrorAsFailureCategory(error)).toBe('timeout');
    expect(error.activityName).toBe('hangs');
    expect(error.attempt).toBe(2);
    expect(error.timeoutMs).toBe(1000);
  });

  describe('parsePerAttemptTimeoutMs', () => {
    it('returns undefined when unset', () => {
      expect(parsePerAttemptTimeoutMs(undefined)).toBeUndefined();
    });

    it('parses a numeric duration', () => {
      expect(parsePerAttemptTimeoutMs(500)).toBe(500);
    });

    it('parses a duration string', () => {
      expect(parsePerAttemptTimeoutMs('2s')).toBe(2000);
    });

    it('rejects a zero cap as meaningless', () => {
      expect(() => parsePerAttemptTimeoutMs(0)).toThrow('must be greater than 0ms');
    });

    it('rejects a negative cap (via duration validation)', () => {
      // `parseDuration` rejects negatives before the `<= 0` guard is reached.
      expect(() => parsePerAttemptTimeoutMs(-1)).toThrow(
        'Duration must resolve to a finite, non-negative number of milliseconds',
      );
    });

    it('rejects a non-number / non-string value (hostile input)', () => {
      expect(() => parsePerAttemptTimeoutMs({})).toThrow('must be a number or duration string');
      expect(() => parsePerAttemptTimeoutMs(true)).toThrow('must be a number or duration string');
    });

    it('accepts the maximum supported cap at the boundary', () => {
      expect(parsePerAttemptTimeoutMs(MAX_PER_ATTEMPT_TIMEOUT_MS)).toBe(MAX_PER_ATTEMPT_TIMEOUT_MS);
    });

    it('rejects a cap above the setTimeout overflow ceiling', () => {
      // Above 2^31-1 ms a single setTimeout overflows and fires almost immediately,
      // so an over-max cap is rejected rather than silently misbehaving.
      expect(() => parsePerAttemptTimeoutMs(MAX_PER_ATTEMPT_TIMEOUT_MS + 1)).toThrow(
        'exceeds the maximum supported per-attempt cap',
      );
    });
  });

  describe('resolvePerAttemptTimeout', () => {
    const operationWithTimeout = {
      type: 'activity',
      operationId: 'op-1',
      activityName: 'a',
      step: 0,
      input: null,
      options: { timeout: 50 },
    } as unknown as Parameters<typeof resolvePerAttemptTimeout>[2];

    it('skips the per-attempt cap in worker mode (visibilityTimeout governs there instead)', () => {
      // With an activityWorkerDispatcher present, the cap must be undefined even
      // when operation.options.timeout is set — racing the engine's await against a
      // deadline while a remote worker keeps running would orphan its result.
      const internals = {
        activityWorkerDispatcher: {},
        inlineStrategy: undefined,
      } as unknown as EngineInternals;
      const { perAttemptTimeoutMs, attemptAbortController } = resolvePerAttemptTimeout(
        internals,
        'wf-1',
        operationWithTimeout,
      );
      expect(perAttemptTimeoutMs).toBeUndefined();
      expect(attemptAbortController).toBeUndefined();
    });

    it('resolves the cap inline (no dispatcher) and arms a per-attempt controller', () => {
      const internals = {
        activityWorkerDispatcher: undefined,
        inlineStrategy: undefined,
      } as unknown as EngineInternals;
      const { perAttemptTimeoutMs, attemptAbortController, activitySignal } =
        resolvePerAttemptTimeout(internals, 'wf-1', operationWithTimeout);
      expect(perAttemptTimeoutMs).toBe(50);
      expect(attemptAbortController).toBeInstanceOf(AbortController);
      expect(activitySignal).toBeInstanceOf(AbortSignal);
    });
  });
});
