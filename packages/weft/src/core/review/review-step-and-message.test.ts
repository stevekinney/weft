/**
 * COR-2426 — a review request keeps the step that asks and what its author says. Both fields are
 * optional on the stored record, so a request stored before they were kept still reads; they are
 * checked where a workflow asks, before anything is written; and they survive every hop from the
 * stored request to the `weft.reviews.list` wire, pending and completed.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { principalFromApiKey } from "../../embedded/backchannel/src/index.ts";
import { createOperationRegistry } from "../../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { waitForCondition } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { rejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";

import { handleRequest } from '../../server/handler.ts';
import {
  listReviewsOperation,
  listReviewsRestBinding,
} from '../../server/operations/list-reviews.ts';
import { KEYS } from '../../storage/keys.ts';
import { TestEngine } from '../../testing/test-engine.ts';
import { encode } from '../codec.ts';
import { Engine } from '../engine.ts';
import type { WorkflowContext } from '../types.ts';
import { workflow } from '../types.ts';
import {
  REVIEW_MESSAGE_MAXIMUM_LENGTH,
  REVIEW_STEP_MAXIMUM_LENGTH,
  ReviewCoordinator,
  type ReviewRequest,
} from './index.ts';

const STEP = 'Collect merged changes';
const MESSAGE = 'Here is the draft. Approve it to publish, or send it back with a note.';

const registry = createOperationRegistry([listReviewsOperation]);

/** The items `weft.reviews.list` answers over REST for `query`. */
async function listedOnTheWire(engine: Engine, query: string): Promise<unknown[]> {
  const response = await handleRequest(
    new Request(`http://localhost/v1/reviews${query}`, { method: 'GET' }),
    engine,
    {
      operationRegistry: registry,
      restBindings: [listReviewsRestBinding],
      authContext: {
        method: 'api-key' as const,
        principal: principalFromApiKey({ subject: 'reader', scopes: ['reviews:read'] }),
      },
    },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { items: unknown[] };
  return body.items;
}

async function storedReviewKeys(storage: MemoryStorage): Promise<string[]> {
  const keys: string[] = [];
  for await (const [key] of storage.scan('review:')) keys.push(key);
  return keys;
}

describe('a review request’s step and message, checked where the workflow asks', () => {
  it('keeps them trimmed, and keeps neither when it is empty', async () => {
    const storage = new MemoryStorage();
    const coordinator = new ReviewCoordinator(storage);

    const kept = await coordinator.createReview('wf-1', {
      artifact: {},
      reviewType: 'approval',
      step: `  ${STEP}  `,
      message: MESSAGE,
    });
    const empty = await coordinator.createReview('wf-2', {
      artifact: {},
      reviewType: 'approval',
      step: '   ',
      message: '',
    });

    expect(kept).toMatchObject({ step: STEP, message: MESSAGE });
    expect(Object.hasOwn(empty, 'step')).toBe(false);
    expect(Object.hasOwn(empty, 'message')).toBe(false);
  });

  it('is a TypeError that writes no review for a step or message that is not a string or too long', async () => {
    const storage = new MemoryStorage();
    const coordinator = new ReviewCoordinator(storage);
    const cases = [
      { step: 42 },
      { message: { text: 'no' } },
      { step: 'x'.repeat(REVIEW_STEP_MAXIMUM_LENGTH + 1) },
      { message: 'x'.repeat(REVIEW_MESSAGE_MAXIMUM_LENGTH + 1) },
    ];

    for (const fields of cases) {
      const options = { artifact: {}, reviewType: 'approval', ...fields } as never;
      expect(await rejectionOf(coordinator.createReview('wf-1', options))).toBeInstanceOf(
        TypeError,
      );
    }
    expect(await storedReviewKeys(storage)).toEqual([]);
  });
});

describe('a review request’s step and message, from the stored record to the wire', () => {
  let engine: TestEngine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('carries both from ctx.review() through the stored request to the pending and completed lists and the wire', async () => {
    engine = new TestEngine();
    const publish = workflow({ name: 'publish-draft' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.review({
        artifact: { draft: 'v1' },
        reviewType: 'approval',
        reviewers: ['editor'],
        step: STEP,
        message: MESSAGE,
      });
    });
    engine.register(publish);
    const started = engine;
    const handle = await engine.start('publish-draft', null);
    const result = handle.result();
    await waitForCondition(
      async () => {
        const listed = await started.listReviews();
        return listed.length === 1;
      },
      { label: 'the review request to be stored' },
    );

    const [pending] = await engine.listReviews();
    expect(pending).toMatchObject({ status: 'pending', step: STEP, message: MESSAGE });
    if (pending === undefined) throw new Error('expected a pending review');
    const stored = await engine.getReview(pending.workflowId, pending.reviewId);
    expect(stored).toMatchObject({ step: STEP, message: MESSAGE });
    expect(await listedOnTheWire(engine, '')).toEqual([
      expect.objectContaining({ status: 'pending', step: STEP, message: MESSAGE }),
    ]);

    await engine.submitReview(pending.reviewId, { decision: 'approved', reviewer: 'editor' });
    await result;

    const completed = await engine.listReviews({ status: 'completed' });
    expect(completed).toEqual([
      expect.objectContaining({ status: 'completed', step: STEP, message: MESSAGE }),
    ]);
    expect(await listedOnTheWire(engine, '?status=completed')).toEqual([
      expect.objectContaining({ status: 'completed', step: STEP, message: MESSAGE }),
    ]);
  });

  it('still reads a request stored before either was kept, with neither field', async () => {
    const storage = new MemoryStorage();
    const plain = new Engine({ storage });
    try {
      const review: ReviewRequest = {
        reviewId: 'rev-old',
        workflowId: 'wf-old',
        artifact: {},
        reviewType: 'approval',
        reviewers: [],
        allowPartial: false,
        createdAt: 1,
      };
      await storage.put(KEYS.review(review.workflowId, review.reviewId), encode(review));

      const [listed] = await plain.listReviews();
      expect(listed).toMatchObject({ reviewId: 'rev-old', status: 'pending' });
      expect(Object.hasOwn(listed ?? {}, 'step')).toBe(false);
      expect(Object.hasOwn(listed ?? {}, 'message')).toBe(false);
    } finally {
      plain[Symbol.dispose]();
    }
  });
});
