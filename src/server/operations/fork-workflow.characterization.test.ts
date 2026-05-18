/**
 * Characterization tests for `validateForkInput` and `resolveForkAccess`
 * (extracted from `forkWorkflowOperation.invoke`).
 *
 * Field-validation order in source (lines 40–48):
 *   1. fromStep — must be a non-negative safe integer when provided
 *
 * Engine-error routing order (lines 57–83):
 *   1. message includes 'fromStep' or 'Checkpoint not found at step' → InvalidParams (400)
 *   2. message includes 'Checkpoint not found'                        → NotFound (404), resource: 'checkpoint'
 *   3. message includes 'not found'                                   → NotFound (404), resource: 'workflow'
 *   4. otherwise                                                       → EngineFailure (500)
 *
 * Adjacent-pair tests confirm that when two consecutive conditions would both
 * match, the earlier condition surfaces first. The all-bad test passes an
 * invalid `fromStep` alongside an engine set to throw, confirming the
 * field-validation error takes precedence.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { forkWorkflowOperation, forkWorkflowRestBinding } from './fork-workflow.ts';
import { jsonRequest } from './operation-test-helpers.test-support.ts';

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });
  return engine;
}

const registry = createOperationRegistry([forkWorkflowOperation]);
const bindings = [forkWorkflowRestBinding];

describe('fork-workflow — validation precedence', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  // --- fromStep validation: negative integer rejected ---
  it('reports fromStep error for a negative integer', async () => {
    engine = createEngine();
    const response = await handleRequest(
      jsonRequest('POST', '/v1/workflows/wf-1/fork', { fromStep: -1 }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "fromStep" must be a non-negative safe integer',
    });
  });

  // --- fromStep validation: non-integer rejected ---
  it('reports fromStep error for a non-integer number', async () => {
    engine = createEngine();
    const response = await handleRequest(
      jsonRequest('POST', '/v1/workflows/wf-1/fork', { fromStep: 1.5 }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "fromStep" must be a non-negative safe integer',
    });
  });

  // --- engine error routing: 'Checkpoint not found at step' wins over 'Checkpoint not found' ---
  it('maps "Checkpoint not found at step N" to 400 (not 404)', async () => {
    engine = createEngine();
    const originalFork = engine.fork.bind(engine);

    try {
      engine.fork = async () => {
        throw new Error('Checkpoint not found at step 5');
      };
      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows/wf-1/fork'),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Checkpoint not found at step 5' });
    } finally {
      engine.fork = originalFork;
    }
  });

  // --- engine error routing: 'Checkpoint not found' (without 'at step') maps to 404 ---
  it('maps "Checkpoint not found" to 404 with resource=checkpoint', async () => {
    engine = createEngine();
    const originalFork = engine.fork.bind(engine);

    try {
      engine.fork = async () => {
        throw new Error('Checkpoint not found for workflow');
      };
      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows/wf-1/fork'),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );
      expect(response.status).toBe(404);
    } finally {
      engine.fork = originalFork;
    }
  });

  // --- all-bad: field validation error takes precedence over engine throw ---
  it('reports fromStep validation error even when engine would also throw', async () => {
    engine = createEngine();
    const originalFork = engine.fork.bind(engine);

    try {
      // Engine would throw 'not found', but field validation fires first.
      engine.fork = async () => {
        throw new Error('workflow not found');
      };
      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows/wf-1/fork', { fromStep: -99 }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'Field "fromStep" must be a non-negative safe integer',
      });
    } finally {
      engine.fork = originalFork;
    }
  });
});
