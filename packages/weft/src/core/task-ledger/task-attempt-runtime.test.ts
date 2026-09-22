/**
 * COR-1283: `buildCurrentAttemptDispositionWrites`'s "no attempt to update"
 * fallback — a `current` record whose state is not `'leased'` /
 * `'completing'` / `'cancelling'` (e.g. still `'queued'`) never held an
 * attempt token, so there is nothing to write. Acceptance criterion 2's
 * "no attempt ever existed" case.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { buildCurrentAttemptDispositionWrites } from './task-attempt-runtime.ts';
import type { RemoteTaskQueued } from './task-ledger-types.ts';

function queuedFixture(): RemoteTaskQueued {
  return {
    recordVersion: 1,
    operationId: 'op-1',
    workflowType: 'checkout',
    workflowExecutionToken: 'token-1',
    activityName: 'charge',
    queue: 'default',
    input: { amount: 100 },
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: 1_000,
    generation: 0,
    state: 'queued',
    attempt: 1,
    availableAt: 1_000,
    firstQueuedAt: 1_000,
    lastQueuedAt: 1_000,
    retryCount: 0,
    requeueCount: 0,
  };
}

describe('buildCurrentAttemptDispositionWrites', () => {
  it('returns no writes when current is null', async () => {
    const storage = new MemoryStorage();
    const writes = await buildCurrentAttemptDispositionWrites(storage, null, {
      disposition: 'resolved',
    });
    expect(writes).toEqual([]);
  });

  it('returns no writes when current has never held an attempt (still queued)', async () => {
    const storage = new MemoryStorage();
    const writes = await buildCurrentAttemptDispositionWrites(storage, queuedFixture(), {
      disposition: 'resolved',
    });
    expect(writes).toEqual([]);
  });
});
