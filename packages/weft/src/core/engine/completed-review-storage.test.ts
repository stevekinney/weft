import { describe, expect, it, mock, spyOn } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { throwingRejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { encode } from '../codec.ts';
import type { HumanReviewResult, ReviewRequest } from '../review/index.ts';
import {
  completedReviewStorageKey,
  completedReviewStoragePrefix,
  deleteCompletedReviewsForWorkflow,
  listCompletedReviewsFromStorage,
  listReviewKeysForWorkflow,
  matchesReviewListFilter,
  persistCompletedReviewRecord,
} from './completed-review-storage.ts';
import { encodeEpoch } from './lease-codec.ts';
import { toCompletedReviewEntry } from './review-list-entries.ts';

function createReviewRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    reviewId: 'review-1',
    workflowId: 'workflow-1',
    artifact: { ok: true },
    reviewType: 'content',
    reviewers: ['alex'],
    allowPartial: false,
    createdAt: 100,
    ...overrides,
  };
}

function createDecision(overrides: Partial<HumanReviewResult> = {}): HumanReviewResult {
  return {
    reviewId: 'review-1',
    decision: 'approved',
    reviewer: 'alex',
    timestamp: 200,
    ...overrides,
  };
}

describe('completed review storage helpers', () => {
  it('matches filters and prefixes deterministically', () => {
    expect(matchesReviewListFilter({ workflowId: 'a' }, { workflowId: 'b' })).toBe(false);
    expect(matchesReviewListFilter({ reviewType: 'content' }, { reviewType: 'legal' })).toBe(false);
    expect(completedReviewStoragePrefix()).toBe('review-decision:');
  });

  it('lists scoped reviews without duplicating the prefixed scan', async () => {
    const storage = new MemoryStorage();
    const workflowScopedReview = toCompletedReviewEntry(createReviewRequest(), createDecision());
    const globalReview = toCompletedReviewEntry(
      createReviewRequest({ reviewId: 'review-2', workflowId: 'workflow-2' }),
      createDecision({ reviewId: 'review-2' }),
    );

    await storage.put('review-decision:workflow-1:review-1', encode(workflowScopedReview));
    await storage.put('review-decision:global-review-2', encode(globalReview));

    const reviews = await listCompletedReviewsFromStorage(storage, { workflowId: 'workflow-1' });

    expect(reviews).toEqual([workflowScopedReview]);
  });

  it('persists completed review records and deletes workflow-linked completions without deletePrefix support', async () => {
    const storage = new MemoryStorage();
    Object.defineProperty(storage, 'deletePrefix', { configurable: true, value: undefined });

    const reviewRequest = createReviewRequest();
    const decision = createDecision();

    await persistCompletedReviewRecord(
      {
        deposed: false,
        engine: {},
        leaseManager: null,
        options: { ownershipMode: 'none' },
        storage,
      } as never,
      'review:workflow-1:review-1',
      reviewRequest,
      decision,
    );
    const batch = spyOn(storage, 'batch');

    await storage.put(
      'review-decision:shadow',
      encode(
        toCompletedReviewEntry(
          createReviewRequest({ reviewId: 'review-shadow', workflowId: 'workflow-1' }),
          createDecision({ reviewId: 'review-shadow' }),
        ),
      ),
    );
    await storage.put(
      'review-decision:workflow-2:review-keep',
      encode(
        toCompletedReviewEntry(
          createReviewRequest({ reviewId: 'review-keep', workflowId: 'workflow-2' }),
          createDecision({ reviewId: 'review-keep' }),
        ),
      ),
    );

    await deleteCompletedReviewsForWorkflow(storage, 'workflow-1');

    expect(batch).toHaveBeenCalled();
    batch.mockRestore();
  });

  it('surfaces lease-fenced precondition loss when persisting a completed review', async () => {
    const storage = new MemoryStorage();
    const epochBytes = encodeEpoch(1);
    await storage.put(KEYS.leaseEpoch(), epochBytes);
    storage.conditionalBatch = mock(async () => false);

    expect(
      await throwingRejectionOf(
        persistCompletedReviewRecord(
          {
            deposed: false,
            engine: {},
            leaseManager: { currentEpochBytes: () => epochBytes },
            options: { ownershipMode: 'lease' },
            storage,
            tearDownAfterDeposition: null,
          } as never,
          'review:workflow-1:review-1',
          createReviewRequest(),
          createDecision(),
        ),
      ),
    ).toThrow('Completed review commit for review "review-1" lost its precondition.');
  });

  it('lists every pending and completed review key of one workflow, including legacy decisions stored outside its prefix', async () => {
    const storage = new MemoryStorage();
    const entry = (workflowId: string, reviewId: string) =>
      encode(
        toCompletedReviewEntry(
          createReviewRequest({ reviewId, workflowId }),
          createDecision({ reviewId }),
        ),
      );
    await storage.put(KEYS.review('workflow-1', 'pending-1'), encode({ status: 'pending' }));
    await storage.put(
      completedReviewStorageKey('workflow-1', 'done-1'),
      entry('workflow-1', 'done-1'),
    );
    await storage.put('review-decision:legacy-shadow', entry('workflow-1', 'shadow'));
    await storage.put('review-decision:legacy-other', entry('workflow-2', 'other'));
    await storage.put(KEYS.review('workflow-2', 'pending-2'), encode({ status: 'pending' }));

    const keys: string[] = [];
    for await (const key of listReviewKeysForWorkflow(storage, 'workflow-1')) keys.push(key);

    expect(keys.toSorted()).toEqual(
      [
        KEYS.review('workflow-1', 'pending-1'),
        completedReviewStorageKey('workflow-1', 'done-1'),
        'review-decision:legacy-shadow',
      ].toSorted(),
    );
  });

  it("deletes a workflow's completed reviews with the native deletePrefix when the storage has one", async () => {
    const storage = new MemoryStorage();
    const key = completedReviewStorageKey('workflow-1', 'done-1');
    const keep = completedReviewStorageKey('workflow-2', 'done-2');
    await storage.put(key, encode({ placeholder: true }));
    await storage.put(keep, encode({ placeholder: true }));

    await deleteCompletedReviewsForWorkflow(storage, 'workflow-1');

    expect(await storage.get(key)).toBeNull();
    expect(await storage.get(keep)).not.toBeNull();
  });
});
