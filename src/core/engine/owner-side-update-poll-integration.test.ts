/**
 * End-to-end coverage for `index.ts`'s `#buildOwnerSideUpdatePollTarget`
 * wiring (WFT-79): a coordinated update submitted to a NON-owning engine must
 * still be delivered once the true owner's `runMaintenance()` runs the
 * owner-side update poll — without ever relying on the submitting engine's
 * own `setTimeout(0)` drain, which has no local context/waiter for a
 * workflow it does not own.
 *
 * Two real `Engine.create()` instances share one `MemoryStorage`, per the
 * pattern in `workflow-claim-deployment-scenarios.test.ts`: `backgroundTasks:
 * 'manual'` so nothing but the explicit `runMaintenance()` call below can
 * drain the update, and `startScheduler: false` on the never-driven engine so
 * it leaks no real timer into later tests.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { Engine } from './index.ts';

const receivedByWorkflowId = new Map<string, unknown[]>();

const updateAwareWorkflow = workflow({ name: 'owner-side-update-poll-workflow' }).execute(
  async function* (ctx: WorkflowContext) {
    ctx.onUpdate('ping', (payload) => {
      const received = receivedByWorkflowId.get(ctx.workflowId) ?? [];
      received.push(payload);
      receivedByWorkflowId.set(ctx.workflowId, received);
      return 'pong';
    });
    // Parks indefinitely on something OTHER than the update itself, so the
    // only thing that can advance this workflow is the update handler above
    // running via the owner-side poll — never a coincidental drive from
    // something else.
    yield* ctx.waitForSignal('never-sent');
    return 'unreachable';
  },
);

type SharedWorkflows = { 'owner-side-update-poll-workflow': typeof updateAwareWorkflow };
const workflows: SharedWorkflows = {
  'owner-side-update-poll-workflow': updateAwareWorkflow,
};

const CLAIM_RENEW_INTERVAL_MS = 1_000;
const CLAIM_TTL_MS = 3_000;

function createEngine(storage: MemoryStorage, getNow: () => number) {
  return Engine.create({
    storage,
    workflows,
    ownership: 'workflow-lease',
    getNow,
    workflowClaimTtl: `${CLAIM_TTL_MS}ms`,
    workflowClaimRenewInterval: `${CLAIM_RENEW_INTERVAL_MS}ms`,
    backgroundTasks: 'manual',
    startScheduler: false,
  });
}

describe('owner-side update poll (WFT-79): cross-engine coordinated update delivery', () => {
  it('drains a coordinated update submitted to a non-owning engine once the owner runs maintenance', async () => {
    const storage = new MemoryStorage();
    let now = 10_000_000;
    const owner = await createEngine(storage, () => now);
    const submitter = await createEngine(storage, () => now);

    const id = 'owner-side-update-poll-1';
    await owner.start('owner-side-update-poll-workflow', null, { id });
    await waitForCondition(() => owner.getHandle(id) !== undefined, {
      label: `workflow "${id}" started`,
    });

    // Submitted through a DIFFERENT engine than the one that owns/parked the
    // workflow. `submitCoordinatedUpdate` schedules its own local
    // `setTimeout(0)` drain on `submitter`, but `submitter` has no live
    // context or waiter for `id` — that drain is a no-op. Only `owner`'s
    // maintenance pass can actually deliver it.
    const updatePromise = submitter.submitCoordinatedUpdate(id, 'ping', 'hello');

    await owner.runMaintenance();

    const result = await updatePromise;
    expect(result.result).toBe('pong');
    expect(receivedByWorkflowId.get(id)).toEqual(['hello']);

    await owner[Symbol.asyncDispose]();
    await submitter[Symbol.asyncDispose]();
  });
});
