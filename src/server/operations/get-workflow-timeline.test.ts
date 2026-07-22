import { afterEach, describe, expect, it } from 'bun:test';

import { decode } from '../../core/codec.ts';
import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import {
  getWorkflowTimelineOperation,
  getWorkflowTimelineRestBinding,
} from './get-workflow-timeline.ts';
import { waitForWorkflowStatus } from './operation-test-helpers.test-support.ts';

const twoStepsWorkflow = workflow({ name: 'two-steps' }).execute(async function* (
  ctx: WorkflowContext,
) {
  yield* ctx.run(noop);
  return yield* ctx.run(noop);
});

const coordinatorWorkflow = workflow({ name: 'timeline-coordinator' })
  .activities({ first: async () => 'first', second: async () => 'second' })
  .execute(async function* (ctx: WorkflowContext) {
    return yield* ctx.all([ctx.run('first'), ctx.run('second')]);
  });

const noop = async () => null;

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage(), checkpointHistory: 10 });
  engine.register(twoStepsWorkflow);
  engine.register(coordinatorWorkflow);
  return engine;
}

const registry = createOperationRegistry([getWorkflowTimelineOperation]);

describe('weft.workflows.timeline.get', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('returns the workflow timeline on the happy path', async () => {
    engine = createEngine();
    const handle = await engine.start('two-steps', null, { id: 'wf-timeline-success' });
    await waitForWorkflowStatus(engine, handle.id, 'completed');
    const expected = await engine.getTimeline(handle.id);

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/timeline`, { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getWorkflowTimelineRestBinding],
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual(expected);
  });

  it('returns msgpack when the Accept header requests it', async () => {
    engine = createEngine();
    const handle = await engine.start('two-steps', null, { id: 'wf-timeline-msgpack' });
    await waitForWorkflowStatus(engine, handle.id, 'completed');
    const expected = await engine.getTimeline(handle.id);

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/timeline`, {
        method: 'GET',
        headers: { Accept: 'application/msgpack' },
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getWorkflowTimelineRestBinding],
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/msgpack');
    const decoded = decode(new Uint8Array(await response.arrayBuffer()));
    expect(decoded).toEqual(expected);
  });

  it('returns coordinator detail unchanged over REST', async () => {
    engine = createEngine();
    const handle = await engine.start('timeline-coordinator', null, {
      id: 'wf-timeline-coordinator',
    });
    await waitForWorkflowStatus(engine, handle.id, 'completed');

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/timeline`, { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getWorkflowTimelineRestBinding],
      },
    );

    expect(response.status).toBe(200);
    const timeline = (await response.json()) as Array<{ branches?: unknown[] }>;
    expect(timeline[0]?.branches).toEqual([
      expect.objectContaining({ index: 0, operationLabel: 'first', outcome: 'fulfilled' }),
      expect.objectContaining({ index: 1, operationLabel: 'second', outcome: 'fulfilled' }),
    ]);
  });

  it('returns 404 with the canonical error body when the workflow does not exist', async () => {
    engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/does-not-exist/timeline', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getWorkflowTimelineRestBinding],
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'Workflow "does-not-exist" not found',
      data: { resource: 'workflow', identifier: 'does-not-exist' },
    });
  });

  it('masks EngineFailure faults to a 500 with a generic error body', async () => {
    engine = createEngine();

    const failingOperation = {
      ...getWorkflowTimelineOperation,
      invoke: async () => {
        const fault: OperationFault = {
          code: 'EngineFailure',
          message: 'secret internal detail',
          data: {},
        };
        throw fault;
      },
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/wf-timeline-success/timeline', {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: createOperationRegistry([failingOperation]),
        restBindings: [getWorkflowTimelineRestBinding],
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});
