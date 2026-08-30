/**
 * `weft.workflows.query` operation + REST binding — behavior tests.
 */

import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { waitForWorkflowStatus } from './operation-test-helpers.test-support.ts';
import {
  queryWorkflowOperation,
  queryWorkflowRestBinding,
  queryWorkflowWithInputRestBinding,
} from './query-workflow.ts';

const queryableWorkflow = workflow({ name: 'queryable' }).execute(async function* (
  ctx: WorkflowContext,
) {
  const context = ctx;
  context.expose({ counter: () => 42 });
  context.onQuery('echoInput', (input) => input);
  yield* context.waitForSignal('done');
  return 42;
});

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register(queryableWorkflow);
  return engine;
}

const registry = createOperationRegistry([queryWorkflowOperation]);
const bindings = [queryWorkflowRestBinding, queryWorkflowWithInputRestBinding];

describe('weft.workflows.query', () => {
  it('returns the query result on the happy path', async () => {
    const engine = createEngine();
    const handle = await engine.start('queryable', null, { id: 'query-workflow-success' });
    await waitForWorkflowStatus(engine, handle.id, 'running');

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/query/counter`, {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ result: 42 });
  });

  it('passes POST query input to workflow query handlers', async () => {
    const engine = createEngine();
    const handle = await engine.start('queryable', null, { id: 'query-workflow-input' });
    await waitForWorkflowStatus(engine, handle.id, 'running');

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/query/echoInput`, {
        method: 'POST',
        body: JSON.stringify({ input: { detail: true } }),
        headers: { 'Content-Type': 'application/json' },
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ result: { detail: true } });
  });

  it('passes undefined input for POST query requests with an empty body', async () => {
    const engine = createEngine();
    try {
      const handle = await engine.start('queryable', null, { id: 'query-workflow-empty-input' });
      await waitForWorkflowStatus(engine, handle.id, 'running');

      const response = await handleRequest(
        new Request(`http://localhost/v1/workflows/${handle.id}/query/echoInput`, {
          method: 'POST',
        }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(await response.json()).toEqual({ result: null });
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('returns 400 for malformed POST query JSON', async () => {
    const engine = createEngine();
    const handle = await engine.start('queryable', null, { id: 'query-workflow-malformed-input' });
    await waitForWorkflowStatus(engine, handle.id, 'running');

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/query/echoInput`, {
        method: 'POST',
        body: '{"input":',
        headers: { 'Content-Type': 'application/json' },
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
  });

  it('returns 400 for non-object POST query JSON', async () => {
    const engine = createEngine();
    const handle = await engine.start('queryable', null, { id: 'query-workflow-array-input' });
    await waitForWorkflowStatus(engine, handle.id, 'running');

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/query/echoInput`, {
        method: 'POST',
        body: JSON.stringify([]),
        headers: { 'Content-Type': 'application/json' },
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'Request body must be a JSON object' });
  });

  it('returns 501 with the canonical error body when queries are not supported', async () => {
    const engine = createEngine();
    const originalQuery = engine.query.bind(engine);
    engine.query = async () => {
      throw new Error('query not supported for this workflow');
    };

    try {
      const response = await handleRequest(
        new Request('http://localhost/v1/workflows/wf-query/query/counter', { method: 'GET' }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(501);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(await response.json()).toEqual({
        error: 'query not supported for this workflow',
      });
    } finally {
      engine.query = originalQuery;
    }
  });

  it('returns null when the query accessor does not exist', async () => {
    const engine = createEngine();
    const handle = await engine.start('queryable', null, { id: 'query-workflow-null' });
    await waitForWorkflowStatus(engine, handle.id, 'running');

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/query/missing`, {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ result: null });
  });

  it('masks EngineFailure faults to a 500 with a generic error body', async () => {
    const engine = createEngine();
    const failingOperation = {
      ...queryWorkflowOperation,
      invoke: async () => {
        const fault: OperationFault = {
          code: 'EngineFailure',
          message: 'secret internal detail',
          data: {},
        };
        throw fault;
      },
    };
    const failingRegistry = createOperationRegistry([failingOperation]);

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/whatever/query/counter', { method: 'GET' }),
      engine,
      {
        operationRegistry: failingRegistry,
        restBindings: bindings,
      },
    );

    // `EngineFailure` is masked by the canonical `shapeRestFault` to a
    // generic "Internal server error" 500 so the raw engine message
    // never reaches REST clients.
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});
