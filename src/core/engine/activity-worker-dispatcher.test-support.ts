import type { ActivityWorkerDispatcher } from '../../workers/activity-worker-dispatcher.ts';
import type { Engine } from './index.ts';
import { getInternals } from './internals.ts';

export function setActivityWorkerDispatcherForTesting(
  engine: Engine,
  dispatcher: ActivityWorkerDispatcher,
): void {
  getInternals(engine).activityWorkerDispatcher = dispatcher;
}

/**
 * Dispose the engine's current activity worker dispatcher (if any) and install a
 * replacement. Use this when a test constructs the engine with a real
 * `activityExecution` pool and then needs to swap in a recording/poison dispatcher:
 * `setActivityWorkerDispatcherForTesting` only overwrites the slot, so the real
 * pool-backed dispatcher would leak unless disposed first. Disposing here keeps the
 * `internals` access encapsulated in the sanctioned engine test-support layer rather
 * than reaching into `internals.ts` from a `__tests__` file.
 */
export function replaceActivityWorkerDispatcherForTesting(
  engine: Engine,
  dispatcher: ActivityWorkerDispatcher,
): void {
  const internals = getInternals(engine);
  internals.activityWorkerDispatcher?.[Symbol.dispose]();
  internals.activityWorkerDispatcher = dispatcher;
}
