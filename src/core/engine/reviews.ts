import type { BatchOperation } from '../../storage/interface.ts';
import { KEYS, encodeStorageKeyComponent } from '../../storage/interface.ts';
import { ReviewCompletedEvent, ReviewRequestedEvent } from '../review/events.ts';
import {
  ReviewTimeoutError,
  type HumanReviewOptions,
  type HumanReviewResult,
  type ReviewOptions,
  type ReviewRequest,
} from '../review/index.ts';
import type {
  OperationOutcome,
  PendingReviewEntry,
  ReviewListEntry,
  ReviewListFilter,
  SubmitReviewOptions,
} from '../types.ts';
import { stageAtomicWorkflowCommitSideEffects } from './checkpoint-side-effects.ts';
import {
  deleteCompletedReviewsForWorkflow,
  listCompletedReviewsFromStorage,
  matchesReviewListFilter,
  persistCompletedReviewRecord,
} from './completed-review-storage.ts';
import type { EngineInternals } from './internals.ts';
import { parseStoredReviewRequest, toPendingReviewEntry } from './review-list-entries.ts';
import { trackWaiterKey, untrackWaiterKey } from './signals.ts';

type ReviewOperationOutcome = { ok: true; value: HumanReviewResult } | { ok: false; error: Error };

export type SubmitReviewCallbacks = {
  dispatchEvent: (event: Event) => boolean;
};

export type ReviewOperationCallbacks = {
  dispatchEvent: (event: Event) => boolean;
  failWorkflow: (workflowId: string, error: Error) => Promise<void>;
  feedOperationResult: (workflowId: string, result: OperationOutcome) => void;
  ensureTerminalCleanupTracked: (workflowId: string) => Promise<void>;
};

type StoredReviewLookup = {
  reviewKey: string;
  reviewData: ReviewRequest | null;
  workflowId: string;
};

function reviewScanPrefix(filter: ReviewListFilter): string {
  if (filter.workflowId === undefined) {
    return 'review:';
  }

  return `review:${encodeStorageKeyComponent(filter.workflowId)}:`;
}

async function listPendingReviews(
  internals: EngineInternals,
  filter: ReviewListFilter,
): Promise<PendingReviewEntry[]> {
  const reviews: PendingReviewEntry[] = [];

  for await (const [, value] of internals.storage.scan(reviewScanPrefix(filter))) {
    const review = parseStoredReviewRequest(value);
    if (review !== null && matchesReviewListFilter(review, filter)) {
      reviews.push(toPendingReviewEntry(review));
    }
  }

  return reviews;
}

async function dispatchCompletedReview(
  internals: EngineInternals,
  reviewKey: string,
  reviewData: ReviewRequest,
  decisionResult: HumanReviewResult,
  dispatchEvent: (event: Event) => boolean,
): Promise<void> {
  await persistCompletedReviewRecord(internals, reviewKey, reviewData, decisionResult);
  dispatchEvent(
    new ReviewCompletedEvent(
      reviewData.workflowId,
      reviewData.reviewId,
      decisionResult.decision,
      decisionResult.reviewer,
      decisionResult.timestamp - reviewData.createdAt,
    ),
  );
}

/** List pending reviews by default, or completed reviews when explicitly requested. */
export async function listReviews(
  internals: EngineInternals,
  filter: ReviewListFilter = {},
): Promise<ReviewListEntry[]> {
  if (filter.status === 'completed') {
    return listCompletedReviewsFromStorage(internals.storage, filter);
  }

  return listPendingReviews(internals, filter);
}

/** Retrieve a specific review by workflowId and reviewId. */
export async function getReview(
  internals: EngineInternals,
  workflowId: string,
  reviewId: string,
): Promise<ReviewRequest | null> {
  return internals.reviewCoordinator.getReview(workflowId, reviewId);
}

async function findReviewByScan(
  internals: EngineInternals,
  reviewId: string,
): Promise<StoredReviewLookup | null> {
  for await (const [reviewKey, value] of internals.storage.scan('review:')) {
    const reviewData = parseStoredReviewRequest(value);
    if (reviewData !== null && reviewData.reviewId === reviewId) {
      return {
        reviewKey,
        reviewData,
        workflowId: reviewData.workflowId,
      };
    }
  }

  return null;
}

async function findStoredReview(
  internals: EngineInternals,
  reviewId: string,
  workflowId: string | undefined,
): Promise<StoredReviewLookup | null> {
  if (workflowId !== undefined) {
    const reviewKey = KEYS.review(workflowId, reviewId);
    const existing = await internals.storage.get(reviewKey);
    return existing === null
      ? null
      : { reviewKey, reviewData: parseStoredReviewRequest(existing), workflowId };
  }

  return findReviewByScan(internals, reviewId);
}

function createHumanReviewResult(
  reviewId: string,
  options: SubmitReviewOptions,
  timestamp: number,
): HumanReviewResult {
  const { decision, reviewer, feedback, sectionDecisions } = options;
  const decisionResult: HumanReviewResult = {
    reviewId,
    decision,
    reviewer,
    timestamp,
  };

  if (feedback !== undefined) {
    decisionResult.feedback = feedback;
  }

  if (sectionDecisions !== undefined) {
    decisionResult.sectionDecisions = sectionDecisions;
  }

  return decisionResult;
}

function resolveWaitingReview(
  internals: EngineInternals,
  workflowId: string,
  reviewId: string,
  decisionResult: HumanReviewResult,
): void {
  const waiterKey = `${workflowId}:${reviewId}`;
  const waiter = internals.reviewWaiters.get(waiterKey);

  if (!waiter) {
    return;
  }

  internals.reviewWaiters.delete(waiterKey);
  untrackWaiterKey(internals.reviewWaitersByWorkflow, workflowId, waiterKey);
  waiter(decisionResult);
}

export async function submitReview(
  internals: EngineInternals,
  reviewId: string,
  options: SubmitReviewOptions,
  callbacks: SubmitReviewCallbacks,
): Promise<void> {
  const storedReview = await findStoredReview(internals, reviewId, options.workflowId);

  if (storedReview === null) {
    throw new Error(`Review "${reviewId}" not found`);
  }

  if (storedReview.reviewData === null) {
    throw new Error(`Review "${reviewId}" could not be loaded`);
  }

  const decisionResult = createHumanReviewResult(reviewId, options, internals.options.getNow());

  await dispatchCompletedReview(
    internals,
    storedReview.reviewKey,
    storedReview.reviewData,
    decisionResult,
    callbacks.dispatchEvent,
  );

  resolveWaitingReview(internals, storedReview.workflowId, reviewId, decisionResult);
}

export function resolveReviewDecision(
  resolve: (result: ReviewOperationOutcome) => void,
  decision: HumanReviewResult,
): void {
  resolve({ ok: true, value: decision });
}

export async function handleReviewEscalationTimer(
  internals: EngineInternals,
  workflowId: string,
  reviewId: string,
  waiterKey: string,
  reviewRequest: ReviewRequest,
  options: HumanReviewOptions,
  resolve: (result: ReviewOperationOutcome) => void,
  entry: { id: string; workflowId: string },
  callbacks: Pick<ReviewOperationCallbacks, 'dispatchEvent' | 'failWorkflow'>,
): Promise<boolean> {
  if (
    !entry.id.startsWith(`review-escalation:${reviewId}:`) &&
    entry.id !== `review-timeout:${reviewId}`
  ) {
    return false;
  }

  if (entry.id === `review-timeout:${reviewId}`) {
    internals.reviewWaiters.delete(waiterKey);
    untrackWaiterKey(internals.reviewWaitersByWorkflow, workflowId, waiterKey);
    const elapsed = internals.options.getNow() - reviewRequest.createdAt;
    const timeoutError = new ReviewTimeoutError(reviewId, elapsed);
    stageAtomicWorkflowCommitSideEffects(internals, workflowId, {
      operations: [{ type: 'delete', key: KEYS.review(workflowId, reviewId) }],
      conditions: [],
    });
    await callbacks.failWorkflow(workflowId, timeoutError);
    resolve({ ok: false, error: timeoutError });
    return true;
  }

  if (!options.escalation) {
    return false;
  }

  const action = internals.reviewCoordinator.checkEscalations(
    reviewRequest,
    options.escalation,
    internals.options.getNow(),
  );

  if (!action) {
    return false;
  }

  if (action.type === 'escalate') {
    options.onEscalation?.(action);
    return false;
  }

  internals.reviewWaiters.delete(waiterKey);
  untrackWaiterKey(internals.reviewWaitersByWorkflow, workflowId, waiterKey);
  const autoResult: HumanReviewResult = {
    reviewId,
    decision: action.decision,
    reviewer: 'system',
    feedback: action.auditReason,
    timestamp: internals.options.getNow(),
  };

  await dispatchCompletedReview(
    internals,
    KEYS.review(workflowId, reviewId),
    reviewRequest,
    autoResult,
    callbacks.dispatchEvent,
  );
  resolve({ ok: true, value: autoResult });
  return true;
}

export async function sendReviewWebhook(
  internals: EngineInternals,
  workflowId: string,
  reviewRequest: ReviewRequest,
  webhookUrl: string,
  webhookAbort: AbortController,
): Promise<void> {
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workflowId,
        reviewId: reviewRequest.reviewId,
        reviewType: reviewRequest.reviewType,
        reviewers: reviewRequest.reviewers,
        artifact: reviewRequest.artifact,
      }),
      signal: webhookAbort.signal,
    });
  } catch (error: unknown) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      console.warn(`[weft] Failed to send review webhook for ${reviewRequest.reviewId}`, error);
    }
  } finally {
    internals.pendingWebhooks.delete(webhookAbort);
  }
}

/** Remove all pending review entries from storage for a given workflow. */
export async function cleanupReviews(
  internals: EngineInternals,
  workflowId: string,
): Promise<void> {
  const pendingPrefix = `review:${encodeStorageKeyComponent(workflowId)}:`;
  const deleteOperations: BatchOperation[] = [];

  if (internals.storage.deletePrefix) {
    await internals.storage.deletePrefix(pendingPrefix);
  } else {
    for await (const [key] of internals.storage.scan(pendingPrefix)) {
      deleteOperations.push({ type: 'delete', key });
    }
  }

  if (deleteOperations.length > 0) {
    await internals.storage.batch(deleteOperations);
  }

  await deleteCompletedReviewsForWorkflow(internals.storage, workflowId);
}

function setReviewOption<K extends keyof ReviewOptions>(
  reviewOptions: ReviewOptions,
  key: K,
  value: ReviewOptions[K] | undefined,
): void {
  if (value !== undefined) reviewOptions[key] = value;
}

function createReviewOptions(options: HumanReviewOptions): ReviewOptions {
  const reviewOptions: ReviewOptions = { artifact: options.artifact };
  setReviewOption(reviewOptions, 'reviewType', options.reviewType);
  setReviewOption(reviewOptions, 'reviewers', options.reviewers);
  setReviewOption(reviewOptions, 'allowPartial', options.allowPartial);
  setReviewOption(reviewOptions, 'timeout', options.timeout);
  setReviewOption(reviewOptions, 'escalation', options.escalation);
  setReviewOption(reviewOptions, 'webhookUrl', options.webhookUrl);
  return reviewOptions;
}

async function scheduleReviewTimers(
  internals: EngineInternals,
  workflowId: string,
  reviewId: string,
  options: HumanReviewOptions,
  now: number,
): Promise<string[]> {
  const timerIds: string[] = [];
  for (const step of options.escalation ?? []) {
    const timerId = `review-escalation:${reviewId}:${step.after}`;
    timerIds.push(timerId);
    await internals.scheduler.schedule({
      id: timerId,
      workflowId,
      fireAt: now + step.after,
      kind: 'sleep',
    });
  }
  if (options.timeout !== undefined) {
    const timerId = `review-timeout:${reviewId}`;
    timerIds.push(timerId);
    await internals.scheduler.schedule({
      id: timerId,
      workflowId,
      fireAt: now + options.timeout,
      kind: 'sleep',
    });
  }
  return timerIds;
}

function createReviewWaiter(
  internals: EngineInternals,
  workflowId: string,
  reviewId: string,
): {
  promise: Promise<ReviewOperationOutcome>;
  resolve: (result: ReviewOperationOutcome) => void;
  waiterKey: string;
} {
  const { promise, resolve } = Promise.withResolvers<ReviewOperationOutcome>();
  const waiterKey = `${workflowId}:${reviewId}`;
  internals.reviewWaiters.set(waiterKey, (decision) => resolveReviewDecision(resolve, decision));
  trackWaiterKey(internals.reviewWaitersByWorkflow, workflowId, waiterKey);
  return { promise, resolve, waiterKey };
}

function registerReviewLifecycleTracking(
  internals: EngineInternals,
  workflowId: string,
  reviewId: string,
  timerIds: string[],
  handler: (entry: { id: string; workflowId: string }) => Promise<boolean>,
): void {
  let reviewIdSet = internals.workflowReviewIds.get(workflowId);
  internals.reviewEscalationHandlers.set(reviewId, handler);
  if (timerIds.length > 0) internals.reviewTimerIds.set(reviewId, timerIds);
  if (!reviewIdSet) {
    reviewIdSet = new Set();
    internals.workflowReviewIds.set(workflowId, reviewIdSet);
  }
  reviewIdSet.add(reviewId);
}

function cleanupReviewLifecycleTracking(
  internals: EngineInternals,
  workflowId: string,
  reviewId: string,
): void {
  const trackedIds = internals.workflowReviewIds.get(workflowId);
  internals.reviewEscalationHandlers.delete(reviewId);
  internals.reviewTimerIds.delete(reviewId);
  trackedIds?.delete(reviewId);
  if (trackedIds?.size === 0) internals.workflowReviewIds.delete(workflowId);
}

export async function processReviewOperation(
  internals: EngineInternals,
  workflowId: string,
  options: HumanReviewOptions,
  callbacks: ReviewOperationCallbacks,
): Promise<void> {
  const now = internals.options.getNow();
  await callbacks.ensureTerminalCleanupTracked(workflowId);

  const reviewRequest = await internals.reviewCoordinator.createReview(
    workflowId,
    createReviewOptions(options),
  );
  const reviewId = reviewRequest.reviewId;

  callbacks.dispatchEvent(
    new ReviewRequestedEvent(
      workflowId,
      reviewId,
      reviewRequest.reviewType,
      reviewRequest.reviewers,
    ),
  );

  if (options.webhookUrl !== undefined) {
    const webhookAbort = new AbortController();
    internals.pendingWebhooks.add(webhookAbort);
    void sendReviewWebhook(internals, workflowId, reviewRequest, options.webhookUrl, webhookAbort);
  }

  const timerIds = await scheduleReviewTimers(internals, workflowId, reviewId, options, now);
  const { promise, resolve, waiterKey } = createReviewWaiter(internals, workflowId, reviewId);
  registerReviewLifecycleTracking(internals, workflowId, reviewId, timerIds, (entry) =>
    handleReviewEscalationTimer(
      internals,
      workflowId,
      reviewId,
      waiterKey,
      reviewRequest,
      options,
      resolve,
      entry,
      callbacks,
    ),
  );

  const outcome = await promise;

  cleanupReviewLifecycleTracking(internals, workflowId, reviewId);
  for (const timerId of timerIds) {
    await internals.scheduler.cancel(timerId, workflowId);
  }

  if (!outcome.ok) {
    // The workflow was already failed directly (e.g., by the timeout handler).
    // Just return without feeding a result.
    return;
  }

  callbacks.feedOperationResult(workflowId, { status: 'completed', value: outcome.value });
}
