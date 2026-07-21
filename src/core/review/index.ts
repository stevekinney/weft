/**
 * Human-in-the-loop review protocol.
 *
 * Coordinates review requests, decisions, escalation chains,
 * and partial approval workflows for durable human oversight.
 *
 * @module human-review
 */

import type { BatchOperation, Storage } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { decode, encode } from '../codec.ts';
import { WeftError } from '../weft-error.ts';
import { ReviewRequestedEvent } from './events.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A persisted human review request. Created by {@link ReviewCoordinator.createReview}
 * and returned to the workflow once a reviewer submits a decision.
 *
 * @example
 * ```ts
 * import type { ReviewRequest } from '@lostgradient/weft';
 *
 * const request: ReviewRequest = {
 *   reviewId: 'r-1',
 *   workflowId: 'wf-1',
 *   artifact: { text: 'draft' },
 *   reviewType: 'content',
 *   reviewers: ['alice@example.com'],
 *   allowPartial: false,
 *   createdAt: Date.now(),
 * };
 * ```
 */
export interface ReviewRequest {
  reviewId: string;
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
 * A reviewer's decision payload returned to the workflow from `ctx.review()`.
 * The `decision` field is the binary outcome; `sectionDecisions` carries
 * per-section verdicts when `allowPartial` is enabled on the request.
 */
export interface ReviewDecisionRecord {
  reviewId: string;
  decision: 'approved' | 'rejected' | 'needs-changes';
  reviewer: string;
  feedback?: string;
  sectionDecisions?: Record<string, 'approved' | 'rejected'>;
  timestamp: number;
}

/**
 * One step in a {@link ReviewOptions.escalation} chain. Either reassigns the
 * pending review to a new owner (`to`) or auto-decides it (`action`) after
 * `after` milliseconds have elapsed.
 *
 * @example
 * ```ts
 * import type { EscalationStep } from '@lostgradient/weft';
 *
 * const step: EscalationStep = { after: 60_000, to: 'manager@example.com' };
 * void step;
 * ```
 */
export interface EscalationStep {
  after: number;
  to?: string;
  action?: 'auto-approve' | 'auto-reject';
  auditReason?: string;
}

/**
 * Base options for creating a review via {@link ReviewCoordinator.createReview}.
 * The `artifact` carries the payload the reviewer evaluates; the other fields
 * configure routing, partial approval, escalation chains, and webhook delivery.
 *
 * @example
 * ```ts
 * import type { ReviewOptions } from '@lostgradient/weft';
 *
 * const options: ReviewOptions = {
 *   artifact: { summary: 'release plan' },
 *   reviewers: ['alice@example.com'],
 *   timeout: 60_000,
 * };
 * void options;
 * ```
 */
export interface ReviewOptions {
  artifact: unknown;
  reviewType?: string;
  reviewers?: string[];
  allowPartial?: boolean;
  timeout?: number;
  escalation?: EscalationStep[];
  webhookUrl?: string;
}

/**
 * Options passed to `ctx.review()` inside a workflow generator. Extends
 * {@link ReviewOptions} with the context-level callback the runtime invokes
 * when an escalation step fires.
 *
 * @example
 * ```ts
 * import type { HumanReviewOptions } from '@lostgradient/weft';
 *
 * const options: HumanReviewOptions = {
 *   artifact: 'release plan',
 *   reviewers: ['alice@example.com'],
 *   onEscalation: (action) => console.log('escalation:', action),
 * };
 * void options;
 * ```
 */
export interface HumanReviewOptions extends ReviewOptions {
  /** Handler called when an escalation step fires. */
  onEscalation?: (action: EscalationAction) => void;
}

/**
 * The decision payload returned to the workflow from `ctx.review()`.
 * Alias for {@link ReviewDecisionRecord}.
 *
 * @example
 * ```ts
 * import type { HumanReviewResult } from '@lostgradient/weft';
 *
 * const result: HumanReviewResult = {
 *   reviewId: 'r-1',
 *   decision: 'approved',
 *   reviewer: 'alice@example.com',
 *   timestamp: Date.now(),
 * };
 * void result;
 * ```
 */
export type HumanReviewResult = ReviewDecisionRecord;

/**
 * The action returned by {@link ReviewCoordinator.checkEscalations} when an
 * escalation step has fired. Either reassigns the review to a new owner or
 * auto-decides it with an audit reason.
 *
 * @example
 * ```ts
 * import type { EscalationAction } from '@lostgradient/weft';
 *
 * const action: EscalationAction = { type: 'escalate', to: 'manager@example.com' };
 * void action;
 * ```
 */
export type EscalationAction =
  | { type: 'escalate'; to: string }
  | { type: 'auto-decide'; decision: 'approved' | 'rejected'; auditReason: string };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a human review request exceeds its configured `timeout`
 * milliseconds without receiving a decision. Carries the `reviewId` and the
 * elapsed time so callers can decide whether to escalate or auto-approve.
 *
 * @example Catch a review timeout and escalate
 * ```ts
 * import { workflow, ReviewTimeoutError } from '@lostgradient/weft';
 * import type { Context, WorkflowContext } from '@lostgradient/weft';
 * import { TestEngine } from '@lostgradient/weft/testing';
 *
 * const engine = new TestEngine({ startTime: 0 });
 * engine.register(
 *   workflow({ name: 'needs-review' }).execute(async function* (ctx: WorkflowContext) {
 *     return yield* ctx.review({
 *       artifact: 'release plan',
 *       reviewers: ['alice@example.com'],
 *       timeout: 5_000,
 *     });
 *   }),
 * );
 * const handle = await engine.start('needs-review', null);
 * const result = handle.result();
 * await engine.advanceTime(6_000);
 *
 * try {
 *   await result;
 * } catch (error) {
 *   if (error instanceof ReviewTimeoutError) {
 *     console.warn(`Review ${error.reviewId} timed out after ${error.elapsed}ms`);
 *   }
 * }
 * ```
 */
export class ReviewTimeoutError extends WeftError<'ReviewTimeoutError'> {
  readonly reviewId: string;
  readonly elapsed: number;

  constructor(reviewId: string, elapsed: number) {
    super('ReviewTimeoutError', `Review ${reviewId} timed out after ${elapsed}ms`);
    this.reviewId = reviewId;
    this.elapsed = elapsed;
  }
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

/**
 * Options for constructing a {@link ReviewCoordinator}. Accepts an optional
 * `EventTarget` to dispatch {@link ReviewRequestedEvent} on review
 * creation, and a custom `getNow` clock function for deterministic testing.
 *
 * @example Attach an event target and a fixed clock for tests
 * ```ts
 * import { ReviewCoordinator, type ReviewCoordinatorOptions } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/weft/storage/memory';
 *
 * const storage = new MemoryStorage();
 * const options: ReviewCoordinatorOptions = {
 *   eventTarget: new EventTarget(),
 *   getNow: () => 1_700_000_000_000,
 * };
 *
 * const coordinator = new ReviewCoordinator(storage, options);
 * ```
 */
export interface ReviewCoordinatorOptions {
  /** When provided, the coordinator dispatches human review events. */
  eventTarget?: EventTarget;
  /** Custom time source for testing. Defaults to `Date.now`. */
  getNow?: () => number;
}

/**
 * Persists human review requests to storage, dispatches
 * {@link ReviewRequestedEvent} on creation, accepts reviewer decisions,
 * and checks escalation timeouts. Used by `ctx.review()` inside workflow
 * generators to pause execution pending a human decision.
 *
 * @example Create a review and later submit a decision
 * ```ts
 * import { ReviewCoordinator } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/weft/storage/memory';
 *
 * const storage = new MemoryStorage();
 * const coordinator = new ReviewCoordinator(storage);
 *
 * const review = await coordinator.createReview('wf-123', {
 *   artifact: { text: 'Draft email body…' },
 *   reviewType: 'content',
 *   reviewers: ['alice@example.com'],
 * });
 *
 * const decision = await coordinator.submitDecision(review.reviewId, {
 *   decision: 'approved',
 *   reviewer: 'alice@example.com',
 * });
 * console.log(decision.decision); // 'approved'
 * ```
 */
export class ReviewCoordinator {
  #storage: Storage;
  #getNow: () => number;
  #eventTarget: EventTarget | undefined;

  constructor(storage: Storage, optionsOrGetNow?: ReviewCoordinatorOptions | (() => number)) {
    this.#storage = storage;
    if (typeof optionsOrGetNow === 'function') {
      this.#getNow = optionsOrGetNow;
    } else {
      this.#getNow = optionsOrGetNow?.getNow ?? Date.now;
      this.#eventTarget = optionsOrGetNow?.eventTarget;
    }
  }

  /** Create a review request and persist it. */
  async createReview(workflowId: string, options: ReviewOptions): Promise<ReviewRequest> {
    const reviewId = crypto.randomUUID();

    const request: ReviewRequest = {
      reviewId,
      workflowId,
      artifact: options.artifact,
      reviewType: options.reviewType ?? 'general',
      reviewers: options.reviewers ?? [],
      allowPartial: options.allowPartial ?? false,
      createdAt: this.#getNow(),
    };

    if (options.timeout !== undefined) {
      request.timeout = options.timeout;
    }

    if (options.webhookUrl !== undefined) {
      request.webhookUrl = options.webhookUrl;
    }

    const key = KEYS.review(workflowId, reviewId);
    await this.#storage.put(key, encode(request));

    if (this.#eventTarget) {
      this.#eventTarget.dispatchEvent(
        new ReviewRequestedEvent(workflowId, reviewId, request.reviewType, request.reviewers),
      );
    }

    return request;
  }

  /** Submit a review decision. */
  async submitDecision(
    reviewId: string,
    decision: Omit<ReviewDecisionRecord, 'reviewId' | 'timestamp'>,
  ): Promise<ReviewDecisionRecord> {
    const full: ReviewDecisionRecord = {
      reviewId,
      decision: decision.decision,
      reviewer: decision.reviewer,
      timestamp: this.#getNow(),
    };

    if (decision.feedback !== undefined) {
      full.feedback = decision.feedback;
    }

    if (decision.sectionDecisions !== undefined) {
      full.sectionDecisions = decision.sectionDecisions;
    }

    return full;
  }

  /** Get a pending review. */
  async getReview(workflowId: string, reviewId: string): Promise<ReviewRequest | null> {
    const key = KEYS.review(workflowId, reviewId);
    const raw = await this.#storage.get(key);
    if (!raw) return null;

    return decode(raw) as ReviewRequest;
  }

  /** List pending reviews. */
  async listPendingReviews(): Promise<ReviewRequest[]> {
    const prefix = 'review:';
    const results: ReviewRequest[] = [];

    for await (const [, value] of this.#storage.scan(prefix)) {
      results.push(decode(value) as ReviewRequest);
    }

    return results;
  }

  /** Build cleanup operations for completed workflow. */
  cleanupOperations(workflowId: string, reviewId: string): BatchOperation[] {
    return [{ type: 'delete', key: KEYS.review(workflowId, reviewId) }];
  }

  /** Check for escalation timeouts. Returns actions to take. */
  checkEscalations(
    review: ReviewRequest,
    escalation: EscalationStep[],
    now: number,
  ): EscalationAction | null {
    const elapsed = now - review.createdAt;

    // Walk steps in reverse order so the most advanced triggered step wins.
    for (let i = escalation.length - 1; i >= 0; i--) {
      const step = escalation[i]!;

      if (elapsed < step.after) continue;

      if (step.action !== undefined) {
        const decision = step.action === 'auto-approve' ? 'approved' : 'rejected';
        return {
          type: 'auto-decide',
          decision,
          auditReason: step.auditReason ?? `Auto-${decision} after ${step.after}ms`,
        };
      }

      if (step.to !== undefined) {
        return { type: 'escalate', to: step.to };
      }
    }

    return null;
  }
}
