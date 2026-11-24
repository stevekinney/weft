/**
 * COR-1608: an event a displaced run emits late must not reach its same-id
 * `start-new` replacement.
 *
 * Weft events name their run only by `workflowId`. The server keeps remote
 * task ledgers by operation id across a workflow purge, so a delayed duplicate
 * result for the old run records a delivery and dispatches
 * `task:result-delivery` after the replacement is running. Before the fence
 * that event reached the replacement's handle iterator, every engine listener,
 * and the replacement's watch channel as if the replacement had emitted it.
 * The recorder now tags the event with the ledger record's execution token,
 * and `Engine.dispatchEvent` drops a tagged event whose token is no longer the
 * id's current generation.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { Engine } from '../../core/engine.ts';
import type { WorkflowHandle } from '../../core/engine/handles.ts';
import { nextSignalWaiting } from '../../core/engine/signal-wait-tracking.test-support.ts';
import { TaskResultDeliveryEvent } from '../../core/events.ts';
import { waitForParityCondition as waitFor } from '../../core/parity/real-timer-wait.test-support.ts';
import { workflow, type WorkflowContext } from '../../core/types.ts';
import { leasedFixture, putLedgerRecord } from '../operations/get-task-detail.test-support.ts';
import { wireEventBroadcasting } from './event-broadcasting.ts';
import { recordTaskResultDelivery } from './task-result-delivery-recorder.ts';

const waitThenFinish = workflow({ name: 'wait-then-finish' }).execute(async function* (
  ctx: WorkflowContext,
) {
  return yield* ctx.waitForSignal<string>('finish');
});

const WORKFLOW_ID = 'superseded-generation-1';

async function executionTokenOf(engine: Engine): Promise<string> {
  const state = await engine.get(WORKFLOW_ID);
  const token = state?.workflowExecutionToken;
  if (token === undefined) throw new Error(`Expected an execution token for ${WORKFLOW_ID}`);
  return token;
}

/**
 * Start a run under {@link WORKFLOW_ID}, finish it, and start its `start-new`
 * replacement. Resolves once the replacement is waiting, with both runs'
 * execution tokens and the replacement's handle.
 */
async function replaceFinishedRun(engine: Engine): Promise<{
  oldToken: string;
  newToken: string;
  replacement: WorkflowHandle;
}> {
  const original = await engine.start('wait-then-finish', null, { id: WORKFLOW_ID });
  await nextSignalWaiting(engine, WORKFLOW_ID, 'finish');
  const oldToken = await executionTokenOf(engine);
  await engine.signal(WORKFLOW_ID, 'finish', 'first');
  expect(await original.result()).toBe('first');

  const replacement = await engine.start('wait-then-finish', null, {
    id: WORKFLOW_ID,
    onTerminalConflict: 'start-new',
  });
  await nextSignalWaiting(engine, WORKFLOW_ID, 'finish');
  const newToken = await executionTokenOf(engine);
  expect(newToken).not.toBe(oldToken);
  return { oldToken, newToken, replacement };
}

/**
 * Record a rejected late result for `operationId`, whose ledger record
 * belongs to the run holding `workflowExecutionToken`, through the server's
 * real recorder, which dispatches `task:result-delivery` on the engine.
 */
async function deliverLateResult(
  engine: Engine,
  storage: MemoryStorage,
  operationId: string,
  workflowExecutionToken: string,
): Promise<void> {
  await putLedgerRecord(
    storage,
    leasedFixture({ operationId, workflowId: WORKFLOW_ID, workflowExecutionToken }),
  );
  await recordTaskResultDelivery(
    { engine, port: 0 },
    {
      operationId,
      attemptToken: 'attempt-token',
      transport: 'webSocket',
      workerId: 'worker-session-1',
      submittedStatus: 'completed',
    },
    { outcome: 'rejected', rejectionCode: 'stale-attempt', reason: 'stale attempt' },
  );
}

function operationIdsOf(events: readonly Event[]): string[] {
  return events
    .filter((event) => event instanceof TaskResultDeliveryEvent)
    .map((event) => event.operationId);
}

function iterateHandle(handle: WorkflowHandle): { events: Event[]; done: Promise<void> } {
  const events: Event[] = [];
  const done = (async () => {
    for await (const event of handle) events.push(event);
  })();
  return { events, done };
}

describe('events from a superseded execution generation', () => {
  it('reach neither the replacement handle, engine listeners, nor the watch channel', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    engine.register(waitThenFinish);
    const published: string[] = [];
    const broadcasting = wireEventBroadcasting(engine, {} as never, {
      publishWatchMessage: (workflowId, _sequence, message) => {
        if (workflowId === WORKFLOW_ID) published.push(message);
      },
    });
    const { oldToken, newToken, replacement } = await replaceFinishedRun(engine);

    const engineEvents: Event[] = [];
    engine.addEventListener(TaskResultDeliveryEvent.type, (event) => engineEvents.push(event));
    const iteration = iterateHandle(replacement);
    await deliverLateResult(engine, storage, 'stale-generation', oldToken);
    await deliverLateResult(engine, storage, 'current-generation', newToken);
    // Watch publishing is serialized per workflow, so once the later delivery
    // is published the earlier one has been published or dropped.
    await waitFor(async () => published.some((message) => message.includes('current-generation')), {
      label: 'current-generation delivery published',
    });
    await engine.signal(WORKFLOW_ID, 'finish', 'second');
    expect(await replacement.result()).toBe('second');
    await iteration.done;
    broadcasting.dispose();

    expect(operationIdsOf(engineEvents)).toEqual(['current-generation']);
    expect(operationIdsOf(iteration.events)).toEqual(['current-generation']);
    const watched = published
      .map((message) => JSON.parse(message) as { type: string; data: { operationId?: string } })
      .filter((message) => message.type === TaskResultDeliveryEvent.type)
      .map((message) => message.data.operationId);
    expect(watched).toEqual(['current-generation']);
  });

  it('still delivers an event no emitter tagged with a generation', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(waitThenFinish);
    const { replacement } = await replaceFinishedRun(engine);

    const engineEvents: Event[] = [];
    engine.addEventListener(TaskResultDeliveryEvent.type, (event) => engineEvents.push(event));
    const iteration = iterateHandle(replacement);
    engine.dispatchEvent(
      new TaskResultDeliveryEvent({
        operationId: 'untagged',
        workflowId: WORKFLOW_ID,
        activityName: 'charge',
        queue: 'default',
        transport: 'webSocket',
        attemptTokenDigest: 'digest',
        outcome: 'rejected',
        rejectionCode: 'stale-attempt',
      }),
    );
    await engine.signal(WORKFLOW_ID, 'finish', 'second');
    await iteration.done;

    expect(operationIdsOf(engineEvents)).toEqual(['untagged']);
    expect(operationIdsOf(iteration.events)).toEqual(['untagged']);
  });
});
