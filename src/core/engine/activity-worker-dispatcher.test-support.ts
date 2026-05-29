import type { ActivityWorkerDispatcher } from '../../workers/activity-worker-dispatcher.ts';
import type { Engine } from './index.ts';
import { getInternals } from './internals.ts';

export function setActivityWorkerDispatcherForTesting(
  engine: Engine,
  dispatcher: ActivityWorkerDispatcher,
): void {
  getInternals(engine).activityWorkerDispatcher = dispatcher;
}
