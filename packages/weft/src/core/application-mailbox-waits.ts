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
import { loadCommand, loadDeliveryHead } from './application-mailbox-storage.ts';

/** Default gap between durable polls. Overridable so tests can drive a fake clock. */
export const DEFAULT_MAILBOX_POLL_INTERVAL_MS = 50;

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

/** Whether the FIFO head exists and is due for delivery right now. */
export async function hasDueWork(runtime: MailboxRuntime): Promise<boolean> {
  const head = await loadDeliveryHead(runtime.storage, runtime.keys);
  if (head === null) return false;
  const loaded = await loadCommand(runtime.storage, runtime.keys, head.commandId);
  if (loaded === null) return false;
  return runtime.now() >= loaded.record.availableAt;
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
  const interval = options?.pollIntervalMs ?? DEFAULT_MAILBOX_POLL_INTERVAL_MS;
  const deadline = runtime.now() + (options?.timeoutMs ?? 0);
  while (true) {
    if (await hasDueWork(runtime)) return true;
    if (runtime.now() >= deadline) return false;
    if (!(await delayUnlessAborted(interval, disposal, options?.signal))) return false;
  }
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
  const interval = options.pollIntervalMs ?? DEFAULT_MAILBOX_POLL_INTERVAL_MS;
  const deadline = runtime.now() + options.timeoutMs;
  let latest = await readCleanupState(runtime, options.commandId);
  // A terminal record with `cleanupPending: true` is already final: the mailbox
  // recorded that it stopped waiting for an abandoned attempt. Polling it would
  // burn the whole timeout on a value that can never change again.
  if (latest.status === 'pending' && latest.receipt.terminalAt !== undefined) return latest;
  while (latest.status === 'pending' && runtime.now() < deadline) {
    if (!(await delayUnlessAborted(interval, disposal, options.signal))) break;
    latest = await readCleanupState(runtime, options.commandId);
  }
  return latest;
}
