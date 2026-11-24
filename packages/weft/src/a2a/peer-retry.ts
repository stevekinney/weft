/**
 * The retry policy shared by every request the peer client makes.
 *
 * @module a2a/peer-retry
 */

import type { A2APeerError } from './peer-client-types.ts';

/** How requests are retried. */
export interface PeerRetryPolicy {
  /** Attempts per request, including the first. */
  readonly attempts: number;
  /** Delay before the first retry; doubles per attempt. */
  readonly baseDelayMs: number;
  /** The longest delay between retries or polls. */
  readonly maxDelayMs: number;
  /** Waits `ms`, resolving early when `signal` aborts. */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Turns anything a call threw into an {@link A2APeerError}. */
  readonly classify: (error: unknown) => A2APeerError;
}

/** The delay before retry number `attempt` (1 is the first retry). */
export function backoffMs(policy: PeerRetryPolicy, attempt: number): number {
  return Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
}

/** Read through a function so each check sees the signal as it is now. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Runs `call`, repeating it with backoff while it fails with a retryable error, up to
 * `policy.attempts` times. Stops at once when `signal` aborts, including during a backoff, so no
 * attempt starts after the abort.
 */
export async function retryRequest<T>(
  policy: PeerRetryPolicy,
  call: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 1; attempt < policy.attempts; attempt++) {
    try {
      return await call();
    } catch (error) {
      const classified = policy.classify(error);
      if (!classified.retryable || isAborted(signal)) throw classified;
      await policy.sleep(backoffMs(policy, attempt), signal);
      // A sleep resolves early when `signal` aborts: the request must not go out after that.
      if (isAborted(signal)) throw classified;
    }
  }
  // The last attempt has nothing left to retry, so its failure is final.
  try {
    return await call();
  } catch (error) {
    throw policy.classify(error);
  }
}
