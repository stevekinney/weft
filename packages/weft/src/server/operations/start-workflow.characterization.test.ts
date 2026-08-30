/**
 * Characterization tests for `validateStartWorkflowInput` and
 * `resolveStartWorkflowAccess` (extracted from `startWorkflowOperation.invoke`).
 *
 * Field-validation order in source (lines 67–81):
 *   1. type — must be a non-empty string (checked inline before buildStartWorkflowOptions)
 *   2. All remaining fields are validated inside buildStartWorkflowOptions via
 *      coerce* helpers; the first failing field in that function's order wins.
 *
 * `buildStartWorkflowOptions` field order (lines 132–165):
 *   a. id
 *   b. executionTimeout
 *   c. startAt
 *   d. startAfter
 *   e. tags
 *   f. idempotencyKey (always throws when present)
 *   g. searchAttributes
 *
 * Adjacent-pair tests assert that when two consecutive fields are invalid the
 * error for the earlier-listed field surfaces first. The all-bad test passes
 * all validatable fields with invalid values and asserts the first error wins.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { jsonRequest } from './operation-test-helpers.test-support.ts';
import { startWorkflowOperation, startWorkflowRestBinding } from './start-workflow.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register(echoWorkflow);
  return engine;
}

const registry = createOperationRegistry([startWorkflowOperation]);
const bindings = [startWorkflowRestBinding];

describe('start-workflow — validation precedence', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  // --- type is the very first check ---
  it('reports type error when type is missing (empty string)', async () => {
    engine = createEngine();
    const response = await handleRequest(
      jsonRequest('POST', '/v1/workflows', { type: '' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Missing required field: type' });
  });

  // --- adjacent pair: type before id ---
  it('reports type error before id error when both are invalid', async () => {
    engine = createEngine();
    const response = await handleRequest(
      jsonRequest('POST', '/v1/workflows', { type: '', id: 42 }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Missing required field: type' });
  });

  // --- adjacent pair: id before executionTimeout ---
  it('reports id error before executionTimeout error when both are invalid', async () => {
    engine = createEngine();
    const response = await handleRequest(
      jsonRequest('POST', '/v1/workflows', { type: 'echo', id: 42, executionTimeout: 'bad' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(response.status).toBe(400);
    // id: 42 is a number, not a string, so coerceStartWorkflowId rejects it
    expect(((await response.json()) as { error: string }).error).toMatch(/id/i);
  });

  // --- adjacent pair: executionTimeout before startAt ---
  it('reports executionTimeout error before startAt error when both are invalid', async () => {
    engine = createEngine();
    const response = await handleRequest(
      jsonRequest('POST', '/v1/workflows', {
        type: 'echo',
        executionTimeout: 'not-a-duration',
        startAt: 'not-a-timestamp',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/executionTimeout/i);
  });

  // --- adjacent pair: startAt before startAfter ---
  it('reports startAt error before startAfter error when both are invalid', async () => {
    engine = createEngine();
    const response = await handleRequest(
      jsonRequest('POST', '/v1/workflows', {
        type: 'echo',
        startAt: 'not-a-timestamp',
        startAfter: 'not-a-duration',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/startAt/i);
  });

  // --- adjacent pair: tags before idempotencyKey ---
  it('reports tags error before idempotencyKey error when both are invalid', async () => {
    engine = createEngine();
    const response = await handleRequest(
      jsonRequest('POST', '/v1/workflows', {
        type: 'echo',
        tags: 42,
        idempotencyKey: 'some-key',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/tags/i);
  });

  // --- all-bad: type (the very first check) wins ---
  it('reports type error when all fields are invalid', async () => {
    engine = createEngine();
    const response = await handleRequest(
      jsonRequest('POST', '/v1/workflows', {
        type: '',
        id: 42,
        executionTimeout: 'bad',
        startAt: 'bad',
        startAfter: 'bad',
        tags: 42,
        idempotencyKey: 'key',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Missing required field: type' });
  });
});
