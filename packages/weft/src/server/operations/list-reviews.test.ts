import { afterEach, describe, expect, it } from 'bun:test';

import { encode } from '../../core/codec.ts';
import { Engine } from '../../core/engine.ts';
import type { ReviewRequest } from '../../core/review/index.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { principalFromApiKey } from '../principal.ts';
import { storeHistoricalReviewDecisionWithoutRequestMetadata } from '../review-test-support.test-support.ts';
import { listReviewsOperation, listReviewsRestBinding } from './list-reviews.ts';

function createEngineWithStorage(): { engine: Engine; storage: MemoryStorage } {
  const storage = new MemoryStorage();
  return { engine: new Engine({ storage }), storage };
}

const registry = createOperationRegistry([listReviewsOperation]);

function reviewsReadAuthContext() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({ subject: 'reviews-reader', scopes: ['reviews:read'] }),
    },
  };
}

function workflowsReadAuthContext() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({ subject: 'workflow-reader', scopes: ['workflows:read'] }),
    },
  };
}

describe('weft.reviews.list', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('returns review items on the happy path', async () => {
    const setup = createEngineWithStorage();
    engine = setup.engine;

    const review: ReviewRequest = {
      reviewId: 'rev-1',
      workflowId: 'wf-1',
      artifact: { text: 'review me' },
      reviewType: 'general',
      reviewers: ['alice'],
      allowPartial: false,
      createdAt: 1_234,
    };
    await setup.storage.put(KEYS.review(review.workflowId, review.reviewId), encode(review));

    const response = await handleRequest(
      new Request('http://localhost/v1/reviews', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [listReviewsRestBinding],
        ...reviewsReadAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      items: [
        {
          status: 'pending',
          ...review,
        },
      ],
    });
  });

  it('accepts REST query filters and returns completed review entries', async () => {
    const setup = createEngineWithStorage();
    engine = setup.engine;

    const review: ReviewRequest = {
      reviewId: 'rev-completed',
      workflowId: 'wf-completed',
      artifact: { text: 'review me' },
      reviewType: 'design',
      reviewers: ['alice'],
      allowPartial: false,
      createdAt: 1_234,
    };
    await setup.storage.put(KEYS.review(review.workflowId, review.reviewId), encode(review));
    await engine.submitReview(review.reviewId, {
      decision: 'approved',
      reviewer: 'alice',
      workflowId: review.workflowId,
    });

    const response = await handleRequest(
      new Request(
        'http://localhost/v1/reviews?status=completed&workflowId=wf-completed&reviewType=design',
        { method: 'GET' },
      ),
      engine,
      {
        operationRegistry: registry,
        restBindings: [listReviewsRestBinding],
        ...reviewsReadAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        {
          status: 'completed',
          reviewId: 'rev-completed',
          workflowId: 'wf-completed',
          artifact: { text: 'review me' },
          reviewType: 'design',
          reviewers: ['alice'],
          allowPartial: false,
          createdAt: 1_234,
          decision: 'approved',
          reviewer: 'alice',
          timestamp: expect.any(Number),
        },
      ],
    });
  });

  it('skips completed review records missing canonical request metadata', async () => {
    const setup = createEngineWithStorage();
    engine = setup.engine;

    await storeHistoricalReviewDecisionWithoutRequestMetadata(setup.storage);

    const response = await handleRequest(
      new Request('http://localhost/v1/reviews?status=completed', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [listReviewsRestBinding],
        ...reviewsReadAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
  });

  it('rejects completed review operation output missing artifact metadata', () => {
    const result = listReviewsOperation.outputSchema.safeParse({
      items: [
        {
          status: 'completed',
          reviewId: 'missing-artifact',
          workflowId: 'wf-missing-artifact',
          reviewType: 'design',
          reviewers: ['alice'],
          allowPartial: false,
          createdAt: 1_000,
          decision: 'approved',
          reviewer: 'alice',
          timestamp: 2_000,
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('returns 400 when the status filter is invalid', async () => {
    const setup = createEngineWithStorage();
    engine = setup.engine;

    const response = await handleRequest(
      new Request('http://localhost/v1/reviews?status=bogus', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [listReviewsRestBinding],
        ...reviewsReadAuthContext(),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('status'),
      }),
    );
  });

  it('masks EngineFailure faults to a 500 with a generic error body', async () => {
    const setup = createEngineWithStorage();
    engine = setup.engine;

    const failingOperation = {
      ...listReviewsOperation,
      invoke: async () => {
        const fault: OperationFault = {
          code: 'EngineFailure',
          message: 'secret internal detail',
          data: {},
        };
        throw fault;
      },
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/reviews', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([failingOperation]),
        restBindings: [listReviewsRestBinding],
        ...reviewsReadAuthContext(),
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });

  it('returns 401 when the caller is anonymous', async () => {
    const setup = createEngineWithStorage();
    engine = setup.engine;

    const response = await handleRequest(
      new Request('http://localhost/v1/reviews', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [listReviewsRestBinding],
      },
    );

    expect(response.status).toBe(401);
  });

  it('returns 403 when the caller lacks reviews:read', async () => {
    const setup = createEngineWithStorage();
    engine = setup.engine;

    const response = await handleRequest(
      new Request('http://localhost/v1/reviews', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [listReviewsRestBinding],
        ...workflowsReadAuthContext(),
      },
    );

    expect(response.status).toBe(403);
  });
});
