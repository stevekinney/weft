import type { ContextOperationRequest } from '../context.ts';
import { createDeferredConsumeEnvelope } from './deferred-consume-envelope.ts';
import type { EngineInternals } from './internals.ts';
import { consumeSignal, peekSignal, releaseSignalWaiter, trackWaiterKey } from './signals.ts';

/**
 * The largest delay a host `setTimeout` can hold without overflow. Node and Bun
 * store the delay in a 32-bit signed integer, so a value above this wraps and
 * the timer fires almost immediately. A multi-day race-branch sleep must be
 * chunked under this ceiling and re-armed, or it would win its race instantly.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Compute the next host-timer delay for a race-branch sleep: the milliseconds
 * remaining until the deterministic `scheduledFireAt` deadline, clamped to
 * `[0, MAX_TIMER_DELAY_MS]`. Clamping to the ceiling is what prevents a multi-day
 * sleep from overflowing `setTimeout` and firing instantly — the caller re-arms
 * against the same deadline until the remaining delay reaches `0`.
 */
export function nextSleepTimerDelayMs(scheduledFireAt: number, now: number): number {
  return Math.min(Math.max(0, scheduledFireAt - now), MAX_TIMER_DELAY_MS);
}

/**
 * Abortable in-process `sleep` branch for `ctx.race` / `ctx.all`.
 *
 * Unlike a top-level `ctx.sleep` (which arms a durable timer and parks the whole
 * generator), a sleep branch inside a coordination operation is a TRANSIENT
 * in-process wait: the coordination operation as a whole is the durable unit, and
 * on replay the cached winner short-circuits before any branch re-runs. So this
 * must NOT touch `internals.scheduler` (a durable timer write would corrupt the
 * timer index) — it waits with a plain timer that the race's AbortController can
 * cancel when another branch wins.
 *
 * The deadline is the operation's deterministic `scheduledFireAt`, compared
 * against the engine clock (`internals.options.getNow()`), not wall-clock
 * `Date.now()`, so a clock-overriding deployment stays consistent. The remaining
 * delay is recomputed against that absolute deadline on every chunk, which both
 * chunks delays beyond {@link MAX_TIMER_DELAY_MS} (so a multi-day sleep does not
 * overflow `setTimeout` and fire instantly) and self-corrects for timer drift.
 *
 * Note: because the timer is a real event-loop timer, a long sleep that WINS its
 * race is not driven by a virtual-clock `advanceTime`; tests should use short
 * real durations for sleep-wins paths (sleep-loses paths need no timing — the
 * abort fires).
 *
 * The timer also observes the engine abort signal so a long sleep branch does
 * not outlive engine disposal. `ctx.all` does not abort siblings (it has no
 * loser), so without watching `internals.abortController.signal` a multi-day
 * `ctx.all([ctx.sleep('30d')])` branch would keep a host timer alive after the
 * engine is gone.
 */
export function executeSleepSubOperation(
  internals: EngineInternals,
  operation: Extract<ContextOperationRequest, { type: 'sleep' }>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();

  const engineAbort = internals.abortController.signal;
  // A disposed engine must reject even a past-due sleep — resolving it would let a
  // branch report success after the engine is gone. Check before the fast path.
  if (engineAbort.aborted) {
    return Promise.reject(engineAbort.reason ?? new Error('aborted'));
  }
  if (nextSleepTimerDelayMs(operation.scheduledFireAt, internals.options.getNow()) === 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      engineAbort.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? engineAbort.reason ?? new Error('aborted'));
    };

    const arm = () => {
      const remainingMs = nextSleepTimerDelayMs(
        operation.scheduledFireAt,
        internals.options.getNow(),
      );
      if (remainingMs === 0) {
        cleanup();
        resolve();
        return;
      }
      // Chunk delays beyond the host timer ceiling; re-arm against the absolute
      // deadline until it is reached so a multi-day sleep does not overflow.
      timer = setTimeout(arm, remainingMs);
    };

    // No post-registration re-check is needed (unlike `executeWaitSignalSubOperation`,
    // which awaits `peekSignal` after registering): there is no `await` between the
    // early `engineAbort.aborted` guard above and these listener registrations, so
    // the executor runs synchronously through here. JS run-to-completion means a
    // concurrent `abortController.abort()` (its own event-loop task) cannot
    // interleave in that span — the abort is either already set (caught by the
    // early `Promise.reject`) or fires strictly later (caught by this listener).
    // A re-check here would be unreachable dead code.
    signal?.addEventListener('abort', onAbort, { once: true });
    engineAbort.addEventListener('abort', onAbort, { once: true });
    arm();
  });
}

/**
 * Abortable in-process `wait-signal` branch for `ctx.race` / `ctx.all`.
 *
 * A wait-signal branch must never consume its durable signal record itself —
 * when it is woken it does not yet know whether it WON its race. So on delivery
 * it resolves with a {@link createDeferredConsumeEnvelope | deferred-consume
 * envelope}: the single destructive {@link consumeSignal} is wrapped in
 * `finalize` and performed ONLY by the coordinator, on the winner, strictly
 * after `Promise.race` / `Promise.all` settles. A losing branch (race settled by
 * a sibling → `signal` aborts) drops its envelope unfinalized and releases its
 * waiter via {@link releaseSignalWaiter} WITHOUT consuming, so the signal
 * survives for a later `waitForSignal` or a replay.
 *
 * Reads are non-destructive {@link peekSignal}s until the coordinator finalizes;
 * the identity-guarded release (`expectedResolve === deliver`) ensures a loser
 * never clobbers another waiter (e.g. a later top-level `waitForSignal`) that
 * reused the shared `${workflowId}:${signalName}` key.
 */
export function executeWaitSignalSubOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: Extract<ContextOperationRequest, { type: 'wait-signal' }>,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();

  const { signalName } = operation;
  const waiterKey = `${workflowId}:${signalName}`;
  const engineAbort = internals.abortController.signal;

  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let registered = false;
    const { promise: delivered, resolve: deliver } = Promise.withResolvers<void>();

    // Remove BOTH abort listeners on every exit so a race-loser abort from
    // `signal` does not leave the `engineAbort` listener (and its closure)
    // attached for the engine's lifetime.
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      engineAbort.removeEventListener('abort', onAbort);
    };

    // The deferred consume the coordinator runs on the winning path. Wrapped in
    // an envelope so a losing branch (which never reaches finalize) cannot delete
    // the durable record.
    const finalize = async (): Promise<unknown> => {
      const consumed = await consumeSignal(internals, workflowId, signalName);
      return consumed.found ? consumed.payload : undefined;
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      // Race lost (or engine tearing down): drop OUR waiter WITHOUT consuming.
      // Only release if we registered it, and only our own waiter (identity
      // guard), so we never clobber a waiter that reused this key.
      if (registered) {
        releaseSignalWaiter(internals, workflowId, waiterKey, deliver);
      }
      // Prefer the race-loser `signal`'s reason; fall back to the engine-abort
      // reason on teardown (mirrors `executeSleepSubOperation`) so a disposed
      // engine surfaces its own abort reason rather than a generic Error.
      reject(signal?.reason ?? engineAbort.reason ?? new Error('aborted'));
    };

    const win = () => {
      if (settled) return;
      settled = true;
      cleanup();
      // Resolve with the envelope, NOT a consumed value: the coordinator decides
      // whether this branch won and calls finalize() exactly once on the winner.
      resolve(createDeferredConsumeEnvelope(finalize));
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (registered) {
        releaseSignalWaiter(internals, workflowId, waiterKey, deliver);
      }
      reject(error);
    };

    // Attach abort listeners FIRST so an abort that fires during the awaits below
    // sets `settled` — otherwise `addEventListener` would miss an already-fired
    // abort and the branch would proceed to register against a shared waiter key.
    signal?.addEventListener('abort', onAbort, { once: true });
    engineAbort.addEventListener('abort', onAbort, { once: true });
    // Only `engineAbort` can already be set here: `signal?.throwIfAborted()` ran
    // synchronously at the top with no intervening `await`, and the race
    // controller is never aborted synchronously while branches are being mapped,
    // so a `signal`-already-aborted state cannot reach this line.
    if (engineAbort.aborted) {
      onAbort();
      return;
    }

    void (async () => {
      // Peek (do NOT delete) for an already-buffered signal before registering,
      // then register and re-peek to close the TOCTOU where a signal lands
      // between the two reads. A non-destructive peek means a branch that loses
      // mid-check can never drop the signal.
      const existing = await peekSignal(internals, workflowId, signalName);
      if (settled) return;
      if (existing.found) {
        win();
        return;
      }

      internals.signalWaiters.set(waiterKey, deliver);
      trackWaiterKey(internals.signalWaitersByWorkflow, workflowId, waiterKey);
      registered = true;

      const buffered = await peekSignal(internals, workflowId, signalName);
      if (settled) return;
      if (buffered.found) {
        releaseSignalWaiter(internals, workflowId, waiterKey, deliver);
        win();
        return;
      }

      // Wait for delivery to wake this waiter (deliverBufferedSignals releases
      // the waiter then calls deliver(); it does NOT consume the durable record),
      // then resolve with the deferred-consume envelope.
      await delivered;
      if (settled) return;
      win();
    })().catch(fail);
  });
}
