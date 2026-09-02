/**
 * The abortable, bounded waits the application command mailbox exposes
 * (WFT-84): waiting for work to become due, and waiting for a cancelled
 * command's claimant to settle.
 *
 * Both are polling waits. Cross-process wakeup has no push channel — another
 * process's admission is only visible in durable storage — so a poll is the
 * honest mechanism rather than a subscription that would silently miss remote
 * work. Every wait is bounded by a caller-supplied deadline, respects a
 * caller-supplied `AbortSignal`, and unwinds cleanly when the mailbox is
 * disposed mid-wait: the timer is cleared and both abort listeners are removed
 * on every settlement path, so no wait can outlive its mailbox.
 *
 * Waiting never claims, starts, or advances durable work.
 *
 * @module core/application-mailbox-waits
 */

import type {
  ApplicationCommandCleanupResult,
  ApplicationMailboxWaitOptions,
} from './application-mailbox-contract.ts';
import type { MailboxRuntime } from './application-mailbox-internals.ts';
import { readCleanupState } from './application-mailbox-settlement.ts';
import { isWaitingState, loadCommand, loadDeliveryHead } from './application-mailbox-storage.ts';
import {
  requireClockInstant,
  requireDerivedInstant,
  requireWaitBudget,
} from './application-mailbox-validation.ts';

export { DEFAULT_WAIT_POLL_INTERVAL_MS as DEFAULT_MAILBOX_POLL_INTERVAL_MS } from './application-mailbox-validation.ts';

/**
 * Sleep, resolving `false` when the wait was aborted or the mailbox disposed
 * and `true` when the interval actually elapsed.
 *
 * The listeners are removed on every path, including the timer path, so a
 * long-lived mailbox does not accumulate abort listeners once per poll.
 */
export function delayUnlessAborted(
  milliseconds: number,
  disposal: AbortSignal,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted === true || disposal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const settle = (elapsed: boolean): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      disposal.removeEventListener('abort', onAbort);
      resolve(elapsed);
    };
    const onAbort = (): void => {
      settle(false);
    };
    const timer = setTimeout(() => {
      settle(true);
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
    disposal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Whether the FIFO head exists and is claimable right now.
 *
 * The absolute deadline counts as well as availability. A head that is due but
 * already expired is not deliverable — `claim()` would terminalize it and report
 * `empty` — so reporting it as available would advertise work that does not
 * exist.
 */
export async function hasDueWork(runtime: MailboxRuntime): Promise<boolean> {
  const head = await loadDeliveryHead(runtime.storage, runtime.keys);
  if (head === null) return false;
  const loaded = await loadCommand(runtime.storage, runtime.keys, head.commandId);
  // The record is read after the index. Another consumer can claim the head in
  // between, and a claimed or terminal record reached through a stale entry is
  // not claimable whatever its timestamps say.
  if (loaded === null || !isWaitingState(loaded.record)) return false;
  // The same ownership rule `claim()` applies: an entry that is not the one the
  // record's sequence names is one `claim()` will discard, not deliver.
  if (head.key !== runtime.keys.ready(loaded.record.sequence)) return false;
  const now = runtime.now();
  return now >= loaded.record.availableAt && now < loaded.record.absoluteDeadlineAt;
}

/**
 * Wait, bounded and abortably, until this mailbox has work due for delivery.
 *
 * Returns `true` when the FIFO head is claimable and `false` when the wait was
 * aborted, the mailbox was disposed, or the timeout elapsed first.
 */
export async function waitForAvailableWork(
  runtime: MailboxRuntime,
  disposal: AbortSignal,
  options?: ApplicationMailboxWaitOptions,
): Promise<boolean> {
  const { timeoutMs, pollIntervalMs } = requireWaitBudget(options ?? {});
  // Both operands are valid on their own; the sum can still leave the range no
  // later clock reading can reach, which would turn a bounded wait into polling
  // until aborted.
  const deadline = requireDerivedInstant(
    requireClockInstant(runtime.now()) + timeoutMs,
    'deadline',
  );
  let remaining = 0;
  do {
    // Aborting or disposal means `false`, and that outranks any observation —
    // including one already in hand or one still in flight against stalled
    // storage. A shutdown caller must never be told to start new work. Observe
    // first, so the documented `timeoutMs: 0` default still performs one check
    // rather than returning before looking at anything.
    const observed = await raceAbort(() => hasDueWork(runtime), disposal, options?.signal);
    if (observed.aborted || isAborted(disposal, options?.signal)) return false;
    if (observed.value) return observedInTime(timeoutMs, deadline, runtime.now());
    // Clamp each sleep to what is left of the budget. An interval longer than the
    // remaining time would otherwise put the next observation past the bound the
    // caller asked for, turning a timeout into a late success.
    remaining = deadline - runtime.now();
    if (remaining <= 0) return false;
  } while (
    await delayUnlessAborted(Math.min(pollIntervalMs, remaining), disposal, options?.signal)
  );
  // The sleep was cut short by an abort or by disposal.
  return false;
}

/**
 * Whether a due-work observation still counts, given when it finished.
 *
 * The observation itself takes time. Work that came due during a read that
 * finished past the deadline is a late success the bound promised not to
 * report; the zero-timeout default keeps its single unconditional look.
 */
function observedInTime(timeoutMs: number, deadline: number, now: number): boolean {
  return timeoutMs === 0 || now <= deadline;
}

/** Whether either the mailbox's disposal signal or the caller's signal has fired. */
function isAborted(disposal: AbortSignal, signal?: AbortSignal): boolean {
  return disposal.aborted || signal?.aborted === true;
}

/**
 * Wait, bounded, for a cancelled command's claimant to settle.
 *
 * A `pending` result means this mailbox stopped waiting — never that the
 * handler stopped.
 */
export async function waitForCleanup(
  runtime: MailboxRuntime,
  disposal: AbortSignal,
  options: {
    readonly commandId: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
    readonly pollIntervalMs?: number | undefined;
  },
): Promise<ApplicationCommandCleanupResult> {
  const { timeoutMs, pollIntervalMs } = requireWaitBudget(options);
  // Both operands are valid on their own; the sum can still leave the range no
  // later clock reading can reach, which would turn a bounded wait into polling
  // until aborted.
  const deadline = requireDerivedInstant(
    requireClockInstant(runtime.now()) + timeoutMs,
    'deadline',
  );
  // Every read races the caller's signal and the mailbox's disposal. A wait
  // that is already aborted must not begin a storage read, and one aborted
  // DURING a stalled remote read must not stay pending until that read returns;
  // either way the abort surfaces as the signal's own reason, as `claim()` does
  // for its request signal.
  let latest = await readUnlessAborted(runtime, options.commandId, disposal, options.signal);
  // A terminal record with `cleanupPending: true` is already final: the mailbox
  // recorded that it stopped waiting for an abandoned attempt. Polling it would
  // burn the whole timeout on a value that can never change again.
  if (latest.status === 'pending' && latest.receipt.terminalAt !== undefined) return latest;
  while (latest.status === 'pending') {
    // Clamp to the remaining budget for the same reason the available-work wait
    // does: a poll interval longer than what is left would block well past the
    // bound this method promises.
    const remaining = deadline - runtime.now();
    if (remaining <= 0) break;
    if (
      !(await delayUnlessAborted(Math.min(pollIntervalMs, remaining), disposal, options.signal))
    ) {
      break;
    }
    latest = await readUnlessAborted(runtime, options.commandId, disposal, options.signal);
  }
  return latest;
}

/** The outcome of racing an in-flight observation against the abort signals. */
type Raced<T> =
  | { readonly aborted: false; readonly value: T }
  | { readonly aborted: true; readonly reason: unknown };

/**
 * Run an observation unless the caller's signal or the mailbox's disposal is,
 * or becomes, aborted while it is in flight.
 *
 * A stalled remote read would otherwise hold an "abortable" wait open until
 * storage answered. The read itself is not cancelled — storage has no such
 * contract — but the wait stops honouring it.
 */
function raceAbort<T>(
  run: () => Promise<T>,
  disposal: AbortSignal,
  signal: AbortSignal | undefined,
): Promise<Raced<T>> {
  if (isAborted(disposal, signal)) {
    return Promise.resolve({ aborted: true, reason: abortReason(disposal, signal) });
  }
  // Kept to the fewest promise hops: the deterministic fake-timer tests drain a
  // fixed number of microtask turns between ticks.
  return new Promise<Raced<T>>((resolve, reject) => {
    const cleanup = new AbortController();
    const settle = (): void => {
      cleanup.abort();
      resolve({ aborted: true, reason: abortReason(disposal, signal) });
    };
    disposal.addEventListener('abort', settle, { once: true, signal: cleanup.signal });
    signal?.addEventListener('abort', settle, { once: true, signal: cleanup.signal });
    run()
      .then((value) => {
        cleanup.abort();
        resolve({ aborted: false, value });
      })
      .catch((error: unknown) => {
        cleanup.abort();
        reject(error as Error);
      });
  });
}

function abortReason(disposal: AbortSignal, signal: AbortSignal | undefined): unknown {
  return signal?.aborted === true ? (signal.reason as unknown) : (disposal.reason as unknown);
}

/** A cleanup-state read that rejects with the abort reason instead of outliving the wait. */
async function readUnlessAborted(
  runtime: MailboxRuntime,
  commandId: string,
  disposal: AbortSignal,
  signal: AbortSignal | undefined,
): Promise<ApplicationCommandCleanupResult> {
  const raced = await raceAbort(() => readCleanupState(runtime, commandId), disposal, signal);
  if (raced.aborted) throw raced.reason as Error;
  return raced.value;
}
