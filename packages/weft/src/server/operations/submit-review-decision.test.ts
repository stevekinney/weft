import { describe, expect, it } from 'bun:test';
import { WEFT_SCOPE_VOCABULARY } from '../../authorization-scopes.ts';

import { principalFromUnauthenticatedLocal } from "../../embedded/backchannel/src/index.ts";
import { createOperationRegistry, executeOperation } from "../../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { Engine } from '../../core/engine.ts';
import { type WorkflowContext, workflow } from '../../core/types.ts';
import { handleRequestAsLocalUser as handleRequest } from '../local-user-request.test-support.ts';
import {
  submitReviewDecisionOperation,
  submitReviewDecisionRestBinding,
} from './submit-review-decision.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register(echoWorkflow);
  return engine;
}

const registry = createOperationRegistry([submitReviewDecisionOperation]);
const bindings = [submitReviewDecisionRestBinding];

describe('weft.reviews.decision.submit', () => {
  it('submits a review decision and returns the ok response', async () => {
    await using engine = createEngine();
    let capturedReviewId = '';
    let capturedOptions: unknown;
    const originalSubmitReview = engine.submitReview.bind(engine);
    engine.submitReview = async (reviewId, options) => {
      capturedReviewId = reviewId;
      capturedOptions = options;
    };

    try {
      const response = await handleRequest(
        request('POST', '/v1/reviews/rev-1/decision', {
          decision: 'approved',
          reviewer: 'alice',
          feedback: 'Looks good',
          workflowId: 'wf-1',
        }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(capturedReviewId).toBe('rev-1');
      expect(capturedOptions).toEqual({
        decision: 'approved',
        reviewer: 'alice',
        feedback: 'Looks good',
        workflowId: 'wf-1',
      });
    } finally {
      engine.submitReview = originalSubmitReview;
    }
  });

  it('submits sectionDecisions over REST and passes them through to the engine', async () => {
    await using engine = createEngine();
    let capturedOptions: unknown;
    const originalSubmitReview = engine.submitReview.bind(engine);
    engine.submitReview = async (_reviewId, options) => {
      capturedOptions = options;
    };

    try {
      const response = await handleRequest(
        request('POST', '/v1/reviews/rev-1/decision', {
          decision: 'needs-changes',
          reviewer: 'alice',
          feedback: 'Body needs work',
          sectionDecisions: { intro: 'approved', body: 'rejected' },
        }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(200);
      expect(capturedOptions).toEqual({
        decision: 'needs-changes',
        reviewer: 'alice',
        feedback: 'Body needs work',
        sectionDecisions: { intro: 'approved', body: 'rejected' },
      });
    } finally {
      engine.submitReview = originalSubmitReview;
    }
  });

  it('submits sectionDecisions over JSON-RPC without being rejected as an unknown key', async () => {
    await using engine = createEngine();
    let capturedOptions: unknown;
    const originalSubmitReview = engine.submitReview.bind(engine);
    engine.submitReview = async (_reviewId, options) => {
      capturedOptions = options;
    };

    try {
      const result = await executeOperation(
        'weft.reviews.decision.submit',
        {
          reviewId: 'rev-1',
          decision: 'needs-changes',
          reviewer: 'alice',
          feedback: 'Body needs work',
          sectionDecisions: { intro: 'approved', body: 'rejected' },
        },
        {
          principal: principalFromUnauthenticatedLocal(WEFT_SCOPE_VOCABULARY),
          host: engine,
          transport: 'jsonRpcHttp',
          registry,
        },
      );

      expect(result.ok).toBe(true);
      expect(capturedOptions).toEqual({
        decision: 'needs-changes',
        reviewer: 'alice',
        feedback: 'Body needs work',
        sectionDecisions: { intro: 'approved', body: 'rejected' },
      });
    } finally {
      engine.submitReview = originalSubmitReview;
    }
  });

  it('rejects a malformed sectionDecisions value with InvalidParams', async () => {
    await using engine = createEngine();

    const response = await handleRequest(
      request('POST', '/v1/reviews/rev-1/decision', {
        decision: 'approved',
        reviewer: 'alice',
        sectionDecisions: { intro: 'maybe' },
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        'Field "sectionDecisions" must be a record mapping section names to "approved" or "rejected"',
      retryable: false,
    });
  });

  it('returns 400 for validation failures', async () => {
    await using engine = createEngine();

    const response = await handleRequest(
      request('POST', '/v1/reviews/rev-1/decision', {
        decision: 'maybe',
        reviewer: 'alice',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Invalid decision "maybe". Must be one of: approved, rejected, needs-changes',
      retryable: false,
    });
  });

  it.each([[[{ decision: 'approved' }]], [null], ['approved'], [7]])(
    'treats a non-object JSON body (%j) as an empty decision and returns 400',
    async (body) => {
      await using engine = createEngine();
      engine.submitReview = async () => {
        throw new Error('must not submit a review for a non-object body');
      };

      const response = await handleRequest(
        request('POST', '/v1/reviews/rev-1/decision', body),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(400);
    },
  );

  it('returns 404 when the engine reports that the review was not found', async () => {
    await using engine = createEngine();
    const originalSubmitReview = engine.submitReview.bind(engine);
    engine.submitReview = async () => {
      throw new Error('review not found');
    };

    try {
      const response = await handleRequest(
        request('POST', '/v1/reviews/rev-missing/decision', {
          decision: 'approved',
          reviewer: 'alice',
        }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: 'review not found',
        data: { resource: 'review', identifier: 'rev-missing' },
        retryable: false,
      });
    } finally {
      engine.submitReview = originalSubmitReview;
    }
  });

  it('masks unexpected engine failures to a 500 generic error body', async () => {
    await using engine = createEngine();
    const originalSubmitReview = engine.submitReview.bind(engine);
    engine.submitReview = async () => {
      throw new Error('review submission failed');
    };

    try {
      const response = await handleRequest(
        request('POST', '/v1/reviews/rev-1/decision', {
          decision: 'approved',
          reviewer: 'alice',
        }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error', retryable: false });
    } finally {
      engine.submitReview = originalSubmitReview;
    }
  });
});

function request(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, init);
}
