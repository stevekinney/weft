/**
 * WFT-152: two SEPARATE `Engine` instances racing the same explicit start id
 * against ONE shared store, under `ownership: 'none'` and with no
 * `idempotencyKey`.
 *
 * Before the fix, both starts committed blind. The create batch took
 * `persistStartBatch`'s unconditioned path (no preconditions, no claim fold), so
 * the second engine's record simply overwrote the first's. Neither `start()`
 * rejected — the visible failure landed two steps later:
 *
 *  1. Both engines launched a generator for the same id. The effect log lives in
 *     the shared store, so the second generator REPLAYED the first's committed
 *     activity entry instead of re-executing it — one activity run, not two.
 *  2. Both reached `completeWorkflow()`. Whichever arrived first committed
 *     terminal state and called `notifyCompletionWaiters()`; the other found
 *     `state.status !== 'running'` and returned early, never notifying.
 *  3. That engine's `resultResolvers` waiter was orphaned. The cross-engine
 *     rescue poll in `handle-result.ts` returns immediately when
 *     `workflowClaimRegistry === null`, which is always the case under
 *     `ownership: 'none'` — so `handle.result()` never settled.
 *
 * The fix conditions the create batch on the exact bytes the duplicate-id read
 * observed, so the loser fails its compare-and-swap and raises
 * `WorkflowAlreadyExistsError` — the same error the in-engine `pendingStarts`
 * guard already raises for the identical collision.
 *
 * These tests assert on `start()` outcomes and the WINNER's `result()` only.
 * There is deliberately no `result()` call on the loser (it has no handle) and
 * no timeout anywhere: without the fix the rejection assertion fails outright
 * rather than hanging, so the regression is deterministic on every run.
 *
 * `recover: false` on both engines keeps boot-time recovery out of the race.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../../storage/memory.ts';
import { storageBackends } from '../../../testing/storage-backends.test-support.ts';
import { workflow, type WorkflowContext } from '../../types.ts';
import { WorkflowAlreadyExistsError } from '../errors.ts';
import { Engine } from '../index.ts';

/** Per-workflow-id activity execution counts; ids are unique per test. */
const activityRunCounts = new Map<string, number>();

const raceWorkflow = workflow({ name: 'duplicate-id-race' }).execute(async function* (
  ctx: WorkflowContext,
) {
  return yield* ctx.run(() => {
    activityRunCounts.set(ctx.workflowId, (activityRunCounts.get(ctx.workflowId) ?? 0) + 1);
    return 'ran';
  });
});

const workflows = { 'duplicate-id-race': raceWorkflow };

afterEach(() => {
  activityRunCounts.clear();
});

/**
 * The durable backends the ticket names (LMDB and SQLite) plus `MemoryStorage`.
 * Filtering the shared descriptor list rather than restating the factories keeps
 * this in step with the backends' own construction/cleanup contracts.
 */
const racedBackends = storageBackends.filter((backend) =>
  ['MemoryStorage', 'BunSQLiteStorage', 'LMDBStorage'].includes(backend.name),
);

describe('WFT-152: two engines racing the same explicit start id', () => {
  for (const backend of racedBackends) {
    it(`exactly one start wins and the loser fails fast on ${backend.name}`, async () => {
      const { storage, cleanup } = backend.factory();
      const workflowId = `duplicate-id-race-${crypto.randomUUID()}`;
      try {
        await using engineA = await Engine.create({ storage, workflows, recover: false });
        await using engineB = await Engine.create({ storage, workflows, recover: false });

        const outcomes = await Promise.allSettled([
          engineA.start('duplicate-id-race', null, { id: workflowId }),
          engineB.start('duplicate-id-race', null, { id: workflowId }),
        ]);

        const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
        const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        // The loser fails fast with the SAME typed error the single-engine
        // duplicate-id path raises — not a hang, and not a new error type.
        const { reason } = rejected[0] as PromiseRejectedResult;
        expect(reason).toBeInstanceOf(WorkflowAlreadyExistsError);
        expect((reason as WorkflowAlreadyExistsError).workflowId).toBe(workflowId);

        // The winner is unaffected by the losing attempt: it still completes and
        // its result settles. This is the half that used to hang.
        const winner = (
          fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof engineA.start>>>
        ).value;
        await expect(winner.result()).resolves.toBe('ran');

        // Assert on the activity's OWN side effect rather than a returned status:
        // a build that let both engines launch a generator and only diverged at
        // the checkpoint commit would still pass a status-only assertion.
        expect(activityRunCounts.get(workflowId)).toBe(1);
      } finally {
        await cleanup();
      }
    });
  }

  it('leaves exactly one durable run behind, owned by the winner', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'duplicate-id-race-single-record';
    await using engineA = await Engine.create({ storage, workflows, recover: false });
    await using engineB = await Engine.create({ storage, workflows, recover: false });

    const outcomes = await Promise.allSettled([
      engineA.start('duplicate-id-race', null, { id: workflowId }),
      engineB.start('duplicate-id-race', null, { id: workflowId }),
    ]);
    // Assert the loser was rejected BEFORE awaiting any result. Without the fix
    // both starts fulfil and `find` would hand back a handle whose waiter never
    // settles — this test would then fail by timing out instead of by assertion.
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    const winner = (
      fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof engineA.start>>>
    ).value;
    await winner.result();

    // The loser's create batch never committed, so the surviving record is the
    // winner's completed run rather than a half-written overwrite of it.
    const persisted = await engineA.get(workflowId);
    expect(persisted?.status).toBe('completed');
    expect(persisted?.result).toBe('ran');
  });

  it('a sequential duplicate id still fails on the pre-commit read, not the CAS', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'duplicate-id-race-sequential';
    await using engineA = await Engine.create({ storage, workflows, recover: false });
    await using engineB = await Engine.create({ storage, workflows, recover: false });

    const first = await engineA.start('duplicate-id-race', null, { id: workflowId });
    await first.result();

    // Once the first run is durable, the second engine's duplicate-id READ sees
    // it and throws before the batch is ever built. Same error either way — the
    // CAS only covers the window that read cannot.
    await expect(
      engineB.start('duplicate-id-race', null, { id: workflowId }),
    ).rejects.toBeInstanceOf(WorkflowAlreadyExistsError);
  });
});
