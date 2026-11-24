import { describe, expect, it, mock } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { throwingRejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { KEYS } from '../../storage/keys.ts';
import { registerPendingAsyncActivity } from './async-activity-records.ts';
import { encodeEpoch } from './lease-codec.ts';

describe('async activity registration', () => {
  it('surfaces lease-fenced precondition loss while registering a pending async activity', async () => {
    const storage = new MemoryStorage();
    const epochBytes = encodeEpoch(1);
    await storage.put(KEYS.leaseEpoch(), epochBytes);
    storage.conditionalBatch = mock(async () => false);

    expect(
      await throwingRejectionOf(
        registerPendingAsyncActivity(
          {
            deposed: false,
            engine: { dispatchEvent: () => true },
            leaseManager: { currentEpochBytes: () => epochBytes },
            options: { ownershipMode: 'lease' },
            pendingAsyncActivities: new Map(),
            storage,
            tearDownAfterDeposition: null,
          } as never,
          {
            token: 'token-1',
            workflowId: 'workflow-1',
            activityName: 'await-callback',
            operationId: 'operation-1',
            step: 1,
            attempt: 1,
            createdAt: 1_000,
          },
        ),
      ),
    ).toThrow('Async activity registration for token "token-1" lost its precondition.');
  });
});
