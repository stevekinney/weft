/**
 * The abortable, bounded waits the application delivery outbox exposes
 * (WFT-85): waiting for due work, and waiting for a cancelled delivery's
 * attempt to settle.
 *
 * Both are polling waits, for the same reason the mailbox's are: another
 * process's enqueue is visible only in durable storage. Every wait is bounded
 * by a caller-supplied deadline, respects a caller-supplied `AbortSignal`, and
 * unwinds cleanly on disposal. Waiting never claims, starts, or advances work.
 *
 * @module core/application-outbox-waits
 */

import { delayUnlessAborted } from './application-mailbox-waits.ts';
import type {
  ApplicationDeliveryCleanupResult,
  ApplicationOutboxWaitOptions,
} from './application-outbox-contract.ts';
import { DUE_HEAD_LOOKAHEAD } from './application-outbox-delivery.ts';
import {
  requireClockInstant,
  requireDerivedInstant,
  requireWaitBudget,
} from './application-outbox-guards.ts';
import type { OutboxRuntime } from './application-outbox-internals.ts';
import { readCleanupState } from './application-outbox-settlement.ts';
import { loadDelivery, loadDueHead } from './application-outbox-storage.ts';
import { isApplicationDeliveryWaiting } from './application-outbox-types.ts';
import { WaitBudgetElapsedError, raceAbortWithin } from './application-primitive-abort.ts';

export { delayUnlessAborted };

/**
 * Whether a delivery is claimable right now: the earliest genuine due entry
 * is at or before the clock. Orphaned entries are looked past, bounded, since
 * a wait mutates nothing and cannot make progress through them.
 */
export async function hasDueWork(runtime: OutboxRuntime): Promise<boolean> {
  const entries = await loadDueHead(runtime.storage, runtime.keys, DUE_HEAD_LOOKAHEAD);
  for (const entry of entries) {
    const loaded = await loadDelivery(runtime.storage, runtime.keys, entry.deliveryId);
    if (loaded === null || !isApplicationDeliveryWaiting(loaded.record)) continue;
    if (entry.key !== runtime.keys.due(loaded.record.availableAt, loaded.record.deliveryId)) {
      continue;
    }
    return runtime.now() >= loaded.record.availableAt;
  }
  return false;
}

function budgetSpent(timeoutMs: number, deadline: number, now: number): boolean {
  return timeoutMs > 0 && now >= deadline;
}

function budgetFor(timeoutMs: number, deadline: number, now: number): number | null {
  if (timeoutMs === 0) return null;
  const remaining = deadline - now;
  return remaining > 0 ? remaining : null;
}

function isAborted(disposal: AbortSignal, signal?: AbortSignal): boolean {
  return disposal.aborted || signal?.aborted === true;
}

/**
 * Wait, bounded and abortably, until this outbox has a delivery due.
 * Returns `true` when one is claimable and `false` when the wait was aborted,
 * the outbox disposed, or the timeout elapsed first.
 */
export async function waitForDueWork(
  runtime: OutboxRuntime,
  options?: ApplicationOutboxWaitOptions,
): Promise<boolean> {
  const { timeoutMs, pollIntervalMs } = requireWaitBudget(options ?? {});
  const deadline = requireDerivedInstant(
    requireClockInstant(runtime.now()) + timeoutMs,
    'deadline',
  );
  const disposal = runtime.disposal;
  let remaining = 0;
  do {
    const observed = await observeDueWork(runtime, options?.signal, timeoutMs, deadline);
    if (observed === null) return false;
    if (observed) return timeoutMs === 0 || runtime.now() <= deadline;
    remaining = deadline - runtime.now();
    if (remaining <= 0) return false;
  } while (
    await delayUnlessAborted(Math.min(pollIntervalMs, remaining), disposal, options?.signal)
  );
  return false;
}

/** One bounded observation of due work, or `null` when the wait is over. */
async function observeDueWork(
  runtime: OutboxRuntime,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  deadline: number,
): Promise<boolean | null> {
  if (budgetSpent(timeoutMs, deadline, runtime.now())) return null;
  const observed = await raceAbortWithin(
    () => hasDueWork(runtime),
    budgetFor(timeoutMs, deadline, runtime.now()),
    runtime.disposal,
    signal,
  );
  if (observed.aborted || isAborted(runtime.disposal, signal)) return null;
  return observed.value;
}

/**
 * Wait, bounded, for a cancelled delivery's attempt to settle. A `pending`
 * result means this outbox stopped waiting, never that the transport stopped.
 * The semantics match the mailbox's `awaitCleanup`.
 */
export async function waitForCleanup(
  runtime: OutboxRuntime,
  options: {
    readonly deliveryId: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
    readonly pollIntervalMs?: number | undefined;
  },
): Promise<ApplicationDeliveryCleanupResult> {
  const { timeoutMs, pollIntervalMs } = requireWaitBudget(options);
  const deadline = requireDerivedInstant(
    requireClockInstant(runtime.now()) + timeoutMs,
    'deadline',
  );
  const disposal = runtime.disposal;
  const first = await readUnlessAborted(
    runtime,
    options.deliveryId,
    options.signal,
    budgetFor(timeoutMs, deadline, runtime.now()),
  );
  if (first === null) throw new WaitBudgetElapsedError();
  let latest = first;
  if (latest.status === 'pending' && latest.receipt.terminalAt !== undefined) return latest;
  while (latest.status === 'pending') {
    const remaining = deadline - runtime.now();
    if (remaining <= 0) break;
    if (
      !(await delayUnlessAborted(Math.min(pollIntervalMs, remaining), disposal, options.signal))
    ) {
      options.signal?.throwIfAborted();
      break;
    }
    if (budgetSpent(timeoutMs, deadline, runtime.now())) break;
    const next = await readUnlessAborted(
      runtime,
      options.deliveryId,
      options.signal,
      budgetFor(timeoutMs, deadline, runtime.now()),
    );
    if (next === null) break;
    latest = next;
  }
  return latest;
}

async function readUnlessAborted(
  runtime: OutboxRuntime,
  deliveryId: string,
  signal: AbortSignal | undefined,
  budgetMs: number | null,
): Promise<ApplicationDeliveryCleanupResult | null> {
  const raced = await raceAbortWithin(
    () => readCleanupState(runtime, deliveryId),
    budgetMs,
    runtime.disposal,
    signal,
  );
  if (!raced.aborted) return raced.value;
  if (raced.reason instanceof WaitBudgetElapsedError) return null;
  throw raced.reason as Error;
}
