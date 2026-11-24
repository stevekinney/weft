/**
 * Postgres `SQLSTATE`s that abort a transaction but mean "retry from the start",
 * not "the operation is invalid":
 * - `40001` serialization_failure — a `SERIALIZABLE` transaction conflicted with
 *   a concurrent one and was rolled back.
 * - `40P01` deadlock_detected — two transactions touched overlapping rows in
 *   different orders; Postgres rolled one back as the deadlock victim. Two CAS
 *   calls gated on different keys can deadlock, so this must converge through the
 *   same retry path rather than escape as an engine error.
 *
 * A unique-violation (`23505`) is intentionally NOT retryable here: every write
 * goes through `INSERT ... ON CONFLICT (key) DO UPDATE`, which resolves a key
 * collision instead of raising `23505`, so it cannot occur on this UPSERT shape.
 *
 * The deadlock victim's rollback is total, so retrying the whole
 * `BEGIN → read → compare → write → COMMIT` cycle (re-reading every condition) is
 * as safe for `40P01` as for `40001`.
 */
const RETRYABLE_TRANSACTION_FAILURES = new Set(['40001', '40P01']);

/**
 * Cap on `SERIALIZABLE` attempts for a single `conditionalBatch`. A conflict
 * means a concurrent writer touched an overlapping row. Writers that all write
 * one key serialize one commit per round: the winner commits and Postgres
 * aborts every waiter with `40001`, so the last of N writers needs N rounds if
 * they retry in lockstep. The wait below spreads the retries out so the queue
 * drains in a few rounds; 12 attempts leave that headroom for a small fixed set
 * of writers (two hosts booting against one database, a handful of workers)
 * while still bounding a transaction that can never commit. The worst-case wait
 * across all 12 attempts is under 2.3 seconds (11 waits, each below 320 ms).
 * On exhaustion the call throws rather than silently returning `false` — a
 * silent `false` would look like a precondition mismatch and corrupt the
 * compare-and-swap callers (start idempotency, quota reservation) depend on.
 */
export const MAX_SERIALIZATION_RETRIES = 12;

/** First retry's jitter window, in milliseconds. */
const SERIALIZATION_RETRY_BASE_DELAY_MILLISECONDS = 10;

/** Upper bound on any retry's jitter window, in milliseconds (the window doubles until it hits this). */
const SERIALIZATION_RETRY_MAXIMUM_DELAY_MILLISECONDS = 320;

/**
 * How `conditionalBatch` waits between `SERIALIZABLE` attempts. Both members are injectable so
 * tests stay deterministic and never sleep.
 */
export type SerializationRetryOptions = {
  /**
   * Wait this many milliseconds before the next attempt. Default: a `setTimeout`-backed sleep.
   */
  delay?: (milliseconds: number) => Promise<void>;
  /**
   * Uniform random draw in `[0, 1)` that scales each wait (full jitter). Default: `Math.random`.
   */
  random?: () => number;
};

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Full-jitter exponential backoff: a uniform wait in `[0, window)` where the window starts at
 * {@link SERIALIZATION_RETRY_BASE_DELAY_MILLISECONDS}, doubles per retry, and is capped at
 * {@link SERIALIZATION_RETRY_MAXIMUM_DELAY_MILLISECONDS}. `retry` is zero-based.
 */
export function serializationRetryDelay(retry: number, random: () => number): number {
  const window = Math.min(
    SERIALIZATION_RETRY_MAXIMUM_DELAY_MILLISECONDS,
    SERIALIZATION_RETRY_BASE_DELAY_MILLISECONDS * 2 ** retry,
  );
  return Math.floor(random() * window);
}

export function isRetryableTransactionFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && RETRYABLE_TRANSACTION_FAILURES.has(code);
}
