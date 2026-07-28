import type { EngineInternals } from './internals.ts';

/**
 * Bound for {@link waitForSleepResolverReadyForTesting}.
 *
 * The only production-adjacent consumer of the hook awaits it inside the
 * `weft:test:periodic-sync` Service Worker message handler in
 * service-worker-browser.test.ts, and that file bounds each message round trip
 * at 5s (`sendWorkerMessage`), each phase at 15s, and each test at 30s. This
 * bound has to be strictly tighter than the innermost of those — at 5s it would
 * tie with the message bound and the generic "Service Worker message timed out"
 * would likely win the race, hiding the diagnostic this bound exists to
 * produce. 3s expires first, so the workflow-naming error is what reaches CI.
 */
export const SLEEP_RESOLVER_READY_WAIT_TIMEOUT_MS_FOR_TESTING = 3_000;

/**
 * Test-only, timeout-bounded wait for a workflow to register a sleep resolver.
 *
 * Resolves immediately, without arming a timer, if a resolver is already
 * registered for `workflowId` — the happy path used by
 * `ENGINE_WAIT_FOR_SLEEP_RESOLVER_FOR_TESTING` is unaffected by this bound.
 * Otherwise it waits for `registerSleepResolver` (operations-time.ts) or engine
 * disposal (disposal.ts) to notify readiness, and rejects with a diagnostic
 * naming the workflow if neither happens within
 * {@link SLEEP_RESOLVER_READY_WAIT_TIMEOUT_MS_FOR_TESTING}. The timeout timer
 * is cleared on every settlement path (resolve, reject, or timeout) so no test
 * leaks a pending timer.
 */
export function waitForSleepResolverReadyForTesting(
  internals: EngineInternals,
  workflowId: string,
): Promise<void> {
  if (internals.sleepResolversByWorkflow.has(workflowId)) return Promise.resolve();

  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let waiters = internals.sleepResolverReadyWaitersForTesting?.get(workflowId);
  if (waiters === undefined) {
    waiters = new Set();
    internals.sleepResolverReadyWaitersForTesting?.set(workflowId, waiters);
  }
  waiters.add(resolve);

  const timeoutHandle = setTimeout(() => {
    const pendingWaiters = internals.sleepResolverReadyWaitersForTesting?.get(workflowId);
    if (pendingWaiters !== undefined) {
      pendingWaiters.delete(resolve);
      if (pendingWaiters.size === 0) {
        internals.sleepResolverReadyWaitersForTesting?.delete(workflowId);
      }
    }
    reject(
      new Error(
        `Timed out after ${SLEEP_RESOLVER_READY_WAIT_TIMEOUT_MS_FOR_TESTING}ms waiting for workflow "${workflowId}" to register a sleep resolver`,
      ),
    );
  }, SLEEP_RESOLVER_READY_WAIT_TIMEOUT_MS_FOR_TESTING);

  return promise.finally(() => clearTimeout(timeoutHandle));
}
