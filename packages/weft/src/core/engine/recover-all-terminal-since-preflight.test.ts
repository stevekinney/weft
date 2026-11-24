/**
 * `recoverAll()` snapshots every stored run in its preflight, then resumes the recoverable ones in
 * turn. Under `ownership: 'workflow-lease'` the engine's own claim-reclaim drive can take over a
 * lapsed claim in the batch and complete that run between the preflight and the batch's resume of
 * it. The resume then throws "status is completed", which nothing isolated, so the whole batch
 * rejected and no later entry's handle came back (COR-1593).
 *
 * A run that became terminal after the preflight because another drive owned it counts as
 * recovered elsewhere: the batch returns no handle for it, records no failure, and goes on.
 *
 * The batch is held with an earlier entry's `onRecoveredWorkflow` hook, which runs after that
 * entry's claim is acquired and before its generator starts, so the reclaim pass leaves that entry
 * alone and drives only the lapsed one. No wall clock: the claims lapse by the engines' own clocks.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { waitForCondition } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { KEYS } from '../../storage/keys.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import {
  CLAIM_RENEW_INTERVAL_MS,
  CLAIM_TTL_MS,
  countingWorkflow,
  EXPIRED_AFTER_MS,
  probeFor,
  strandWorkflow,
} from './reclaim-race.test-support.ts';
import { decodeWorkflowState } from './validation.ts';

// Scan order is key order, so the held entry comes first, the raced one second, a later one last.
const HELD_ID = 'a-held-entry';
const RACED_ID = 'b-raced-entry';
const LATER_ID = 'c-later-entry';
const START_NOW = 11_000_000;

function createEngine(storage: MemoryStorage, getNow: () => number) {
  return Engine.create({
    storage,
    workflows: { counted: countingWorkflow(storage) },
    ownership: 'workflow-lease',
    getNow,
    workflowClaimTtl: `${CLAIM_TTL_MS}ms`,
    workflowClaimRenewInterval: `${CLAIM_RENEW_INTERVAL_MS}ms`,
    backgroundTasks: 'manual',
    startScheduler: false,
    recover: false,
    inlineLaunchScheduling: 'manual',
    resolveWorkflowServices: async () => ({
      status: 'available',
      services: { owner: 'recovered' },
    }),
  });
}

async function statusOf(storage: MemoryStorage, workflowId: string): Promise<string | undefined> {
  const bytes = await storage.get(KEYS.workflow(workflowId));
  return bytes === null ? undefined : decodeWorkflowState(bytes).status;
}

describe('recoverAll() and a run the reclaim drive completed after the preflight', () => {
  it('counts that run as recovered elsewhere and returns every later handle', async () => {
    const storage = new MemoryStorage();
    const probe = probeFor(storage);

    // The held entry's owner released its claim on a graceful exit, so the batch can acquire it
    // itself; the raced entry's owner crashed, so its claim lapses and only the reclaim scan takes
    // it over (`recoverAll()` never takes over a held claim). A third owner left a delayed start
    // pending.
    await strandWorkflow(storage, () => START_NOW, HELD_ID, true);
    await strandWorkflow(storage, () => START_NOW, RACED_ID, false);
    const previousOwner = await createEngine(storage, () => START_NOW);
    await previousOwner.start('counted', null, { id: LATER_ID, startAt: START_NOW + 3_600_000 });

    const now = START_NOW + EXPIRED_AFTER_MS;
    await using engine = await createEngine(storage, () => now);
    const internals = getInternals(engine);

    // The batch's preflight sees all three; its resume of the first entry is held in the hook,
    // after that entry's claim is acquired, so the batch sits between preflight and the raced entry.
    const reachedHook = Promise.withResolvers<void>();
    const barrier = Promise.withResolvers<void>();
    const recovery = engine.recoverAll({
      onRecoveredWorkflow: async (info) => {
        if (info.workflowId !== HELD_ID) return;
        reachedHook.resolve();
        await barrier.promise;
      },
    });
    await reachedHook.promise;
    expect(await statusOf(storage, RACED_ID)).toBe('running');

    // The reclaim pass takes the raced entry's lapsed claim and drives it to completion.
    const pass = await internals.workflowClaimRenewalTask!.runOnce();
    expect(pass.reclaim).toMatchObject({ status: 'completed' });
    await engine.flushInlineLaunches();
    await waitForCondition(async () => (await statusOf(storage, RACED_ID)) === 'completed', {
      label: 'the reclaim drive completes the raced entry',
    });
    expect(await engine.getHandle(RACED_ID).result()).toBe('ran');

    barrier.resolve();
    const handles = await recovery;
    const recoveredIds = handles.map((handle) => handle.id);
    expect(recoveredIds).toContain(HELD_ID);
    expect(recoveredIds).toContain(LATER_ID);
    expect(recoveredIds).not.toContain(RACED_ID);

    await engine.flushInlineLaunches();
    expect(await engine.getHandle(HELD_ID).result()).toBe('ran');
    // The held entry ran once under the batch, the raced entry once under the reclaim.
    expect(probe.runs).toBe(2);
    expect(await statusOf(storage, LATER_ID)).toBe('pending');
  });
});

describe("recoverAll() and a run cancelled between the resume's two reads", () => {
  it('counts a run cancelled during its own recovery hook as ended, and returns every later handle', async () => {
    const storage = new MemoryStorage();
    const probe = probeFor(storage);
    await strandWorkflow(storage, () => START_NOW, HELD_ID, true);
    const previousOwner = await createEngine(storage, () => START_NOW);
    await previousOwner.start('counted', null, { id: LATER_ID, startAt: START_NOW + 3_600_000 });

    const now = START_NOW + EXPIRED_AFTER_MS;
    await using engine = await createEngine(storage, () => now);

    // The hook runs after the resume's first read saw `running`, so the cancel lands before the
    // serialized section's re-read (`resume-body.ts`), which is the second site that throws.
    const handles = await engine.recoverAll({
      onRecoveredWorkflow: async (info) => {
        if (info.workflowId !== HELD_ID) return;
        await engine.cancel(HELD_ID);
      },
    });
    await engine.flushInlineLaunches();

    expect(handles.map((handle) => handle.id)).toEqual([LATER_ID]);
    expect(await statusOf(storage, HELD_ID)).toBe('cancelled');
    expect(probe.runs).toBe(0);
  });
});
