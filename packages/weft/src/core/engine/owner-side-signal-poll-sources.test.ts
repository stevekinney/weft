/**
 * The engine's sources for the owner-side signal poll (`ownership: 'workflow-lease'`): which
 * parked workflows it lists as waiting on a signal, and which live signal waiters it lists.
 *
 * A parked workflow whose wait the engine has no timeline record of names no signal to poll for,
 * and a workflow racing two signal waits has two live waiters under one id. A poll pass over both
 * must wake neither, and must leave them waiting for their real wake-ups.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { waitForCondition } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { workflow, type WorkflowContext } from '../types.ts';
import { ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING, Engine } from './index.ts';
import { getInternals } from './internals.ts';

const parkedWorkflow = workflow({ name: 'poll-sources-parked' }).execute(async function* (
  ctx: WorkflowContext,
) {
  return yield* ctx.waitForSignal<string>('go');
});

const racingWorkflow = workflow({ name: 'poll-sources-racer' }).execute(async function* (
  ctx: WorkflowContext,
) {
  return yield* ctx.race([ctx.waitForSignal<string>('left'), ctx.waitForSignal<string>('right')]);
});

describe('owner-side signal poll sources', () => {
  it('polls past a parked workflow with no recorded wait and a workflow racing two signal waits, waking neither', async () => {
    using storage = new MemoryStorage();
    await using engine = await Engine.create({
      storage,
      workflows: { 'poll-sources-parked': parkedWorkflow, 'poll-sources-racer': racingWorkflow },
      ownership: 'workflow-lease',
      backgroundTasks: 'manual',
      workflowClaimTtl: 5_000,
      workflowClaimRenewInterval: 1_000,
      recover: false,
    });
    const internals = getInternals(engine);

    const parked = await engine.start('poll-sources-parked', null, { id: 'parked-1' });
    await engine[ENGINE_WAIT_FOR_PARKED_WORKFLOW_FOR_TESTING]('parked-1');
    const recordedWait = internals.pendingTimelineEntries.get('parked-1');
    if (recordedWait === undefined) throw new Error('A parked workflow records its wait.');
    internals.pendingTimelineEntries.delete('parked-1');
    const racer = await engine.start('poll-sources-racer', null, { id: 'racer-1' });
    await waitForCondition(
      () => {
        const waiterKeys = internals.signalWaitersByWorkflow.get('racer-1');
        return typeof waiterKeys === 'object' && waiterKeys.size === 2;
      },
      { label: 'both race branches registered a live signal waiter' },
    );

    await engine.runMaintenance();
    internals.pendingTimelineEntries.set('parked-1', recordedWait);

    // The pass found nothing buffered, so both still wait for their signals.
    await engine.signal('racer-1', 'right', 'from-right');
    expect(await racer.result()).toBe('from-right');
    await engine.signal('parked-1', 'go', 'from-go');
    expect(await parked.result()).toBe('from-go');
  });
});
