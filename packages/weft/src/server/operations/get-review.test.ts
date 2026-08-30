import { afterEach, describe, expect, it } from 'bun:test';

import { encode } from '../../core/codec.ts';
import { Engine } from '../../core/engine.ts';
import type { ReviewRequest } from '../../core/review/index.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { getReviewOperation, getReviewRestBinding } from './get-review.ts';

function createEngineWithStorage(): { engine: Engine; storage: MemoryStorage } {
  const storage = new MemoryStorage();
  return { engine: new Engine({ storage }), storage };
}

const registry = createOperationRegistry([getReviewOperation]);

describe('weft.reviews.get', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('returns the review on the happy path', async () => {
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
      new Request('http://localhost/v1/workflows/wf-1/review/rev-1', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getReviewRestBinding],
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual(review);
  });

  it('returns 404 with the canonical error body when the review does not exist', async () => {
    const setup = createEngineWithStorage();
    engine = setup.engine;

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/wf-1/review/rev-missing', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getReviewRestBinding],
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'Review "rev-missing" not found for workflow "wf-1"',
      data: { resource: 'review', identifier: 'rev-missing' },
    });
  });

  it('masks EngineFailure faults to a 500 with a generic error body', async () => {
    const setup = createEngineWithStorage();
    engine = setup.engine;

    const failingOperation = {
      ...getReviewOperation,
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
      new Request('http://localhost/v1/workflows/wf-1/review/rev-1', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([failingOperation]),
        restBindings: [getReviewRestBinding],
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});
