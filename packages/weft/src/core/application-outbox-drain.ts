/**
 * The bounded drain for the application delivery outbox (WFT-85): deliver
 * everything that is due, then everything that becomes due within the budget,
 * running a maintenance pass between rounds so lapsed leases are recovered,
 * and report counts only.
 *
 * Split from `application-outbox-runner.ts` to keep both files under this
 * repository's file-size ceiling.
 *
 * @module core/application-outbox-drain
 */

import type {
  ApplicationDeliveryReceipt,
  ApplicationOutboxDrainReport,
} from './application-outbox-contract.ts';
import { requireWaitBudget } from './application-outbox-guards.ts';
import type { OutboxRuntime } from './application-outbox-internals.ts';
import { runOutboxMaintenance } from './application-outbox-maintenance.ts';
import { deliverNext } from './application-outbox-runner.ts';
import { loadOutboxHeader } from './application-outbox-storage.ts';
import { delayUnlessAborted } from './application-primitive-timing.ts';

type DrainCounters = {
  acknowledged: number;
  rejected: number;
  retryScheduled: number;
  deadLettered: number;
  cancelled: number;
  unknown: number;
};

function count(counters: DrainCounters, receipt: ApplicationDeliveryReceipt): void {
  switch (receipt.state) {
    case 'acknowledged':
      counters.acknowledged += 1;
      break;
    case 'rejected':
      counters.rejected += 1;
      break;
    case 'retry-scheduled':
      counters.retryScheduled += 1;
      break;
    case 'dead-lettered':
      counters.deadLettered += 1;
      break;
    case 'cancelled':
      counters.cancelled += 1;
      break;
    case 'unknown-outcome':
      counters.unknown += 1;
      break;
    default:
      break;
  }
}

/**
 * Deliver everything that is due, then everything that becomes due within the
 * budget, running a maintenance pass between rounds so lapsed leases are
 * recovered. Reports counts only, and `pending` from the durable header, so
 * a forced stop never claims anything it did not commit.
 */
export async function drainOutbox(
  runtime: OutboxRuntime,
  options: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
    readonly pollIntervalMs?: number | undefined;
  },
): Promise<ApplicationOutboxDrainReport> {
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
  let drained = false;
  // The open count last read from the durable header. A drain cut short by
  // disposal reports this rather than touching storage the caller may already
  // have released with the handle.
  let lastKnownPending = await readOpenCount(runtime);
  while (!runtime.disposal.aborted && options.signal?.aborted !== true) {
    // Dispositions the maintenance pass commits are the drain's work too: a
    // lease that lapsed after its send began is parked or dead-lettered here,
    // and the report must say so rather than counting only what the adapter
    // settled.
    absorbMaintenance(counters, await runOutboxMaintenance(runtime, runtime.now()));
    const result = await deliverNext(runtime, options);
    if (result.status === 'settled') {
      // Only what this drain committed is this drain's to report; a disposition
      // another worker won belongs to that worker's accounting.
      if (result.committed) count(counters, result.receipt);
      continue;
    }
    const round = await pauseBeforeNextRound(
      runtime,
      result,
      deadline,
      pollIntervalMs,
      options.signal,
    );
    if (round.pending !== null) lastKnownPending = round.pending;
    if (round.status === 'drained') {
      drained = true;
      break;
    }
    if (round.status === 'stop') break;
  }
  const pending = runtime.disposal.aborted ? lastKnownPending : await readOpenCount(runtime);
  return Object.freeze({ ...counters, pending, drained });
}

async function readOpenCount(runtime: OutboxRuntime): Promise<number> {
  const header = await loadOutboxHeader(
    runtime.storage,
    runtime.keys,
    runtime.policy.namespace,
    runtime.policy.ownerId,
  );
  return header.record.openCount;
}

/** Fold a maintenance pass's dispositions into the drain's counters. */
function absorbMaintenance(
  counters: DrainCounters,
  report: { readonly parked: number; readonly deadLettered: number; readonly rescheduled: number },
): void {
  counters.unknown += report.parked;
  counters.deadLettered += report.deadLettered;
  counters.retryScheduled += report.rescheduled;
}

/**
 * Between rounds: read the open count (unless the outbox was disposed), decide
 * whether the drain is done, and sleep until the next look, bounded by the
 * budget. `pending` is `null` only when disposal made the read unsafe.
 */
async function pauseBeforeNextRound(
  runtime: OutboxRuntime,
  result: { readonly status: 'empty' } | { readonly status: 'held'; readonly availableAt: number },
  deadline: number,
  pollIntervalMs: number,
  signal: AbortSignal | undefined,
): Promise<{ readonly status: 'again' | 'drained' | 'stop'; readonly pending: number | null }> {
  if (runtime.disposal.aborted) return { status: 'stop', pending: null };
  const pending = await readOpenCount(runtime);
  if (pending === 0) return { status: 'drained', pending };
  const remaining = deadline - runtime.now();
  if (remaining <= 0) return { status: 'stop', pending };
  const wait = nextWait(result, remaining, pollIntervalMs, runtime.now());
  const slept = await delayUnlessAborted(wait, runtime.disposal, signal);
  return { status: slept ? 'again' : 'stop', pending };
}

/** How long the drain sleeps before looking again, bounded by its budget. */
function nextWait(
  result: { readonly status: 'empty' } | { readonly status: 'held'; readonly availableAt: number },
  remaining: number,
  pollIntervalMs: number,
  now: number,
): number {
  return result.status === 'held'
    ? Math.min(remaining, Math.max(1, result.availableAt - now))
    : Math.min(remaining, pollIntervalMs);
}
