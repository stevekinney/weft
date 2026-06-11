/**
 * Deferred-consume envelopes for `wait-signal` branches inside `ctx.race` /
 * `ctx.all`.
 *
 * A `wait-signal` branch must NOT destructively consume its durable signal
 * record when it is woken — at that moment it does not yet know whether it WON
 * its race. If a losing branch consumed, it would delete a signal that a later
 * `waitForSignal` (or a replay) still needs. So a woken wait-signal branch
 * resolves with one of these envelopes instead of a value: the branch defers the
 * single destructive {@link import('./signals.ts').consumeSignal} into
 * `finalize`, and ONLY the coordinator — which authoritatively knows the race
 * winner once `Promise.race` settles — calls `finalize()`, on the winner alone.
 * Losing branches drop their envelope unfinalized and release their waiter
 * without consuming, so the signal survives.
 *
 * The envelope is branded with a unique {@link DEFERRED_CONSUME_BRAND} symbol and
 * detected ONLY by that symbol, never structurally — a user's signal payload can
 * legitimately be an object shaped like `{ finalize }`, and a structural check
 * would misfire on it.
 *
 * Envelopes must never reach the durable operation cache (a function cannot
 * round-trip `encode`/`decode`), so the coordinator finalize-and-unwraps every
 * winning branch's envelope before the operation result is written. wait-signal
 * is currently allowed only as a DIRECT branch of the top-level coordination, so
 * an envelope is always a scalar branch result here; nested wait-signal (where a
 * nested `ctx.all` could surface envelopes inside an array) is rejected upstream.
 */

const DEFERRED_CONSUME_BRAND: unique symbol = Symbol('weft.deferredConsume');

/**
 * A branch result whose real value is produced by a single deferred consume that
 * only the winning coordinator performs.
 */
export type DeferredConsumeEnvelope = {
  readonly [DEFERRED_CONSUME_BRAND]: true;
  /** Perform the single destructive consume and return the consumed payload. */
  readonly finalize: () => Promise<unknown>;
};

/** Wrap a deferred consume into a branded envelope. */
export function createDeferredConsumeEnvelope(
  finalize: () => Promise<unknown>,
): DeferredConsumeEnvelope {
  return { [DEFERRED_CONSUME_BRAND]: true, finalize };
}

/** Detect an envelope by its brand symbol only (never structurally). */
export function isDeferredConsumeEnvelope(value: unknown): value is DeferredConsumeEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[DEFERRED_CONSUME_BRAND] === true
  );
}

/**
 * Finalize-and-unwrap a coordination result before it is written to the durable
 * cache. A winning `wait-signal` branch surfaces a {@link DeferredConsumeEnvelope}
 * whose `finalize()` performs the single consume; any other value passes through
 * untouched.
 *
 * This runs only on the WINNING path (race winner, or every branch of a settled
 * `ctx.all`), so finalizing here is exactly the linearization point of "this
 * branch won" — the consume happens strictly after the coordinator settled.
 */
export async function finalizeAndUnwrap(value: unknown): Promise<unknown> {
  if (isDeferredConsumeEnvelope(value)) {
    return value.finalize();
  }
  return value;
}
