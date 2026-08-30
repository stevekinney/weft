import type { BatchOperation, Storage } from '../../storage/interface.ts';
import { encodeStorageKeyComponent } from '../../storage/interface.ts';
import { encode } from '../codec.ts';
import type { HumanReviewResult, ReviewRequest } from '../review/index.ts';
import type { CompletedReviewEntry, ReviewListFilter } from '../types.ts';
import { commitFencedEngineWrite } from './fenced-write.ts';
import type { EngineInternals } from './internals.ts';
import { parseCompletedReviewEntry, toCompletedReviewEntry } from './review-list-entries.ts';

type ReviewListFilterableEntry = {
  workflowId?: string;
  reviewType?: string;
};

export function matchesReviewListFilter(
  review: ReviewListFilterableEntry,
  filter: ReviewListFilter,
): boolean {
  if (filter.workflowId !== undefined && review.workflowId !== filter.workflowId) {
    return false;
  }

  if (filter.reviewType !== undefined && review.reviewType !== filter.reviewType) {
    return false;
  }

  return true;
}

export function completedReviewStoragePrefix(workflowId?: string): string {
  if (workflowId === undefined) {
    return 'review-decision:';
  }

  return `review-decision:${encodeStorageKeyComponent(workflowId)}:`;
}

export function completedReviewStorageKey(workflowId: string, reviewId: string): string {
  return `${completedReviewStoragePrefix(workflowId)}${encodeStorageKeyComponent(reviewId)}`;
}

async function appendCompletedReviews(
  reviews: CompletedReviewEntry[],
  entries: AsyncIterable<[string, Uint8Array]>,
  filter: ReviewListFilter,
  keyPredicate: (key: string) => boolean = () => true,
): Promise<void> {
  for await (const [key, value] of entries) {
    if (!keyPredicate(key)) {
      continue;
    }

    const completedReview = parseCompletedReviewEntry(value);
    if (completedReview !== null && matchesReviewListFilter(completedReview, filter)) {
      reviews.push(completedReview);
    }
  }
}

export async function listCompletedReviewsFromStorage(
  storage: Storage,
  filter: ReviewListFilter,
): Promise<CompletedReviewEntry[]> {
  const reviews: CompletedReviewEntry[] = [];
  const scopedPrefix =
    filter.workflowId === undefined ? null : completedReviewStoragePrefix(filter.workflowId);

  if (scopedPrefix !== null) {
    await appendCompletedReviews(reviews, storage.scan(scopedPrefix), filter);
  }

  await appendCompletedReviews(
    reviews,
    storage.scan('review-decision:'),
    filter,
    (key) => scopedPrefix === null || !key.startsWith(scopedPrefix),
  );

  return reviews;
}

export async function persistCompletedReviewRecord(
  internals: EngineInternals,
  reviewKey: string,
  reviewData: ReviewRequest,
  decisionResult: HumanReviewResult,
): Promise<void> {
  const completedReview = toCompletedReviewEntry(reviewData, decisionResult);
  await commitFencedEngineWrite(
    internals,
    reviewData.workflowId,
    [
      {
        type: 'put',
        key: completedReviewStorageKey(reviewData.workflowId, reviewData.reviewId),
        value: encode(completedReview),
      },
      { type: 'delete', key: reviewKey },
    ],
    [],
    () =>
      new Error(
        `Completed review commit for review "${reviewData.reviewId}" lost its precondition.`,
      ),
  );
}

export async function deleteCompletedReviewsForWorkflow(
  storage: Storage,
  workflowId: string,
): Promise<void> {
  const completedPrefix = completedReviewStoragePrefix(workflowId);
  const deleteOperations: BatchOperation[] = [];

  if (storage.deletePrefix) {
    await storage.deletePrefix(completedPrefix);
  } else {
    for await (const [key] of storage.scan(completedPrefix)) {
      deleteOperations.push({ type: 'delete', key });
    }
  }

  for await (const [key, value] of storage.scan('review-decision:')) {
    if (key.startsWith(completedPrefix)) {
      continue;
    }

    const completedReview = parseCompletedReviewEntry(value);
    if (completedReview?.workflowId === workflowId) {
      deleteOperations.push({ type: 'delete', key });
    }
  }

  if (deleteOperations.length > 0) {
    await storage.batch(deleteOperations);
  }
}
