import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { forkWorkflowOperation, forkWorkflowRestBinding } from './fork-workflow.ts';
import { invalidJsonRequest, jsonRequest } from './operation-test-helpers.test-support.ts';

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });
  return engine;
}

const registry = createOperationRegistry([forkWorkflowOperation]);
const bindings = [forkWorkflowRestBinding];

describe('weft.workflows.fork', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('returns 201 with the forked workflow id on the happy path', async () => {
    engine = createEngine();
    const originalFork = engine.fork.bind(engine);

    try {
      engine.fork = async (workflowId, options) => {
        expect(workflowId).toBe('workflow-123');
        expect(options).toEqual({ fromStep: 3 });
        return { id: 'forked-workflow' } as Awaited<ReturnType<Engine['fork']>>;
      };

      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows/workflow-123/fork', { fromStep: 3 }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ id: 'forked-workflow' });
    } finally {
      engine.fork = originalFork;
    }
  });

  it('returns 400 when the request body is invalid JSON', async () => {
    engine = createEngine();

    const response = await handleRequest(
      invalidJsonRequest('POST', '/v1/workflows/workflow-123/fork', '{'),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
  });

  it('returns 400 when the request body is not a JSON object', async () => {
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('POST', '/v1/workflows/workflow-123/fork', ['not-an-object']),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Request body must be a JSON object' });
  });

  it('returns 400 when fromStep is not a non-negative safe integer', async () => {
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('POST', '/v1/workflows/workflow-123/fork', { fromStep: -1 }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "fromStep" must be a non-negative safe integer',
    });
  });

  it('returns 400 when the engine reports an invalid checkpoint step', async () => {
    engine = createEngine();
    const originalFork = engine.fork.bind(engine);

    try {
      engine.fork = async () => {
        throw new Error('Checkpoint not found at step 7');
      };

      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows/workflow-123/fork'),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Checkpoint not found at step 7' });
    } finally {
      engine.fork = originalFork;
    }
  });

  it('returns 404 when the current checkpoint is missing', async () => {
    engine = createEngine();
    const originalFork = engine.fork.bind(engine);

    try {
      engine.fork = async () => {
        throw new Error('Checkpoint not found for workflow "workflow-123"');
      };

      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows/workflow-123/fork'),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: 'Checkpoint not found for workflow "workflow-123"',
      });
    } finally {
      engine.fork = originalFork;
    }
  });

  it('returns 404 when the source workflow does not exist', async () => {
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('POST', '/v1/workflows/missing-workflow/fork'),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Workflow "missing-workflow" not found' });
  });

  it('masks unexpected engine failures to a generic 500 (no raw message leak)', async () => {
    engine = createEngine();
    const originalFork = engine.fork.bind(engine);

    try {
      engine.fork = async () => {
        throw new Error('unexpected fork failure');
      };

      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows/workflow-123/fork'),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
      expect(response.headers.get('Content-Type')).toContain('application/json');
    } finally {
      engine.fork = originalFork;
    }
  });
});
