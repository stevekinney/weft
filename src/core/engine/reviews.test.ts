import { describe, expect, it, mock, spyOn } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import { ReviewTimeoutError, type HumanReviewResult, type ReviewRequest } from '../review/index.ts';
import { handleReviewEscalationTimer, sendReviewWebhook, submitReview } from './reviews.ts';

function createReviewRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    reviewId: 'review-1',
    workflowId: 'workflow-1',
    artifact: { ok: true },
    reviewType: 'content',
    reviewers: ['alex'],
    allowPartial: false,
    createdAt: 1_000,
    ...overrides,
  };
}

describe('review helpers', () => {
  it('rejects malformed stored reviews during submitReview', async () => {
    const storage = new MemoryStorage();
    const review = createReviewRequest();
    await storage.put(KEYS.review(review.workflowId, review.reviewId), encode('malformed'));

    await expect(
      submitReview(
        {
          options: { getNow: () => 2_000 },
          reviewWaiters: new Map(),
          reviewWaitersByWorkflow: new Map(),
          storage,
        } as never,
        review.reviewId,
        { decision: 'approved', reviewer: 'alex', workflowId: review.workflowId },
        { dispatchEvent: () => true },
      ),
    ).rejects.toThrow(`Review "${review.reviewId}" could not be loaded`);
  });

  it('ignores unrelated escalation timers and escalation ticks without actions', async () => {
    const storage = new MemoryStorage();
    const review = createReviewRequest();
    const resolve = mock(() => {});
    const reviewOptions = { artifact: review.artifact };

    const unrelated = await handleReviewEscalationTimer(
      {
        options: { getNow: () => 2_000 },
        reviewCoordinator: { checkEscalations: mock(() => null) },
        reviewWaiters: new Map(),
        reviewWaitersByWorkflow: new Map(),
        storage,
      } as never,
      review.workflowId,
      review.reviewId,
      `${review.workflowId}:${review.reviewId}`,
      review,
      reviewOptions,
      resolve,
      { id: 'other-timer', workflowId: review.workflowId },
      { dispatchEvent: () => true, failWorkflow: async () => {} },
    );

    const noAction = await handleReviewEscalationTimer(
      {
        options: { getNow: () => 2_000 },
        reviewCoordinator: { checkEscalations: mock(() => null) },
        reviewWaiters: new Map(),
        reviewWaitersByWorkflow: new Map(),
        storage,
      } as never,
      review.workflowId,
      review.reviewId,
      `${review.workflowId}:${review.reviewId}`,
      review,
      { artifact: review.artifact, escalation: [{ after: 100, to: 'manager' }] },
      resolve,
      { id: `review-escalation:${review.reviewId}:0`, workflowId: review.workflowId },
      { dispatchEvent: () => true, failWorkflow: async () => {} },
    );

    expect(unrelated).toBe(false);
    expect(noAction).toBe(false);
  });

  it('ignores escalation timers when no escalation is configured and forwards escalate actions', async () => {
    const storage = new MemoryStorage();
    const review = createReviewRequest();
    const resolve = mock(() => {});
    const onEscalation = mock(() => {});
    const reviewOptions = { artifact: review.artifact };

    const noEscalation = await handleReviewEscalationTimer(
      {
        options: { getNow: () => 2_000 },
        reviewCoordinator: { checkEscalations: mock(() => ({ type: 'escalate', to: 'manager' })) },
        reviewWaiters: new Map(),
        reviewWaitersByWorkflow: new Map(),
        storage,
      } as never,
      review.workflowId,
      review.reviewId,
      `${review.workflowId}:${review.reviewId}`,
      review,
      reviewOptions,
      resolve,
      { id: `review-escalation:${review.reviewId}:0`, workflowId: review.workflowId },
      { dispatchEvent: () => true, failWorkflow: async () => {} },
    );

    const escalated = await handleReviewEscalationTimer(
      {
        options: { getNow: () => 2_000 },
        reviewCoordinator: { checkEscalations: mock(() => ({ type: 'escalate', to: 'manager' })) },
        reviewWaiters: new Map(),
        reviewWaitersByWorkflow: new Map(),
        storage,
      } as never,
      review.workflowId,
      review.reviewId,
      `${review.workflowId}:${review.reviewId}`,
      review,
      { artifact: review.artifact, escalation: [{ after: 100, to: 'manager' }], onEscalation },
      resolve,
      { id: `review-escalation:${review.reviewId}:0`, workflowId: review.workflowId },
      { dispatchEvent: () => true, failWorkflow: async () => {} },
    );

    expect(noEscalation).toBe(false);
    expect(escalated).toBe(false);
    expect(onEscalation).toHaveBeenCalledWith({ type: 'escalate', to: 'manager' });
  });

  it('times out waiting reviews and reports webhook failures that are not aborts', async () => {
    const storage = new MemoryStorage();
    const review = createReviewRequest();
    const waiterKey = `${review.workflowId}:${review.reviewId}`;
    let timeoutResult:
      | { ok: false; error: Error }
      | { ok: true; value: HumanReviewResult }
      | undefined;
    const resolve = (
      result: { ok: false; error: Error } | { ok: true; value: HumanReviewResult },
    ) => {
      timeoutResult = result;
    };
    const failWorkflow = mock(async () => {});

    const timedOut = await handleReviewEscalationTimer(
      {
        options: { getNow: () => 2_500 },
        pendingWebhooks: new Set(),
        pendingAtomicWorkflowCommitSideEffects: new Map(),
        reviewCoordinator: { checkEscalations: mock(() => null) },
        reviewWaiters: new Map([[waiterKey, () => {}]]),
        reviewWaitersByWorkflow: new Map([[review.workflowId, new Set([waiterKey])]]),
        storage,
      } as never,
      review.workflowId,
      review.reviewId,
      waiterKey,
      review,
      { artifact: review.artifact },
      resolve,
      { id: `review-timeout:${review.reviewId}`, workflowId: review.workflowId },
      { dispatchEvent: () => true, failWorkflow },
    );

    expect(timedOut).toBe(true);
    expect(failWorkflow).toHaveBeenCalled();
    expect(timeoutResult?.ok).toBe(false);
    if (timeoutResult?.ok === false) {
      expect(timeoutResult.error).toBeInstanceOf(ReviewTimeoutError);
    }

    const pendingWebhooks = new Set<AbortController>();
    const abortController = new AbortController();
    pendingWebhooks.add(abortController);
    const originalFetch = globalThis.fetch;
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = Object.assign(
      async (..._args: Parameters<typeof fetch>): ReturnType<typeof fetch> => {
        throw new Error('network failed');
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;

    try {
      await sendReviewWebhook(
        {
          pendingWebhooks,
        } as never,
        review.workflowId,
        review,
        'https://example.com/review',
        abortController,
      );
      expect(warn).toHaveBeenCalled();
      expect(pendingWebhooks.has(abortController)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      warn.mockRestore();
    }
  });
});
