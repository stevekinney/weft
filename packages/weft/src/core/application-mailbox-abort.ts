/**
 * Racing an in-flight storage observation against abort signals (WFT-84).
 *
 * Storage has no cancellation contract, so a stalled remote read cannot be
 * cut short. What can be cut short is the caller's wait: the moment any of the
 * signals fires, or the wait's own budget runs out, the observation is
 * reported as aborted and the read is left to settle on its own. Kept to the
 * fewest promise hops, because the deterministic fake-timer tests drain a
 * fixed number of microtask turns between ticks.
 *
 * @module core/application-mailbox-abort
 */

import { WeftError } from './weft-error.ts';

/** The outcome of racing an in-flight observation against abort signals. */
export type Raced<T> =
  | { readonly aborted: false; readonly value: T }
  | { readonly aborted: true; readonly reason: unknown };

/**
 * Thrown by `ApplicationMailbox.awaitCleanup()` when a positive budget runs out
 * while the FIRST cleanup-state read is still in flight — there is no
 * observation yet to report as `pending`. Nothing durable changed; the wait is
 * simply over.
 *
 * @example
 * ```ts
 * import { WaitBudgetElapsedError } from '@lostgradient/weft';
 *
 * const error = new WaitBudgetElapsedError();
 * console.log(error.code); // 'WaitBudgetElapsedError'
 * ```
 */
export class WaitBudgetElapsedError extends WeftError<'WaitBudgetElapsedError'> {
  constructor() {
    super(
      'WaitBudgetElapsedError',
      'The wait budget elapsed while a storage observation was still in flight.',
    );
  }
}

/**
 * Run an observation unless any of the signals is, or becomes, aborted while
 * it is in flight. `undefined` signals are ignored.
 */
export function raceAbort<T>(
  run: () => Promise<T>,
  ...signals: readonly (AbortSignal | undefined)[]
): Promise<Raced<T>> {
  return raceAbortWithin(run, null, ...signals);
}

/**
 * `raceAbort` with a budget: when `budgetMs` is a positive number, a timer of
 * that length also ends the race, with `WaitBudgetElapsedError` as the reason.
 * A bounded wait is bounded by this even while a remote read is stalled; the
 * sleeps between observations are not the only place a budget can run out.
 */
export function raceAbortWithin<T>(
  run: () => Promise<T>,
  budgetMs: number | null,
  ...signals: readonly (AbortSignal | undefined)[]
): Promise<Raced<T>> {
  const live = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const fired = live.find((signal) => signal.aborted);
  if (fired !== undefined) {
    return Promise.resolve({ aborted: true, reason: fired.reason as unknown });
  }
  return new Promise<Raced<T>>((resolve, reject) => {
    const cleanup = new AbortController();
    const timer =
      budgetMs === null || budgetMs <= 0
        ? null
        : setTimeout(() => {
            cleanup.abort();
            resolve({ aborted: true, reason: new WaitBudgetElapsedError() });
          }, budgetMs);
    const settle = (): void => {
      cleanup.abort();
      if (timer !== null) clearTimeout(timer);
    };
    for (const signal of live) {
      signal.addEventListener(
        'abort',
        () => {
          settle();
          resolve({ aborted: true, reason: signal.reason as unknown });
        },
        { once: true, signal: cleanup.signal },
      );
    }
    run()
      .then((value) => {
        settle();
        resolve({ aborted: false, value });
      })
      .catch((error: unknown) => {
        settle();
        reject(error as Error);
      });
  });
}
