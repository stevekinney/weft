/**
 * `weft.workflows.purge` operation + REST binding — behavior tests.
 */

import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { purgeWorkflowsOperation, purgeWorkflowsRestBinding } from './purge-workflows.ts';

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

function request(body?: unknown): Request {
  return new Request('http://localhost/v1/workflows/purge', {
    method: 'POST',
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
}

const registry = createOperationRegistry([purgeWorkflowsOperation]);
const bindings = [purgeWorkflowsRestBinding];

describe('weft.workflows.purge', () => {
  it('purges terminal workflows that match the provided filter', async () => {
    const engine = createEngine();

    const firstHandle = await engine.start('echo', 'first', { id: 'purge-selected-a' });
    const secondHandle = await engine.start('echo', 'second', { id: 'purge-selected-b' });
    const otherHandle = await engine.start('echo', 'other', { id: 'purge-other' });
    await firstHandle.result();
    await secondHandle.result();
    await otherHandle.result();

    await engine.setAttributes('purge-selected-a', { bucket: 'target' });
    await engine.setAttributes('purge-selected-b', { bucket: 'target' });
    await engine.setAttributes('purge-other', { bucket: 'other' });

    const response = await handleRequest(
      request({
        filter: {
          status: 'completed',
          attributes: [{ key: 'bucket', value: 'target' }],
          offset: 1,
          limit: 1,
        },
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ deleted: 1 });
    expect(await engine.get('purge-selected-a')).not.toBeNull();
    expect(await engine.get('purge-selected-b')).toBeNull();
    expect(await engine.get('purge-other')).not.toBeNull();
  });

  it('treats an omitted filter as unfiltered', async () => {
    const engine = createEngine();

    const handle = await engine.start('echo', 'delete-me', { id: 'purge-unfiltered' });
    await handle.result();

    const response = await handleRequest(request({ note: 'ignored' }), engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ deleted: 1 });
    expect(await engine.get('purge-unfiltered')).toBeNull();
  });

  it('returns 400 for invalid filter bodies', async () => {
    const engine = createEngine();

    let response = await handleRequest(
      request({
        filter: {
          attributes: [{ key: '' }],
        },
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "filter.attributes[0].key" must be a non-empty string',
    });

    response = await handleRequest(request(['not-an-object']), engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "filter" must be an object',
    });
  });

  it('maps EngineFailure faults to a 500 response', async () => {
    const engine = createEngine();
    const failingOperation = {
      ...purgeWorkflowsOperation,
      invoke: async () => {
        const fault: OperationFault = {
          code: 'EngineFailure',
          message: 'purge failed',
          data: {},
        };
        throw fault;
      },
    };
    const failingRegistry = createOperationRegistry([failingOperation]);

    const response = await handleRequest(request({}), engine, {
      operationRegistry: failingRegistry,
      restBindings: bindings,
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});
