import { describe, expect, it, mock, spyOn } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import type { HumanReviewResult, ReviewRequest } from '../review/index.ts';
import {
  completedReviewStoragePrefix,
  deleteCompletedReviewsForWorkflow,
  listCompletedReviewsFromStorage,
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
    storage.conditionalBatch = mock(async () => false) as typeof storage.conditionalBatch;

    await expect(
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
    ).rejects.toThrow('Completed review commit for review "review-1" lost its precondition.');
  });
});
