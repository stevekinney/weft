/**
 * Racing an in-flight storage observation against abort signals (WFT-84).
 *
 * Storage has no cancellation contract, so a stalled remote read cannot be
 * cut short. What can be cut short is the caller's wait: the moment any of the
 * signals fires, the observation is reported as aborted and the read is left
 * to settle on its own. Kept to the fewest promise hops, because the
 * deterministic fake-timer tests drain a fixed number of microtask turns
 * between ticks.
 *
 * @module core/application-mailbox-abort
 */

/** The outcome of racing an in-flight observation against abort signals. */
export type Raced<T> =
  | { readonly aborted: false; readonly value: T }
  | { readonly aborted: true; readonly reason: unknown };

/**
 * Run an observation unless any of the signals is, or becomes, aborted while
 * it is in flight. `undefined` signals are ignored.
 */
export function raceAbort<T>(
  run: () => Promise<T>,
  ...signals: readonly (AbortSignal | undefined)[]
): Promise<Raced<T>> {
  const live = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const fired = live.find((signal) => signal.aborted);
  if (fired !== undefined)
    return Promise.resolve({ aborted: true, reason: fired.reason as unknown });
  return new Promise<Raced<T>>((resolve, reject) => {
    const cleanup = new AbortController();
    for (const signal of live) {
      signal.addEventListener(
        'abort',
        () => {
          cleanup.abort();
          resolve({ aborted: true, reason: signal.reason as unknown });
        },
        { once: true, signal: cleanup.signal },
      );
    }
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
