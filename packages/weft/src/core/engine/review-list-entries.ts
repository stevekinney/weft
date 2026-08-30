import type { z } from 'zod';

import { decode } from '../codec.ts';
import {
  completedReviewEntrySchema,
  reviewRequestSchema,
  type HumanReviewResult,
  type ReviewRequest,
} from '../review/index.ts';
import type { CompletedReviewEntry, PendingReviewEntry } from '../types.ts';

type ParsedReviewRequest = z.output<typeof reviewRequestSchema>;
type ParsedCompletedReviewEntry = z.output<typeof completedReviewEntrySchema>;

function assignWhenDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

export function toPendingReviewEntry(review: ReviewRequest): PendingReviewEntry {
  return {
    status: 'pending',
    ...review,
  };
}

function normalizeStoredReviewRequest(review: ParsedReviewRequest): ReviewRequest {
  const normalizedReview: ReviewRequest = {
    reviewId: review.reviewId,
    workflowId: review.workflowId,
    artifact: review.artifact,
    reviewType: review.reviewType,
    reviewers: review.reviewers,
    allowPartial: review.allowPartial,
    createdAt: review.createdAt,
  };

  assignWhenDefined(normalizedReview, 'timeout', review.timeout);
  assignWhenDefined(normalizedReview, 'webhookUrl', review.webhookUrl);

  return normalizedReview;
}

export function parseStoredReviewRequest(value: Uint8Array): ReviewRequest | null {
  let decodedValue: unknown;
  try {
    decodedValue = decode(value);
  } catch {
    return null;
  }

  const parsedReview = reviewRequestSchema.safeParse(decodedValue);
  if (!parsedReview.success) {
    return null;
  }

  return normalizeStoredReviewRequest(parsedReview.data);
}

export function toCompletedReviewEntry(
  review: ReviewRequest,
  decisionResult: HumanReviewResult,
): CompletedReviewEntry {
  const completedReview: CompletedReviewEntry = {
    status: 'completed',
    reviewId: review.reviewId,
    workflowId: review.workflowId,
    artifact: review.artifact,
    reviewType: review.reviewType,
    reviewers: review.reviewers,
    allowPartial: review.allowPartial,
    createdAt: review.createdAt,
    decision: decisionResult.decision,
    reviewer: decisionResult.reviewer,
    timestamp: decisionResult.timestamp,
  };

  assignWhenDefined(completedReview, 'timeout', review.timeout);
  assignWhenDefined(completedReview, 'webhookUrl', review.webhookUrl);
  assignWhenDefined(completedReview, 'feedback', decisionResult.feedback);
  assignWhenDefined(completedReview, 'sectionDecisions', decisionResult.sectionDecisions);

  return completedReview;
}

function normalizeCompletedReviewEntry(
  persistedReview: ParsedCompletedReviewEntry,
): CompletedReviewEntry {
  const completedReview: CompletedReviewEntry = {
    status: 'completed',
    reviewId: persistedReview.reviewId,
    workflowId: persistedReview.workflowId,
    artifact: persistedReview.artifact,
    reviewType: persistedReview.reviewType,
    reviewers: persistedReview.reviewers,
    allowPartial: persistedReview.allowPartial,
    createdAt: persistedReview.createdAt,
    decision: persistedReview.decision,
    reviewer: persistedReview.reviewer,
    timestamp: persistedReview.timestamp,
  };

  assignWhenDefined(completedReview, 'timeout', persistedReview.timeout);
  assignWhenDefined(completedReview, 'webhookUrl', persistedReview.webhookUrl);
  assignWhenDefined(completedReview, 'feedback', persistedReview.feedback);
  assignWhenDefined(completedReview, 'sectionDecisions', persistedReview.sectionDecisions);

  return completedReview;
}

export function parseCompletedReviewEntry(value: Uint8Array): CompletedReviewEntry | null {
  let decodedValue: unknown;
  try {
    decodedValue = decode(value);
  } catch {
    return null;
  }

  const parsedReview = completedReviewEntrySchema.safeParse(decodedValue);
  if (!parsedReview.success) {
    return null;
  }

  return normalizeCompletedReviewEntry(parsedReview.data);
}
