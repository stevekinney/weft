/**
 * `weft.workflows.list` operation + REST binding — behavior tests.
 */

import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { listWorkflowsOperation, listWorkflowsRestBinding } from './list-workflows.ts';
import { waitForWorkflowStatus } from './operation-test-helpers.ts';

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });
  engine.register('hold', async function* (ctx: WorkflowContext) {
    return yield* ctx.waitForSignal<string>('release');
  });
  return engine;
}

const registry = createOperationRegistry([listWorkflowsOperation]);
const bindings = [listWorkflowsRestBinding];

describe('weft.workflows.list', () => {
  it('returns the paginated workflow list on the happy path', async () => {
    const engine = createEngine();

    const runningHandle = await engine.start(
      'hold',
      { scope: 'running' },
      { id: 'running-workflow', tags: ['alpha'] },
    );
    await waitForWorkflowStatus(engine, runningHandle.id, 'running');

    const completedHandle = await engine.start(
      'echo',
      { scope: 'completed' },
      { id: 'completed-workflow', tags: ['beta'] },
    );
    await completedHandle.result();

    await engine.setAttributes(runningHandle.id, {
      active: true,
      priority: 'high',
      score: 5,
    });
    await engine.setAttributes(completedHandle.id, {
      active: false,
      priority: 'low',
      score: 1,
    });

    const request = new Request(
      'http://localhost/v1/workflows?status=running&type=hold&tag=alpha&attr.priority=high&attr.active=true&attr.score.gte=5&limit=2.9&offset=0',
      { method: 'GET' },
    );
    const response = await handleRequest(request, engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });

    const expected = await engine.list({
      status: 'running',
      type: 'hold',
      tags: ['alpha'],
      attributes: [
        { key: 'priority', value: 'high' },
        { key: 'active', value: true },
        { key: 'score', gte: 5 },
      ],
      limit: 2,
      offset: 0,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual(expected);
  });

  it('returns 400 when query tags are invalid (validation runs in invoke for parity across transports)', async () => {
    // Validation moved from `extractInput` to `invoke` so every
    // transport (REST, JSON-RPC HTTP/WS/stdio) hits the same check.
    // The error message now references the operation field name
    // (`tags`) rather than the REST query-parameter name — REST and
    // JSON-RPC clients see consistent error text.
    const engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows?tag=', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('empty tags');
  });

  it('maps EngineFailure faults to the legacy 500 response body', async () => {
    const engine = createEngine();
    const failingOperation = {
      ...listWorkflowsOperation,
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
      new Request('http://localhost/v1/workflows', { method: 'GET' }),
      engine,
      {
        operationRegistry: failingRegistry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});
