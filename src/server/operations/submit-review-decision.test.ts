import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { anonymousPrincipal } from '../principal.ts';
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
    const engine = createEngine();
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
    const engine = createEngine();
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
    const engine = createEngine();
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
          principal: anonymousPrincipal(),
          engine,
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
    const engine = createEngine();

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
    });
  });

  it('returns 400 for validation failures', async () => {
    const engine = createEngine();

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
    });
  });

  it('returns 404 when the engine reports that the review was not found', async () => {
    const engine = createEngine();
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
      expect(await response.json()).toEqual({ error: 'review not found' });
    } finally {
      engine.submitReview = originalSubmitReview;
    }
  });

  it('masks unexpected engine failures to a 500 generic error body', async () => {
    const engine = createEngine();
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
      expect(await response.json()).toEqual({ error: 'Internal server error' });
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
