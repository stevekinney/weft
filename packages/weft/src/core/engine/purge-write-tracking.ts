import type { EngineInternals } from './internals.ts';

/**
 * Register a purge write (or a bulk operation's audit record) in
 * `internals.inFlightPurgeWrites` for as long as it is pending. Storage calls
 * cannot be cancelled, so async disposal waits for writes already issued (a
 * purge that half-lands is worse than a slower shutdown) but never for the
 * reads around them: every tracked write checks `internals.disposed` before it
 * is issued, so a read still pending at disposal is safe to abandon.
 * Pass only the storage write itself, never a promise that also awaits a read.
 */
export function trackPurgeWrite<T>(internals: EngineInternals, write: Promise<T>): Promise<T> {
  internals.inFlightPurgeWrites.add(write);
  return write.finally(() => {
    internals.inFlightPurgeWrites.delete(write);
  });
}

/**
 * Settle every purge write issued before disposal. Never rejects: a failed write
 * is reported, if at all, by whoever issued it.
 */
export async function settleInFlightPurgeWrites(internals: EngineInternals): Promise<void> {
  await Promise.allSettled(internals.inFlightPurgeWrites);
}

const purgeWriteFailures = new WeakSet<object>();

/**
 * Await a purge write (a commit, or an orphaned-index delete), remembering any
 * error it fails with. Once the engine is disposed, the retention sweep reports
 * only these failures: the rest are disposal's own `EngineDisposedError` or a
 * read that async disposal abandoned, neither of which a live engine owns.
 */
export async function markPurgeWriteFailures<T>(write: Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (error) {
    if (typeof error === 'object' && error !== null) purgeWriteFailures.add(error);
    throw error;
  }
}

/** Whether `error` came out of a purge write marked by {@link markPurgeWriteFailures}. */
export function isPurgeWriteFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && purgeWriteFailures.has(error);
}
