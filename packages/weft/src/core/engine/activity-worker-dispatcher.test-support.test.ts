/**
 * COR-1283: `setActivityWorkerDispatcherForTesting` — the plain "overwrite
 * the internals slot" half of this test-support module.
 * `replaceActivityWorkerDispatcherForTesting` (its dispose-then-replace
 * counterpart) is already exercised by `finalizer-teardown-worker.test.ts`.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import type {
  ActivityExecutionRequest,
  ActivityExecutionResult,
} from '../../workers/activity-runner.ts';
import type { ActivityWorkerDispatcher } from '../../workers/activity-worker-dispatcher.ts';
import { Engine } from '../engine.ts';
import { setActivityWorkerDispatcherForTesting } from './activity-worker-dispatcher.test-support.ts';
import { getInternals } from './internals.ts';

describe('setActivityWorkerDispatcherForTesting', () => {
  it("overwrites internals' activityWorkerDispatcher slot directly, without disposing a prior one", async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    expect(internals.activityWorkerDispatcher).toBeNull();

    const fakeDispatcher = {
      execute: async (request: ActivityExecutionRequest): Promise<ActivityExecutionResult> => ({
        operationId: request.operationId,
        status: 'completed',
        value: 'fake',
      }),
      get availableCount(): number {
        return 0;
      },
      get totalCount(): number {
        return 0;
      },
      get pendingCount(): number {
        return 0;
      },
      [Symbol.dispose](): void {},
      async [Symbol.asyncDispose](): Promise<void> {},
    } as unknown as ActivityWorkerDispatcher;

    setActivityWorkerDispatcherForTesting(engine, fakeDispatcher);

    expect(internals.activityWorkerDispatcher).toBe(fakeDispatcher);
  });
});
