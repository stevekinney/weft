/**
 * The bounded drain for the application delivery outbox (WFT-85): deliver
 * everything that is due, then everything that becomes due within the budget,
 * running a maintenance pass between rounds so lapsed leases are recovered,
 * and report counts only.
 *
 * Split from `outbox-runner.ts` to keep both files under this
 * repository's file-size ceiling.
 *
 * @module core/outbox-drain
 */

import {
  raceAbort,
  raceAbortWithin,
  WaitBudgetElapsedError,
} from './application-primitive-abort.ts';
import { delayUnlessAborted } from './application-primitive-timing.ts';
import type { ApplicationDeliveryReceipt, OutboxDrainReport } from './outbox-contract.ts';
import { requireWaitBudget } from './outbox-guards.ts';
import type { OutboxRuntime } from './outbox-internals.ts';
import { runOutboxMaintenance } from './outbox-maintenance.ts';
import { deliverNext, requireAdapter } from './outbox-runner.ts';
import { loadOutboxHeader } from './outbox-storage.ts';

type DrainCounters = {
  acknowledged: number;
  rejected: number;
  retryScheduled: number;
  deadLettered: number;
  cancelled: number;
  unknown: number;
};

/** Count a disposition this drain committed; `true` when it closed the delivery. */
function count(counters: DrainCounters, receipt: ApplicationDeliveryReceipt): boolean {
  switch (receipt.state) {
    case 'acknowledged':
      counters.acknowledged += 1;
      return true;
    case 'rejected':
      counters.rejected += 1;
      return true;
    case 'retry-scheduled':
      counters.retryScheduled += 1;
      return false;
    case 'dead-lettered':
      counters.deadLettered += 1;
      return true;
    case 'cancelled':
      counters.cancelled += 1;
      return true;
    case 'unknown-outcome':
      counters.unknown += 1;
      return true;
    default:
      return false;
  }
}

/**
 * Deliver everything that is due, then everything that becomes due within the
 * budget, running a maintenance pass before the first round and whenever a
 * round finds nothing due, so lapsed leases are recovered without rescanning
 * the outbox before every send. Reports counts only, and `pending` from the
 * durable header, so a forced stop never claims anything it did not commit.
 *
 * The budget is one stop signal for the whole drain: it ends the sleeps, the
 * maintenance passes, and an in-flight send alike, so a drain asked to stop at
 * a deadline stops there rather than after the current delivery.
 */
export async function drainOutbox(
  runtime: OutboxRuntime,
  options: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
    readonly pollIntervalMs?: number | undefined;
  },
): Promise<OutboxDrainReport> {
  // A drain without an adapter is a caller mistake, reported before any read
  // or maintenance write rather than after the first pass has moved records.
  requireAdapter(runtime);
  const { timeoutMs, pollIntervalMs } = requireWaitBudget(options);
  const deadline = runtime.now() + timeoutMs;
  const counters: DrainCounters = {
    acknowledged: 0,
    rejected: 0,
    retryScheduled: 0,
    deadLettered: 0,
    cancelled: 0,
    unknown: 0,
  };
  const stop = drainStopSignal(options.signal, timeoutMs);
  let drained = false;
  try {
    // The open count as durable storage last reported it, kept current with
    // every terminal disposition this drain commits, so a drain cut short by
    // disposal reports without touching storage the caller may have released.
    let lastKnownPending = await readOpenCount(runtime, stop.signal);
    lastKnownPending = subtract(
      lastKnownPending,
      await maintainOutbox(runtime, counters, stop.signal),
    );
    while (drainActive(runtime, stop.signal) && !budgetSpent(timeoutMs, deadline, runtime.now())) {
      const result = await deliverUnlessStopped(runtime, stop.signal);
      if (result === null) break;
      if (result.status === 'settled') {
        lastKnownPending = absorbDelivery(counters, result, lastKnownPending);
        continue;
      }
      const round = await pauseBeforeNextRound(runtime, result, {
        counters,
        deadline,
        pending: lastKnownPending,
        pollIntervalMs,
        stop: stop.signal,
      });
      lastKnownPending = round.pending;
      drained = round.status === 'drained';
      if (round.status !== 'again') break;
    }
    const pending = runtime.disposal.aborted
      ? lastKnownPending
      : ((await readOpenCount(runtime, stop.signal)) ?? lastKnownPending);
    return Object.freeze({ ...counters, pending, drained });
  } finally {
    stop.release();
  }
}

/**
 * One signal for everything the drain does: the caller's signal, if any, and
 * the budget, armed as a single timer so an in-flight send is aborted at the
 * deadline rather than allowed to run on.
 */
function drainStopSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): { readonly signal: AbortSignal; readonly release: () => void } {
  const controller = new AbortController();
  const onCallerAbort = (): void => {
    controller.abort(callerSignal?.reason as unknown);
  };
  if (callerSignal?.aborted === true) onCallerAbort();
  else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          controller.abort(new WaitBudgetElapsedError());
        }, timeoutMs)
      : null;
  timer?.unref?.();
  return {
    signal: controller.signal,
    release: () => {
      callerSignal?.removeEventListener('abort', onCallerAbort);
      if (timer !== null) clearTimeout(timer);
    },
  };
}

/**
 * One delivery, waited for only as long as the drain's stop signal allows.
 * The signal reaches every phase that observes it — the head lookup, the
 * send, the settlement — but a storage call that stalls between them answers
 * to nothing, so the wait itself is raced against the stop too. A stop that
 * wins ends the drain's work: the delivery finishes on its own, sending
 * nothing once it sees the signal, and is not this drain's to count. A
 * failure of the delivery while the drain still waits propagates.
 */
async function deliverUnlessStopped(
  runtime: OutboxRuntime,
  stop: AbortSignal,
): Promise<Awaited<ReturnType<typeof deliverNext>> | null> {
  const delivery = deliverNext(runtime, { signal: stop });
  const raced = await raceAbort(() => delivery, stop);
  if (raced.aborted) {
    // The detached delivery ends by throwing the stop's reason or by
    // abandoning its claim; neither is anyone's to observe now.
    delivery.catch(() => undefined);
    return null;
  }
  return raced.value;
}

/**
 * Fold one settled delivery into the counters. Only what this drain committed
 * is this drain's to report — a disposition another worker won belongs to that
 * worker's accounting — and a committed terminal disposition lowers the cached
 * open count.
 */
function absorbDelivery(
  counters: DrainCounters,
  result: { readonly receipt: ApplicationDeliveryReceipt; readonly committed: boolean },
  pending: number | null,
): number | null {
  if (!result.committed) return pending;
  return count(counters, result.receipt) ? subtract(pending, 1) : pending;
}

/** Lower a cached open count that may never have been observed by closures that may not have been counted. */
function subtract(pending: number | null, closed: number | null): number | null {
  return pending === null ? null : Math.max(0, pending - (closed ?? 0));
}

/** Whether the drain may start another round: neither disposed nor stopped. */
function drainActive(runtime: OutboxRuntime, stop: AbortSignal): boolean {
  return !runtime.disposal.aborted && !stop.aborted;
}

/** Whether a positive budget has run out; the zero-timeout default never has. */
function budgetSpent(timeoutMs: number, deadline: number, now: number): boolean {
  return timeoutMs > 0 && now >= deadline;
}

/**
 * The durable open count, or `null` when the stop signal fired before storage
 * answered: a bounded drain must not hang on a stalled header read, and it
 * reports nothing it did not observe.
 */
async function readOpenCount(runtime: OutboxRuntime, stop: AbortSignal): Promise<number | null> {
  const raced = await raceAbortWithin(
    () =>
      loadOutboxHeader(
        runtime.storage,
        runtime.keys,
        runtime.policy.namespace,
        runtime.policy.ownerId,
      ),
    null,
    stop,
  );
  return raced.aborted ? null : raced.value.record.openCount;
}

/**
 * Run one maintenance pass, fold its dispositions into the counters, and
 * return how many deliveries it closed, so the cached open count stays true.
 *
 * The pass checks the stop signal at every step boundary, but a scan that
 * stalls between items answers to no signal; the wait for the pass is raced
 * against the stop as well. A stop that wins returns `null`: the pass ends at
 * its next boundary on its own, and whatever it commits meanwhile is not this
 * drain's to count.
 */
async function maintainOutbox(
  runtime: OutboxRuntime,
  counters: DrainCounters,
  stop: AbortSignal,
): Promise<number | null> {
  const pass = runOutboxMaintenance(runtime, runtime.now(), stop);
  const raced = await raceAbort(() => pass, stop);
  if (raced.aborted) {
    // Nobody is left to observe how the detached pass ends; a corrupt record
    // it meets is reported by the next pass that reaches it.
    pass.catch(() => undefined);
    return null;
  }
  const report = raced.value;
  counters.unknown += report.parked;
  counters.deadLettered += report.deadLettered;
  counters.retryScheduled += report.rescheduled;
  return report.parked + report.deadLettered;
}

/**
 * Between rounds, when nothing was due: run maintenance (unless stopped),
 * read the open count (unless disposed), decide whether the drain is done,
 * and sleep until the next look — never longer than the poll interval, so a
 * delivery another process enqueues meanwhile is seen promptly, and never
 * longer than the budget. The returned `pending` is the durable count when
 * it was read, otherwise the cached count lowered by what the maintenance
 * pass closed.
 */
async function pauseBeforeNextRound(
  runtime: OutboxRuntime,
  result: { readonly status: 'empty' } | { readonly status: 'held'; readonly availableAt: number },
  context: {
    readonly counters: DrainCounters;
    readonly deadline: number;
    readonly pending: number | null;
    readonly pollIntervalMs: number;
    readonly stop: AbortSignal;
  },
): Promise<{ readonly status: 'again' | 'drained' | 'stop'; readonly pending: number | null }> {
  if (!drainActive(runtime, context.stop)) return { status: 'stop', pending: context.pending };
  const closed = await maintainOutbox(runtime, context.counters, context.stop);
  const cached = subtract(context.pending, closed);
  if (closed === null || runtime.disposal.aborted) return { status: 'stop', pending: cached };
  const pending = await readOpenCount(runtime, context.stop);
  if (pending === null) return { status: 'stop', pending: cached };
  if (pending === 0) return { status: 'drained', pending };
  const remaining = context.deadline - runtime.now();
  if (remaining <= 0) return { status: 'stop', pending };
  const wait = nextWait(result, remaining, context.pollIntervalMs, runtime.now());
  const slept = await delayUnlessAborted(wait, runtime.disposal, context.stop);
  return { status: slept ? 'again' : 'stop', pending };
}

/** How long the drain sleeps before looking again: the poll interval, the held delivery's due time, or what is left of the budget, whichever is soonest. */
function nextWait(
  result: { readonly status: 'empty' } | { readonly status: 'held'; readonly availableAt: number },
  remaining: number,
  pollIntervalMs: number,
  now: number,
): number {
  const untilDue =
    result.status === 'held' ? Math.max(1, result.availableAt - now) : pollIntervalMs;
  return Math.min(remaining, pollIntervalMs, untilDue);
}
