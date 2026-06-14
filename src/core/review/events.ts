/**
 * Fired by {@link ReviewCoordinator} when a new human review request is
 * persisted. Carries the `workflowId`, `reviewId`, `reviewType`, and the list
 * of requested `reviewers`. Subscribe to this event to notify reviewers via
 * email, webhook, or ticketing system.
 *
 * @example Route review notifications to a webhook
 * ```ts
 * import { ReviewRequestedEvent, type TypedEventTarget, type WeftReviewEventMap } from '@lostgradient/weft';
 *
 * declare const target: TypedEventTarget<WeftReviewEventMap>;
 *
 * target.addEventListener(ReviewRequestedEvent.type, (event) => {
 *   console.log(`Review ${event.reviewId} requested for workflow ${event.workflowId}`);
 *   console.log('Reviewers:', event.reviewers);
 * });
 * ```
 */
export class ReviewRequestedEvent extends Event {
  static readonly type = 'human-review:requested' as const;
  readonly workflowId: string;
  readonly reviewId: string;
  readonly reviewType: string;
  readonly reviewers: string[];

  constructor(workflowId: string, reviewId: string, reviewType: string, reviewers: string[]) {
    super(ReviewRequestedEvent.type);
    this.workflowId = workflowId;
    this.reviewId = reviewId;
    this.reviewType = reviewType;
    this.reviewers = reviewers;
  }
}

/**
 * Fired by {@link ReviewCoordinator} when a reviewer submits a decision.
 * Carries the `reviewId`, `decision` string, `reviewer` identifier, and the
 * time elapsed since the review was created. Use this to close tickets, record
 * audit logs, or trigger downstream workflow steps.
 *
 * @example Record review decisions in an audit log
 * ```ts
 * import { ReviewCompletedEvent, type TypedEventTarget, type WeftReviewEventMap } from '@lostgradient/weft';
 *
 * declare const target: TypedEventTarget<WeftReviewEventMap>;
 *
 * target.addEventListener(ReviewCompletedEvent.type, (event) => {
 *   console.log(`Review ${event.reviewId}: '${event.decision}' by ${event.reviewer} in ${event.duration}ms`);
 * });
 * ```
 */
export class ReviewCompletedEvent extends Event {
  static readonly type = 'human-review:completed' as const;
  readonly workflowId: string;
  readonly reviewId: string;
  readonly decision: string;
  readonly reviewer: string;
  readonly duration: number;

  constructor(
    workflowId: string,
    reviewId: string,
    decision: string,
    reviewer: string,
    duration: number,
  ) {
    super(ReviewCompletedEvent.type);
    this.workflowId = workflowId;
    this.reviewId = reviewId;
    this.decision = decision;
    this.reviewer = reviewer;
    this.duration = duration;
  }
}

/**
 * Record mapping each review-related event name to its typed Event subclass.
 * Use as the type parameter for `TypedEventTarget` to get type-safe listeners
 * on engine-level review events.
 *
 * @example
 * ```ts
 * import type { TypedEventTarget, WeftReviewEventMap } from '@lostgradient/weft';
 *
 * declare const target: TypedEventTarget<WeftReviewEventMap>;
 * target.addEventListener('human-review:requested', (event) => {
 *   console.log(event.reviewId, event.reviewers);
 * });
 * ```
 */
export type WeftReviewEventMap = {
  'human-review:requested': ReviewRequestedEvent;
  'human-review:completed': ReviewCompletedEvent;
};
