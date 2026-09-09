/**
 * Timing helpers shared by the durable application primitives (the command
 * mailbox, WFT-84, and the delivery outbox, WFT-85): the deterministic retry
 * backoff every reschedule uses, and the abortable sleep every polling wait
 * uses.
 *
 * @module core/application-primitive-timing
 */

/** Deterministic exponential backoff. No jitter, so redelivery timing is testable. */
export function computeRetryBackoffMs(attempt: number, baseMs: number, maximumMs: number): number {
  const raw = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(Number.isFinite(raw) ? raw : maximumMs, maximumMs);
}

/**
 * Sleep, resolving `false` when the wait was aborted or the primitive disposed
 * and `true` when the interval actually elapsed.
 *
 * The listeners are removed on every path, including the timer path, so a
 * long-lived primitive does not accumulate abort listeners once per poll.
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
