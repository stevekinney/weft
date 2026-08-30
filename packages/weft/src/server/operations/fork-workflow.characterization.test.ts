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
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import {
  forkWorkflowOperation,
  forkWorkflowRestBinding,
  resolveForkAccess,
} from './fork-workflow.ts';
import { jsonRequest } from './operation-test-helpers.test-support.ts';

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

  // --- engine error routing: tested directly against resolveForkAccess ---
  //
  // These tests target the extracted error-mapping helper rather than monkey-
  // patching `engine.fork`. The mapping is a pure function over an `Error`
  // instance, so the unit-level test is both more precise and stable.
  it('resolveForkAccess maps "Checkpoint not found at step N" to InvalidParams', () => {
    let captured: unknown;
    try {
      resolveForkAccess(new Error('Checkpoint not found at step 5'));
    } catch (fault) {
      captured = fault;
    }
    expect(captured).toMatchObject({
      code: 'InvalidParams',
      message: 'Checkpoint not found at step 5',
    });
  });

  it('resolveForkAccess maps "Checkpoint not found" (no step) to NotFound checkpoint', () => {
    let captured: unknown;
    try {
      resolveForkAccess(new Error('Checkpoint not found for workflow'));
    } catch (fault) {
      captured = fault;
    }
    expect(captured).toMatchObject({
      code: 'NotFound',
      data: { resource: 'checkpoint' },
    });
  });

  it('resolveForkAccess maps "workflow not found" to NotFound workflow', () => {
    let captured: unknown;
    try {
      resolveForkAccess(new Error('workflow not found'));
    } catch (fault) {
      captured = fault;
    }
    expect(captured).toMatchObject({
      code: 'NotFound',
      data: { resource: 'workflow' },
    });
  });

  // --- all-bad: field validation error takes precedence over engine reachability ---
  //
  // With a real engine (no monkey-patching), the workflow ID 'wf-nonexistent'
  // does not exist, so `engine.fork` would naturally throw a 'not found' error.
  // We assert that field validation surfaces first.
  it('reports fromStep validation error even when the target workflow does not exist', async () => {
    engine = createEngine();
    const response = await handleRequest(
      jsonRequest('POST', '/v1/workflows/wf-nonexistent/fork', { fromStep: -99 }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "fromStep" must be a non-negative safe integer',
    });
  });
});
