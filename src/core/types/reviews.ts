import type { ReviewDecisionRecord, ReviewRequest } from '../review/index.ts';

// ---------------------------------------------------------------------------
// Review decision types (for engine.submitReview)
// ---------------------------------------------------------------------------

/**
 * Outcome of a human review step initiated by `ctx.waitForReview`. Pass as
 * the `decision` field in {@link SubmitReviewOptions} when calling
 * `engine.submitReview`.
 */
export type ReviewDecision = 'approved' | 'rejected' | 'needs-changes';

/**
 * Options for `engine.submitReview`. Supply the `decision`, the `reviewer`
 * identifier, and optional `feedback`. For workflows with partial approval
 * semantics, provide `sectionDecisions`. Pass `workflowId` when you know the
 * target workflow ID to avoid a full storage scan.
 *
 * @example
 * ```ts
 * import { Engine, type SubmitReviewOptions } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * const options: SubmitReviewOptions = {
 *   decision: 'approved',
 *   reviewer: 'alice@example.com',
 *   feedback: 'Looks good',
 *   workflowId: 'wf-123',
 * };
 * // await engine.submitReview('review-key', options);
 * void options;
 * ```
 */
export interface SubmitReviewOptions {
  decision: ReviewDecision;
  reviewer: string;
  feedback?: string;
  /** Per-section decisions for partial approval workflows. */
  sectionDecisions?: Record<string, 'approved' | 'rejected'>;
  /** When provided, enables O(1) direct key lookup instead of scanning. */
  workflowId?: string;
}

/**
 * Status values returned by `engine.listReviews(filter?)`.
 *
 * Pending entries represent outstanding review requests; completed entries
 * combine the original review metadata with the persisted reviewer decision.
 *
 * @example
 * ```ts
 * import type { ReviewStatus } from '@lostgradient/weft';
 *
 * const status: ReviewStatus = 'pending';
 * void status;
 * ```
 */
export type ReviewStatus = 'pending' | 'completed';

/**
 * Filter accepted by `engine.listReviews(filter?)` and the `/v1/reviews`
 * transport surfaces.
 *
 * Omitting `status` lists pending reviews; pass `status: 'completed'` to list
 * completed reviews instead.
 *
 * @example
 * ```ts
 * import type { ReviewListFilter } from '@lostgradient/weft';
 *
 * const filter: ReviewListFilter = {
 *   status: 'completed',
 *   workflowId: 'wf-123',
 *   reviewType: 'security',
 * };
 * void filter;
 * ```
 */
export interface ReviewListFilter {
  status?: ReviewStatus;
  workflowId?: string;
  reviewType?: string;
}

/**
 * Pending review entry returned by `engine.listReviews(filter?)`.
 *
 * Mirrors the durable review request plus a discriminating `status` field.
 *
 * @example
 * ```ts
 * import type { PendingReviewEntry } from '@lostgradient/weft';
 *
 * const entry: PendingReviewEntry = {
 *   status: 'pending',
 *   reviewId: 'review-1',
 *   workflowId: 'wf-1',
 *   artifact: { text: 'Please approve' },
 *   reviewType: 'content',
 *   reviewers: ['alice@example.com'],
 *   allowPartial: false,
 *   createdAt: Date.now(),
 * };
 * void entry;
 * ```
 */
export interface PendingReviewEntry extends ReviewRequest {
  status: 'pending';
}

/**
 * Completed review entry returned by `engine.listReviews(filter?)`.
 *
 * Completed review records include the original request metadata plus the
 * persisted reviewer decision.
 *
 * @example
 * ```ts
 * import type { CompletedReviewEntry } from '@lostgradient/weft';
 *
 * const entry: CompletedReviewEntry = {
 *   status: 'completed',
 *   reviewId: 'review-1',
 *   workflowId: 'wf-1',
 *   artifact: { text: 'Please approve' },
 *   reviewType: 'content',
 *   reviewers: ['alice@example.com'],
 *   allowPartial: false,
 *   createdAt: Date.now() - 5_000,
 *   decision: 'approved',
 *   reviewer: 'alice@example.com',
 *   timestamp: Date.now(),
 * };
 * void entry;
 * ```
 */
export interface CompletedReviewEntry extends ReviewDecisionRecord {
  status: 'completed';
  workflowId: string;
  artifact: unknown;
  reviewType: string;
  reviewers: string[];
  allowPartial: boolean;
  timeout?: number;
  webhookUrl?: string;
  createdAt: number;
}

/**
 * Discriminated union returned by `engine.listReviews(filter?)`.
 *
 * Use `status` to branch between pending request metadata and completed
 * decision metadata.
 *
 * @example
 * ```ts
 * import type { ReviewListEntry } from '@lostgradient/weft';
 *
 * function summarize(entry: ReviewListEntry): string {
 *   return entry.status === 'completed'
 *     ? `${entry.reviewType}: ${entry.decision}`
 *     : `${entry.reviewType}: pending`;
 * }
 * void summarize;
 * ```
 */
export type ReviewListEntry = PendingReviewEntry | CompletedReviewEntry;

// ---------------------------------------------------------------------------
// Coordinated update result (for engine.submitCoordinatedUpdate)
// ---------------------------------------------------------------------------

/**
 * Result of a coordinated update sent via `engine.submitCoordinatedUpdate`.
 * Contains the `updateId` and either the resolved `result` or an `error`
 * string if the workflow handler threw.
 * Exactly one of `result` or `error` is populated for a settled update:
 * `result` on handler success, `error` (a stringified failure message) on
 * handler throw. Both may be `undefined` on transport-level rejections from
 * `HttpClient.submitCoordinatedUpdate`.
 */
export interface CoordinatedUpdateResult {
  updateId: string;
  result?: unknown;
  error?: string;
}
