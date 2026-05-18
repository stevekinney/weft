/**
 * Characterization tests for `validateReviewDecisionInput` and
 * `mapReviewDecisionError` (extracted from `submitReviewDecisionOperation.invoke`).
 *
 * Field-validation order in source (lines 48–73):
 *   1. decision + reviewer presence  — both must be strings (checked together; missing
 *      either triggers "Missing required fields: decision, reviewer")
 *   2. decision value validity        — must be one of approved|rejected|needs-changes
 *   3. feedback type                  — must be a string when provided
 *
 * Engine-error routing order (lines 90–105):
 *   1. message includes 'not found' → NotFound (404)
 *   2. otherwise                    → EngineFailure (500)
 *
 * Adjacent-pair tests assert that when two consecutive checks would both fire,
 * the earlier check surfaces first. The all-bad test passes every field with an
 * invalid value and asserts that the first error wins.
 */

import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import {
  submitReviewDecisionOperation,
  submitReviewDecisionRestBinding,
} from './submit-review-decision.ts';

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });
  return engine;
}

const registry = createOperationRegistry([submitReviewDecisionOperation]);
const bindings = [submitReviewDecisionRestBinding];

function postRequest(reviewId: string, body: unknown): Request {
  return new Request(`http://localhost/v1/reviews/${reviewId}/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('submit-review-decision — validation precedence', () => {
  // --- presence check fires first when decision is missing ---
  it('reports missing fields error when decision is absent', async () => {
    const engine = createEngine();
    const response = await handleRequest(postRequest('rev-1', { reviewer: 'alice' }), engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Missing required fields: decision, reviewer',
    });
  });

  // --- presence check fires first when reviewer is missing ---
  it('reports missing fields error when reviewer is absent', async () => {
    const engine = createEngine();
    const response = await handleRequest(postRequest('rev-1', { decision: 'approved' }), engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Missing required fields: decision, reviewer',
    });
  });

  // --- adjacent pair: presence before decision validity ---
  // Both missing reviewer AND invalid decision value → presence check wins.
  it('reports missing fields error before invalid-decision error', async () => {
    const engine = createEngine();
    const response = await handleRequest(postRequest('rev-1', { decision: 'maybe' }), engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Missing required fields: decision, reviewer',
    });
  });

  // --- adjacent pair: decision validity before feedback type ---
  // Invalid decision value AND non-string feedback → decision validity wins.
  it('reports invalid-decision error before feedback-type error', async () => {
    const engine = createEngine();
    const response = await handleRequest(
      postRequest('rev-1', { decision: 'maybe', reviewer: 'alice', feedback: 42 }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Invalid decision "maybe". Must be one of: approved, rejected, needs-changes',
    });
  });

  // --- feedback-type error surfaces when decision and reviewer are valid ---
  it('reports feedback-type error when only feedback is invalid', async () => {
    const engine = createEngine();
    const response = await handleRequest(
      postRequest('rev-1', { decision: 'approved', reviewer: 'alice', feedback: 42 }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "feedback" must be a string when provided',
    });
  });

  // --- all-bad: presence check (earliest) wins ---
  it('reports missing fields error when all fields are invalid', async () => {
    const engine = createEngine();
    const response = await handleRequest(
      postRequest('rev-1', { decision: 'maybe', feedback: 42 }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Missing required fields: decision, reviewer',
    });
  });
});
