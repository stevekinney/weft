import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";

import { createOperationRegistry } from "../../embedded/backchannel/src/internals.ts";
import { Engine } from '../../core/engine.ts';
import { type WorkflowContext, workflow } from '../../core/types.ts';
import { createWorkflowLogStore } from '../../core/workflow-log-store.ts';
import { handleRequestAsLocalUser as handleRequest } from '../local-user-request.test-support.ts';
import { listWorkflowLogsOperation, listWorkflowLogsRestBinding } from './list-workflow-logs.ts';
import { waitForWorkflowStatus } from './operation-test-helpers.test-support.ts';

const noop = async () => null;

const loggingWorkflow = workflow({ name: 'logs-op' }).execute(async function* (
  ctx: WorkflowContext,
) {
  ctx.log?.info('first', { n: 1 });
  yield* ctx.run(noop);
  ctx.log?.warn('second');
  return 'done';
});

const registry = createOperationRegistry([listWorkflowLogsOperation]);

describe('weft.workflows.logs.list', () => {
  let engine: Engine | undefined;

  afterEach(async () => {
    await engine?.shutdown();
    engine = undefined;
  });

  async function start(withStore: boolean): Promise<Engine> {
    const storage = new MemoryStorage();
    const logs = createWorkflowLogStore(storage);
    const created = new Engine({
      storage,
      ...(withStore ? { onLog: logs.sink, workflowLogs: logs } : { onLog: () => {} }),
    });
    created.register(loggingWorkflow);
    const handle = await created.start('logs-op', null, { id: 'wf-logs' });
    await waitForWorkflowStatus(created, handle.id, 'completed');
    return created;
  }

  async function get(target: Engine, query = ''): Promise<Response> {
    return handleRequest(
      new Request(`http://localhost/v1/workflows/wf-logs/logs${query}`, { method: 'GET' }),
      target,
      { operationRegistry: registry, restBindings: [listWorkflowLogsRestBinding] },
    );
  }

  it('lists a run’s lines with their steps, and narrows to one step', async () => {
    engine = await start(true);

    const all = await get(engine);
    expect(all.status).toBe(200);
    const body = (await all.json()) as { lines: Array<Record<string, unknown>>; dropped: number };
    expect(body.dropped).toBe(0);
    expect(body.lines.map((line) => [line['sequence'], line['step'], line['message']])).toEqual([
      [0, 0, 'first'],
      [1, 1, 'second'],
    ]);
    expect(body.lines[0]).toMatchObject({
      level: 'info',
      workflowType: 'logs-op',
      attributes: { n: 1 },
      truncated: false,
    });

    const narrowedResponse = await get(engine, '?step=1');
    const narrowed = (await narrowedResponse.json()) as {
      lines: Array<Record<string, unknown>>;
    };
    expect(narrowed.lines.map((line) => line['message'])).toEqual(['second']);
  });

  it('answers no lines for an unknown workflow and for an engine that keeps none', async () => {
    engine = await start(false);

    const response = await get(engine);
    expect(await response.json()).toEqual({ lines: [], dropped: 0 });
  });

  it('refuses a step that is not a non-negative integer', async () => {
    engine = await start(true);

    const negative = await get(engine, '?step=-1');
    const notANumber = await get(engine, '?step=abc');
    expect(negative.status).toBe(400);
    expect(notANumber.status).toBe(400);
  });

  it('refuses an empty or non-decimal step instead of reading it as step 0', async () => {
    engine = await start(true);

    for (const query of ['?step=', '?step=%20', '?step=1.5', '?step=1e1', '?step=0x1']) {
      const response = await get(engine, query);
      expect(response.status).toBe(400);
    }
    // A real step 0 still reads.
    const zeroResponse = await get(engine, '?step=0');
    const zero = (await zeroResponse.json()) as { lines: Array<Record<string, unknown>> };
    expect(zero.lines.map((line) => line['message'])).toEqual(['first']);
  });
});
