/**
 * `weft.workflows.list` operation + REST binding — behavior tests.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { decode, encode } from '../../core/codec.ts';
import { Engine } from '../../core/engine.ts';
import type { WorkflowContext, WorkflowState } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import {
  listWorkflowsOperation,
  listWorkflowsRestBinding,
  type ListWorkflowsOutput,
} from './list-workflows.ts';
import { waitForWorkflowStatus } from './operation-test-helpers.test-support.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});
const holdWorkflow = workflow({ name: 'hold' }).execute(async function* (ctx: WorkflowContext) {
  return yield* ctx.waitForSignal<string>('release');
});
const crashWorkflow = workflow({ name: 'crash' }).execute(async function* () {
  throw new Error('workflow failure');
});

const createdEngines: Engine[] = [];

function createEngine(storage = new MemoryStorage()): Engine {
  const engine = new Engine({ storage });
  createdEngines.push(engine);
  engine.register(echoWorkflow);
  engine.register(holdWorkflow);
  engine.register(crashWorkflow);
  return engine;
}

// Reproduces a historically-persisted shape: a failed workflow whose state
// record carries no `failureCategory` while the value lives only in a
// separate attribute record. Exercises the read-side backfill path.
async function startFailedWorkflowWithSplitFailureCategory(
  engine: Engine,
  storage: MemoryStorage,
  id: string,
): Promise<void> {
  const handle = await engine.start('crash', null, { id });
  await expect(handle.result()).rejects.toThrow('workflow failure');

  const stateBytes = await storage.get(KEYS.workflow(id));
  expect(stateBytes).not.toBeNull();
  const state = decode(stateBytes!) as WorkflowState;
  state.failureCategory = null;
  await storage.put(KEYS.workflow(id), encode(state));
  await storage.put(KEYS.attribute(id), encode({ failureCategory: 'application' }));
}

const registry = createOperationRegistry([listWorkflowsOperation]);
const bindings = [listWorkflowsRestBinding];

function disposeCreatedEngines(): void {
  let disposeError: unknown;
  for (const engine of createdEngines.splice(0)) {
    try {
      engine[Symbol.dispose]();
    } catch (error) {
      disposeError ??= error;
    }
  }
  if (disposeError !== undefined) throw disposeError;
}

describe('weft.workflows.list', () => {
  afterEach(() => {
    disposeCreatedEngines();
  });

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

  it('filters workflow history by originating schedule over REST', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    const scheduled = await engine.start('echo', null, { id: 'scheduled-run' });
    const unrelated = await engine.start('echo', null, { id: 'unrelated-run' });
    await Promise.all([scheduled.result(), unrelated.result()]);
    const metadata = encode({ id: 'daily-report', occurrence: 1_000 });
    await storage.put(KEYS.scheduleRunLink(scheduled.id), metadata);
    await storage.put(KEYS.scheduleRunBySchedule('daily-report', scheduled.id), new Uint8Array(0));

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows?schedule_id=daily-report', { method: 'GET' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ListWorkflowsOutput;
    expect(body.items.map((item) => item.id)).toEqual(['scheduled-run']);
  });

  it('includes failureCategory from search attributes only when requested over REST', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);
    await startFailedWorkflowWithSplitFailureCategory(
      engine,
      storage,
      'failed-with-split-failure-category',
    );

    const defaultResponse = await handleRequest(
      new Request('http://localhost/v1/workflows?status=failed', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(defaultResponse.status).toBe(200);
    const defaultBody = (await defaultResponse.json()) as ListWorkflowsOutput;
    expect(defaultBody.items).toHaveLength(1);
    expect(defaultBody.items[0]?.failureCategory).toBeUndefined();

    const includedResponse = await handleRequest(
      new Request('http://localhost/v1/workflows?status=failed&include=failureCategory', {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(includedResponse.status).toBe(200);
    const includedBody = (await includedResponse.json()) as ListWorkflowsOutput;
    expect(includedBody.items).toHaveLength(1);
    expect(includedBody.items[0]?.failureCategory).toBe('application');

    const repeatedIncludedResponse = await handleRequest(
      new Request(
        'http://localhost/v1/workflows?status=failed&include=failureCategory&include=failureCategory',
        { method: 'GET' },
      ),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(repeatedIncludedResponse.status).toBe(200);
    const repeatedIncludedBody = (await repeatedIncludedResponse.json()) as ListWorkflowsOutput;
    expect(repeatedIncludedBody.items).toHaveLength(1);
    expect(repeatedIncludedBody.items[0]?.failureCategory).toBe('application');
  });

  it('returns 400 when include contains an unsupported field', async () => {
    const engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows?include=input', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid params',
      data: {
        issues: [
          {
            path: ['include'],
            message: 'include must be "failureCategory"',
            code: 'custom',
          },
        ],
      },
    });

    const repeatedResponse = await handleRequest(
      new Request('http://localhost/v1/workflows?include=failureCategory&include=input', {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(repeatedResponse.status).toBe(400);
    expect(await repeatedResponse.json()).toEqual({
      error: 'invalid params',
      data: {
        issues: [
          {
            path: ['include'],
            message: 'include must be "failureCategory"',
            code: 'custom',
          },
        ],
      },
    });
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

  it('masks EngineFailure faults to a 500 with a generic error body', async () => {
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
