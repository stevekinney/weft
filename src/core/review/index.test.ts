import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { sleepForTesting } from '../../testing/fake-timers.test-support.ts';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { TestEngine } from '../../testing/test-engine.ts';
import { decode, encode } from '../codec.ts';
import { Engine } from '../engine.ts';
import type { WorkflowContext } from '../types.ts';
import { workflow } from '../types.ts';
import { ReviewCompletedEvent, ReviewRequestedEvent } from './events.ts';
import {
  ReviewCoordinator,
  ReviewTimeoutError,
  type EscalationAction,
  type EscalationStep,
  type ReviewRequest,
} from './index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function flush(): Promise<void> {
  await sleepForTesting(10);
}

// ---------------------------------------------------------------------------
// Unit tests for ReviewCoordinator
// ---------------------------------------------------------------------------

describe('ReviewCoordinator', () => {
  let storage: MemoryStorage;
  let coordinator: ReviewCoordinator;

  beforeEach(() => {
    storage = new MemoryStorage();
    coordinator = new ReviewCoordinator(storage);
  });

  afterEach(() => {
    storage.clear();
  });

  describe('createReview', () => {
    it('stores request in storage', async () => {
      const request = await coordinator.createReview('wf-1', {
        artifact: { content: 'draft blog post' },
        reviewType: 'content-review',
        reviewers: ['alice', 'bob'],
      });

      const raw = await storage.get(KEYS.review('wf-1', request.reviewId));
      expect(raw).not.toBeNull();

      const stored = decode(raw!) as ReviewRequest;
      expect(stored.workflowId).toBe('wf-1');
      expect(stored.artifact).toEqual({ content: 'draft blog post' });
      expect(stored.reviewType).toBe('content-review');
      expect(stored.reviewers).toEqual(['alice', 'bob']);
    });

    it('returns request with UUID', async () => {
      const request = await coordinator.createReview('wf-1', {
        artifact: 'some artifact',
      });

      expect(request.reviewId).toMatch(
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i,
      );
      expect(request.workflowId).toBe('wf-1');
      expect(request.createdAt).toBeGreaterThan(0);
    });

    it('dispatches ReviewRequestedEvent when eventTarget is provided', async () => {
      const eventTarget = new EventTarget();
      const coordinatorWithEvents = new ReviewCoordinator(storage, { eventTarget });
      const receivedEvents: ReviewRequestedEvent[] = [];

      eventTarget.addEventListener(ReviewRequestedEvent.type, (event) => {
        receivedEvents.push(event as ReviewRequestedEvent);
      });

      const request = await coordinatorWithEvents.createReview('wf-event-1', {
        artifact: { content: 'review this' },
        reviewType: 'code-review',
        reviewers: ['alice', 'bob'],
      });

      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0]!.workflowId).toBe('wf-event-1');
      expect(receivedEvents[0]!.reviewId).toBe(request.reviewId);
      expect(receivedEvents[0]!.reviewType).toBe('code-review');
      expect(receivedEvents[0]!.reviewers).toEqual(['alice', 'bob']);
    });

    it('does not dispatch ReviewRequestedEvent when no eventTarget is provided', async () => {
      // This test verifies that the coordinator works fine without an eventTarget.
      // If it throws, the test will fail.
      const request = await coordinator.createReview('wf-no-events', {
        artifact: 'some artifact',
      });

      expect(request.workflowId).toBe('wf-no-events');
    });
  });

  describe('getReview', () => {
    it('returns stored request', async () => {
      const created = await coordinator.createReview('wf-1', {
        artifact: { title: 'PR #42' },
        reviewType: 'code-review',
        reviewers: ['charlie'],
      });

      const fetched = await coordinator.getReview('wf-1', created.reviewId);

      expect(fetched).not.toBeNull();
      expect(fetched!.reviewId).toBe(created.reviewId);
      expect(fetched!.artifact).toEqual({ title: 'PR #42' });
      expect(fetched!.reviewType).toBe('code-review');
    });

    it('returns null when not found', async () => {
      const result = await coordinator.getReview('wf-1', 'nonexistent-id');

      expect(result).toBeNull();
    });
  });

  describe('submitDecision', () => {
    it('returns full ReviewDecision', async () => {
      const request = await coordinator.createReview('wf-1', {
        artifact: 'document',
        reviewers: ['alice'],
      });

      const decision = await coordinator.submitDecision(request.reviewId, {
        decision: 'approved',
        reviewer: 'alice',
        feedback: 'Looks good to me!',
      });

      expect(decision.reviewId).toBe(request.reviewId);
      expect(decision.decision).toBe('approved');
      expect(decision.reviewer).toBe('alice');
      expect(decision.feedback).toBe('Looks good to me!');
      expect(decision.timestamp).toBeGreaterThan(0);
    });

    it('uses the injected clock for createdAt and decision timestamps', async () => {
      let now = 1_234;
      const coordinatorWithClock = new ReviewCoordinator(storage, {
        getNow: () => now,
      });

      const request = await coordinatorWithClock.createReview('wf-clock', {
        artifact: 'document',
      });

      now = 5_678;
      const decision = await coordinatorWithClock.submitDecision(request.reviewId, {
        decision: 'approved',
        reviewer: 'alice',
      });

      expect(request.createdAt).toBe(1_234);
      expect(decision.timestamp).toBe(5_678);
    });
  });

  describe('listPendingReviews', () => {
    it('returns all pending reviews', async () => {
      await coordinator.createReview('wf-1', {
        artifact: 'artifact-a',
        reviewers: ['alice'],
      });
      await coordinator.createReview('wf-2', {
        artifact: 'artifact-b',
        reviewers: ['bob'],
      });

      const pending = await coordinator.listPendingReviews();

      expect(pending).toHaveLength(2);
      const workflows = pending.map((review) => review.workflowId);
      expect(workflows).toContain('wf-1');
      expect(workflows).toContain('wf-2');
    });
  });

  describe('cleanupOperations', () => {
    it('produces DELETE batch operations', () => {
      const operations = coordinator.cleanupOperations('wf-1', 'review-123');

      expect(operations).toHaveLength(1);
      expect(operations[0]).toEqual({
        type: 'delete',
        key: KEYS.review('wf-1', 'review-123'),
      });
    });
  });

  describe('checkEscalations', () => {
    const baseReview: ReviewRequest = {
      reviewId: 'rev-1',
      workflowId: 'wf-1',
      artifact: 'some artifact',
      reviewType: 'content-review',
      reviewers: ['alice'],
      allowPartial: false,
      createdAt: 1000,
    };

    it('returns null when no escalation needed', () => {
      const escalation: EscalationStep[] = [{ after: 60_000, to: 'managers' }];

      // Only 30 seconds have passed, threshold is 60 seconds
      const result = coordinator.checkEscalations(baseReview, escalation, 31_000);

      expect(result).toBeNull();
    });

    it('returns escalate action when timeout passed', () => {
      const escalation: EscalationStep[] = [{ after: 60_000, to: 'managers' }];

      // 90 seconds have passed, threshold is 60 seconds
      const result = coordinator.checkEscalations(baseReview, escalation, 91_000);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('escalate');
      expect((result as Extract<EscalationAction, { type: 'escalate' }>).to).toBe('managers');
    });

    it('returns auto-decide for final step', () => {
      const escalation: EscalationStep[] = [
        { after: 60_000, to: 'managers' },
        { after: 120_000, action: 'auto-approve', auditReason: 'No response after escalation' },
      ];

      // 150 seconds have passed, both thresholds exceeded
      const result = coordinator.checkEscalations(baseReview, escalation, 151_000);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('auto-decide');
      const autoDecide = result as Extract<EscalationAction, { type: 'auto-decide' }>;
      expect(autoDecide.decision).toBe('approved');
      expect(autoDecide.auditReason).toBe('No response after escalation');
    });
  });

  describe('ReviewTimeoutError', () => {
    it('has correct properties', () => {
      const error = new ReviewTimeoutError('rev-42', 5000);

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(ReviewTimeoutError);
      expect(error.reviewId).toBe('rev-42');
      expect(error.elapsed).toBe(5000);
      expect(error.message).toContain('rev-42');
      expect(error.message).toContain('5000');
      expect(error.name).toBe('ReviewTimeoutError');
    });
  });

  describe('partial approval with section decisions', () => {
    it('records section-level decisions', async () => {
      const request = await coordinator.createReview('wf-1', {
        artifact: { sections: ['intro', 'body', 'conclusion'] },
        reviewers: ['alice'],
        allowPartial: true,
      });

      const decision = await coordinator.submitDecision(request.reviewId, {
        decision: 'needs-changes',
        reviewer: 'alice',
        feedback: 'Intro and conclusion are fine, body needs work',
        sectionDecisions: {
          intro: 'approved',
          body: 'rejected',
          conclusion: 'approved',
        },
      });

      expect(decision.decision).toBe('needs-changes');
      expect(decision.sectionDecisions).toEqual({
        intro: 'approved',
        body: 'rejected',
        conclusion: 'approved',
      });
    });
  });
});

// ---------------------------------------------------------------------------
// G1: ctx.review() pauses workflow with durable storage
// ---------------------------------------------------------------------------

describe('G1: ctx.review() pauses workflow with durable storage', () => {
  let engine: TestEngine;

  afterEach(() => {
    engine[Symbol.dispose]();
  });

  it('pauses the workflow when review is called', async () => {
    engine = new TestEngine();

    const reviewWorkflowWorkflow = workflow({ name: 'review-workflow' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      const decision = yield* c.review({
        artifact: 'draft report',
        reviewers: ['alice'],
      });
      return { decision };
    });
    engine.register(reviewWorkflowWorkflow);

    const handle = await engine.start('review-workflow', null);
    await flush();

    const state = await engine.get(handle.id);
    expect(state).not.toBeNull();
    expect(state!.status).toBe('running');
  });

  it('stores review request in storage with review:{wfId}:{reviewId} key', async () => {
    engine = new TestEngine();

    const reviewWorkflowWorkflow2 = workflow({ name: 'review-workflow' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      const decision = yield* c.review({
        artifact: 'draft report',
        reviewers: ['alice'],
      });
      return { decision };
    });
    engine.register(reviewWorkflowWorkflow2);

    const handle = await engine.start('review-workflow', null);
    await flush();

    // Scan for review keys
    const reviews: Array<{ key: string; value: ReviewRequest }> = [];
    for await (const [key, value] of engine.storage.scan('review:')) {
      reviews.push({ key, value: decode(value) as ReviewRequest });
    }

    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.key).toStartWith(`review:${handle.id}:`);
    expect(reviews[0]!.value.workflowId).toBe(handle.id);
    expect(reviews[0]!.value.artifact).toBe('draft report');
    expect(reviews[0]!.value.reviewers).toEqual(['alice']);
    expect(reviews[0]!.value.reviewType).toBe('general');
  });

  it('survives engine crash and recovery with review still pending', async () => {
    engine = new TestEngine();

    const reviewWorkflowWorkflow3 = workflow({ name: 'review-workflow' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      const decision = yield* c.review({
        artifact: 'draft report',
        reviewers: ['alice'],
      });
      return { decision };
    });
    engine.register(reviewWorkflowWorkflow3);

    const handle = await engine.start('review-workflow', null);
    await flush();

    // Crash and recover
    const recovered = engine.recover();
    const reviewWorkflowWorkflow4 = workflow({ name: 'review-workflow' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      const decision = yield* c.review({
        artifact: 'draft report',
        reviewers: ['alice'],
      });
      return { decision };
    });
    recovered.register(reviewWorkflowWorkflow4);

    // Verify review request still exists in storage after recovery
    const reviews: ReviewRequest[] = [];
    for await (const [, value] of recovered.storage.scan('review:')) {
      reviews.push(decode(value) as ReviewRequest);
    }

    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.workflowId).toBe(handle.id);
    expect(reviews[0]!.artifact).toBe('draft report');

    recovered[Symbol.dispose]();
  });
});

// ---------------------------------------------------------------------------
// G2: Review submission resumes workflow
// ---------------------------------------------------------------------------

describe('G2: Review submission resumes workflow', () => {
  let engine: TestEngine;

  afterEach(() => {
    engine[Symbol.dispose]();
  });

  it('resumes workflow when review decision is submitted', async () => {
    engine = new TestEngine();

    const reviewWorkflowWorkflow5 = workflow({ name: 'review-workflow' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      const decision = yield* c.review({
        artifact: 'draft report',
        reviewers: ['alice'],
      });
      return { approved: decision.decision === 'approved', reviewer: decision.reviewer };
    });
    engine.register(reviewWorkflowWorkflow5);

    const handle = await engine.start('review-workflow', null);
    await flush();

    // Find the review
    const reviews: ReviewRequest[] = [];
    for await (const [, value] of engine.storage.scan('review:')) {
      reviews.push(decode(value) as ReviewRequest);
    }
    expect(reviews).toHaveLength(1);
    const reviewId = reviews[0]!.reviewId;

    // Submit the review decision
    await engine.submitReview(reviewId, {
      decision: 'approved',
      reviewer: 'alice',
      workflowId: handle.id,
    });
    await flush();

    const result = await handle.result();
    expect(result).toEqual({ approved: true, reviewer: 'alice' });
  });

  it('workflow can continue processing after review', async () => {
    engine = new TestEngine();

    const processAfterReview = mock(() => 'processed');

    const multiStepReviewWorkflow = workflow({ name: 'multi-step-review' }).execute(
      async function* (ctx: WorkflowContext) {
        const c = ctx;

        // Step 1: human review
        const decision = yield* c.review({
          artifact: 'draft',
          reviewers: ['bob'],
        });

        // Step 2: continue processing based on decision
        const postProcessResult = yield* c.run(processAfterReview);

        return { decision: decision.decision, postProcess: postProcessResult };
      },
    );
    engine.register(multiStepReviewWorkflow);

    const handle = await engine.start('multi-step-review', null);
    await flush();

    // Find and submit review
    const reviews: ReviewRequest[] = [];
    for await (const [, value] of engine.storage.scan('review:')) {
      reviews.push(decode(value) as ReviewRequest);
    }
    const reviewId = reviews[0]!.reviewId;

    await engine.submitReview(reviewId, {
      decision: 'approved',
      reviewer: 'bob',
      workflowId: handle.id,
    });
    await flush();

    const result = await handle.result();
    expect(result).toEqual({ decision: 'approved', postProcess: 'processed' });
  });
});

// ---------------------------------------------------------------------------
// G4: Escalation with timeout chains
// ---------------------------------------------------------------------------

describe('G4: Escalation with timeout chains', () => {
  let engine: TestEngine;

  afterEach(() => {
    engine[Symbol.dispose]();
  });

  it('auto-approves after final escalation timeout', async () => {
    engine = new TestEngine({ startTime: 1000 });

    const autoApproveWorkflowWorkflow = workflow({ name: 'auto-approve-workflow' }).execute(
      async function* (ctx: WorkflowContext) {
        const c = ctx;
        const decision = yield* c.review({
          artifact: 'urgent report',
          reviewers: ['alice'],
          escalation: [
            { after: 5000, to: 'manager-queue' },
            { after: 10000, action: 'auto-approve', auditReason: 'timeout' },
          ],
        });

        return {
          decision: decision.decision,
          reviewer: decision.reviewer,
          feedback: decision.feedback,
        };
      },
    );
    engine.register(autoApproveWorkflowWorkflow);

    const handle = await engine.start('auto-approve-workflow', null);
    await flush();

    // Advance time past final escalation threshold
    await engine.advanceTime(11000);
    await flush();

    const result = await handle.result();
    expect(result).toEqual({
      decision: 'approved',
      reviewer: 'system',
      feedback: 'timeout',
    });
  });

  it('persists auto-approved reviews while the workflow keeps running', async () => {
    engine = new TestEngine({ startTime: 1000 });

    const autoApprovePersistedWorkflowWorkflow = workflow({
      name: 'auto-approve-persisted-workflow',
    }).execute(async function* (ctx: WorkflowContext) {
      const c = ctx;
      const decision = yield* c.review({
        artifact: 'urgent report',
        reviewers: ['alice'],
        escalation: [{ after: 5000, action: 'auto-approve', auditReason: 'timeout' }],
      });

      yield* c.sleep(60_000);
      return decision;
    });
    engine.register(autoApprovePersistedWorkflowWorkflow);

    const handle = await engine.start('auto-approve-persisted-workflow', null);
    await flush();
    await engine.advanceTime(6000);
    await flush();

    const reviews = await engine.listReviews({ status: 'completed', workflowId: handle.id });
    expect(reviews).toEqual([
      expect.objectContaining({
        status: 'completed',
        workflowId: handle.id,
        reviewer: 'system',
        feedback: 'timeout',
        decision: 'approved',
      }),
    ]);

    await engine.cancel(handle.id);
    await flush();
  });
});

// ---------------------------------------------------------------------------
// G5: Partial approval
// ---------------------------------------------------------------------------

describe('G5: Partial approval', () => {
  let engine: TestEngine;

  afterEach(() => {
    engine[Symbol.dispose]();
  });

  it('receives structured per-section feedback', async () => {
    engine = new TestEngine();

    const partialReviewWorkflowWorkflow = workflow({ name: 'partial-review-workflow' }).execute(
      async function* (ctx: WorkflowContext) {
        const c = ctx;
        const decision = yield* c.review({
          artifact: { sections: ['intro', 'methods', 'conclusion'] },
          reviewers: ['alice'],
          allowPartial: true,
        });

        return {
          decision: decision.decision,
          sectionDecisions: decision.sectionDecisions,
        };
      },
    );
    engine.register(partialReviewWorkflowWorkflow);

    const handle = await engine.start('partial-review-workflow', null);
    await flush();

    // Find the review
    const reviews: ReviewRequest[] = [];
    for await (const [, value] of engine.storage.scan('review:')) {
      reviews.push(decode(value) as ReviewRequest);
    }
    const reviewId = reviews[0]!.reviewId;

    // Submit per-section decisions
    await engine.submitReview(reviewId, {
      decision: 'needs-changes',
      reviewer: 'alice',
      feedback: 'Methods section needs work',
      sectionDecisions: {
        intro: 'approved',
        methods: 'rejected',
        conclusion: 'approved',
      },
      workflowId: handle.id,
    });
    await flush();

    const result = (await handle.result()) as {
      decision: string;
      sectionDecisions: Record<string, string>;
    };
    expect(result.decision).toBe('needs-changes');
    expect(result.sectionDecisions).toEqual({
      intro: 'approved',
      methods: 'rejected',
      conclusion: 'approved',
    });
  });
});

// ---------------------------------------------------------------------------
// G6: Webhook notification
// ---------------------------------------------------------------------------

describe('G6: Webhook notification', () => {
  let engine: TestEngine;
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;

  afterEach(() => {
    engine[Symbol.dispose]();
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  });

  it('sends webhook POST when review wait begins', async () => {
    engine = new TestEngine();

    const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];

    const mockFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : '';
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      fetchCalls.push({ url, body });
      return new Response('OK', { status: 200 });
    });
    globalThis.fetch = mockFetch as any;

    const webhookWorkflowWorkflow = workflow({ name: 'webhook-workflow' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      const decision = yield* c.review({
        artifact: 'draft report',
        reviewers: ['alice'],
        webhookUrl: 'https://example.com/hook',
      });
      return { decision: decision.decision };
    });
    engine.register(webhookWorkflowWorkflow);

    const handle = await engine.start('webhook-workflow', null);
    await flush();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe('https://example.com/hook');
    expect(fetchCalls[0]!.body).toHaveProperty('workflowId', handle.id);
    expect(fetchCalls[0]!.body).toHaveProperty('reviewType', 'general');
    expect(fetchCalls[0]!.body).toHaveProperty('reviewers', ['alice']);
    expect(typeof fetchCalls[0]!.body['reviewId']).toBe('string');

    // Clean up — submit review so workflow completes
    const reviews: ReviewRequest[] = [];
    for await (const [, value] of engine.storage.scan('review:')) {
      reviews.push(decode(value) as ReviewRequest);
    }
    await engine.submitReview(reviews[0]!.reviewId, {
      decision: 'approved',
      reviewer: 'alice',
      workflowId: handle.id,
    });
    await flush();
  });

  it('ignores AbortError when a pending webhook request is cancelled during shutdown', async () => {
    engine = new TestEngine();

    const mockFetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const webhookAbortWorkflowWorkflow = workflow({ name: 'webhook-abort-workflow' }).execute(
      async function* (ctx: WorkflowContext) {
        const context = ctx;
        yield* context.review({
          artifact: 'draft report',
          reviewers: ['alice'],
          webhookUrl: 'https://example.com/hook',
        });
        return 'done';
      },
    );
    engine.register(webhookAbortWorkflowWorkflow);

    await engine.start('webhook-abort-workflow', null);
    await flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    engine[Symbol.dispose]();
  });
});

// ---------------------------------------------------------------------------
// G7: Events
// ---------------------------------------------------------------------------

describe('G7: Events', () => {
  let engine: TestEngine;

  afterEach(() => {
    engine[Symbol.dispose]();
  });

  it('dispatches ReviewRequestedEvent when review wait begins', async () => {
    engine = new TestEngine();

    const requestedEvents: ReviewRequestedEvent[] = [];
    engine.addEventListener(ReviewRequestedEvent.type, ((event: ReviewRequestedEvent) => {
      requestedEvents.push(event);
    }) as EventListener);

    const eventWorkflowWorkflow = workflow({ name: 'event-workflow' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      const decision = yield* c.review({
        artifact: 'draft',
        reviewType: 'code-review',
        reviewers: ['alice', 'bob'],
      });
      return decision;
    });
    engine.register(eventWorkflowWorkflow);

    const handle = await engine.start('event-workflow', null);
    await flush();

    expect(requestedEvents).toHaveLength(1);
    expect(requestedEvents[0]!.workflowId).toBe(handle.id);
    expect(requestedEvents[0]!.reviewType).toBe('code-review');
    expect(requestedEvents[0]!.reviewers).toEqual(['alice', 'bob']);
    expect(typeof requestedEvents[0]!.reviewId).toBe('string');

    // Clean up
    const reviews: ReviewRequest[] = [];
    for await (const [, value] of engine.storage.scan('review:')) {
      reviews.push(decode(value) as ReviewRequest);
    }
    await engine.submitReview(reviews[0]!.reviewId, {
      decision: 'approved',
      reviewer: 'alice',
      workflowId: handle.id,
    });
    await flush();
  });

  it('dispatches ReviewCompletedEvent when review submitted', async () => {
    engine = new TestEngine();

    const completedEvents: ReviewCompletedEvent[] = [];
    engine.addEventListener(ReviewCompletedEvent.type, ((event: ReviewCompletedEvent) => {
      completedEvents.push(event);
    }) as EventListener);

    const eventWorkflowWorkflow2 = workflow({ name: 'event-workflow' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      const decision = yield* c.review({
        artifact: 'draft',
        reviewers: ['alice'],
      });
      return decision;
    });
    engine.register(eventWorkflowWorkflow2);

    const handle = await engine.start('event-workflow', null);
    await flush();

    const reviews: ReviewRequest[] = [];
    for await (const [, value] of engine.storage.scan('review:')) {
      reviews.push(decode(value) as ReviewRequest);
    }
    const reviewId = reviews[0]!.reviewId;

    await engine.submitReview(reviewId, {
      decision: 'approved',
      reviewer: 'alice',
      workflowId: handle.id,
    });
    await flush();

    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]!.workflowId).toBe(handle.id);
    expect(completedEvents[0]!.reviewId).toBe(reviewId);
    expect(completedEvents[0]!.decision).toBe('approved');
    expect(completedEvents[0]!.reviewer).toBe('alice');
    expect(completedEvents[0]!.duration).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// G8: Review cleanup + timeout error
// ---------------------------------------------------------------------------

describe('G8: Review cleanup + timeout error', () => {
  let engine: TestEngine;

  afterEach(() => {
    engine[Symbol.dispose]();
  });

  it('cleans up review entries when workflow completes', async () => {
    engine = new TestEngine();

    const cleanupWorkflowWorkflow = workflow({ name: 'cleanup-workflow' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      const decision = yield* c.review({
        artifact: 'draft',
        reviewers: ['alice'],
      });
      return decision;
    });
    engine.register(cleanupWorkflowWorkflow);

    const handle = await engine.start('cleanup-workflow', null);
    await flush();

    // Verify review exists
    let reviewCount = 0;
    for await (const [_key] of engine.storage.scan('review:')) {
      reviewCount++;
    }
    expect(reviewCount).toBe(1);

    // Submit review to complete workflow
    const reviews: ReviewRequest[] = [];
    for await (const [, value] of engine.storage.scan('review:')) {
      reviews.push(decode(value) as ReviewRequest);
    }
    await engine.submitReview(reviews[0]!.reviewId, {
      decision: 'approved',
      reviewer: 'alice',
      workflowId: handle.id,
    });
    await flush();
    await handle.result();
    await flush();
    await engine.advanceTime(120_000);
    await flush();

    // Verify review entries cleaned up after workflow completes
    let reviewCountAfter = 0;
    for await (const [_key] of engine.storage.scan('review:')) {
      reviewCountAfter++;
    }
    expect(reviewCountAfter).toBe(0);

    let completedReviewCountAfter = 0;
    for await (const [_key] of engine.storage.scan('review-decision:')) {
      completedReviewCountAfter++;
    }
    expect(completedReviewCountAfter).toBe(0);
  });

  it('throws ReviewTimeoutError when no reviewer responds within timeout', async () => {
    engine = new TestEngine({ startTime: 1000 });

    const timeoutWorkflowWorkflow = workflow({ name: 'timeout-workflow' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      const decision = yield* c.review({
        artifact: 'urgent report',
        reviewers: ['alice'],
        timeout: 5000,
      });
      return decision;
    });
    engine.register(timeoutWorkflowWorkflow);

    const handle = await engine.start('timeout-workflow', null);
    // Attach an error handler so the result rejection doesn't leak
    // as an unhandled rejection before we check the workflow state.
    const resultPromise = handle.result().catch(() => {});
    await flush();

    // Advance time past the review timeout
    await engine.advanceTime(6000);
    await sleepForTesting(50);

    // Wait for the result rejection to settle
    await resultPromise;

    const state = await engine.get(handle.id);
    expect(state!.status).toBe('failed');
    expect(state!.error).toContain('timed out');
  });
});

// ---------------------------------------------------------------------------
// G9: HTTP endpoint — engine.getReview()
// ---------------------------------------------------------------------------

describe('G9: engine.getReview()', () => {
  let engine: Engine;

  afterEach(() => {
    engine[Symbol.dispose]();
  });

  it('returns review details by workflowId and reviewId', async () => {
    const storage = new MemoryStorage();
    engine = new Engine({ storage });
    const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
      _ctx: WorkflowContext,
      input: unknown,
    ) {
      return input;
    });
    engine.register(echoWorkflow);

    const review: ReviewRequest = {
      reviewId: 'rev-3',
      workflowId: 'wf-3',
      artifact: { content: 'report' },
      reviewType: 'code-review',
      reviewers: ['charlie'],
      allowPartial: false,
      createdAt: Date.now(),
    };
    await storage.put(KEYS.review('wf-3', 'rev-3'), encode(review));

    const result = await engine.getReview('wf-3', 'rev-3');
    expect(result).not.toBeNull();
    expect(result!.reviewId).toBe('rev-3');
    expect(result!.artifact).toEqual({ content: 'report' });
    expect(result!.reviewType).toBe('code-review');
    expect(result!.reviewers).toEqual(['charlie']);
  });

  it('returns null for non-existent review', async () => {
    const storage = new MemoryStorage();
    engine = new Engine({ storage });
    const echoWorkflow2 = workflow({ name: 'echo' }).execute(async function* (
      _ctx: WorkflowContext,
      input: unknown,
    ) {
      return input;
    });
    engine.register(echoWorkflow2);

    const result = await engine.getReview('wf-3', 'nonexistent');
    expect(result).toBeNull();
  });
});
