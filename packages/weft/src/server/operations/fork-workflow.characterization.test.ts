/**
 * Characterization tests for `validateForkInput` and `resolveForkAccess`
 * (extracted from `forkWorkflowOperation.invoke`).
 *
 * Field-validation order in source:
 *   1. fromStep — must be a non-negative safe integer when provided
 *   2. revision — schema-validated as a non-empty string; no further
 *      format check here (WFT-21) — an unresolvable value surfaces as the
 *      engine's own `WorkflowRevisionUnavailableError`, routed below.
 *
 * Engine-error routing order (WFT-21 adds step 0 ahead of the pre-existing
 * substring-based routing):
 *   0. `error instanceof WorkflowRevisionUnavailableError`             → Conflict (409), typed check
 *   1. message includes 'fromStep' or 'Checkpoint not found at step' → InvalidParams (400)
 *   2. message includes 'Checkpoint not found'                        → NotFound (404), resource: 'checkpoint'
 *   3. message includes 'not found'                                   → NotFound (404), resource: 'workflow'
 *   4. otherwise                                                       → EngineFailure (500)
 *
 * Adjacent-pair tests confirm that when two consecutive conditions would both
 * match, the earlier condition surfaces first. The all-bad test passes an
 * invalid `fromStep` alongside an engine set to throw, confirming the
 * field-validation error takes precedence. The new `revision`-input test at
 * the end proves the additive field doesn't disturb any existing golden
 * fixture shape.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { WorkflowRevisionUnavailableError } from '../../core/engine/revision-errors.ts';
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

  // --- WFT-21: a typed WorkflowRevisionUnavailableError maps to Conflict, ---
  // --- checked ahead of every substring-based branch above ---
  it('resolveForkAccess maps WorkflowRevisionUnavailableError to Conflict, never NotFound (its own message contains "not registered")', () => {
    let captured: unknown;
    try {
      resolveForkAccess(
        new WorkflowRevisionUnavailableError('echo', 'some-revision', 'not-registered'),
      );
    } catch (fault) {
      captured = fault;
    }
    expect(captured).toMatchObject({
      code: 'Conflict',
      data: { reason: 'not-registered' },
    });
  });

  // --- WFT-21: the additive `revision` input field doesn't disturb the ---
  // --- existing golden happy-path output shape ---
  it('accepts the optional revision input field without changing the success output shape', async () => {
    engine = createEngine();
    const originalFork = engine.fork.bind(engine);
    try {
      engine.fork = async () =>
        ({ id: 'forked-workflow-golden' }) as Awaited<ReturnType<Engine['fork']>>;

      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows/wf-1/fork', { revision: 'a-specific-revision' }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ id: 'forked-workflow-golden' });
    } finally {
      engine.fork = originalFork;
    }
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
