/**
 * COR-65 acceptance criteria: `engine.claimHolder(workflowId)` — a public,
 * cross-process read of per-workflow claim liveness under `ownership:
 * 'workflow-lease'` — proven against TWO REAL `Engine.create()` instances
 * sharing ONE `MemoryStorage`, mirroring the harness established in
 * `workflow-claim-deployment-scenarios.test.ts` (own mutable `now` closure
 * per engine, `backgroundTasks: 'manual'`, no real sleeps). A single-engine
 * test would not exercise the actual point of this method — that a SECOND
 * process, with no in-memory tracking of the first process's claim, can
 * still observe it durably.
 *
 * Three distinct return shapes are pinned, since a consumer deciding
 * whether it is safe to prune another instance's state needs to know which
 * one it got, not just a single boolean:
 *  - `undefined` — no durable claim record at all: never claimed, or a live
 *    process just released it (`release`/terminal-completion DELETE the
 *    holder key outright, per `workflow-claim-transitions.ts`).
 *  - `{ heldByAnyProcess: false, heldByThisProcess: false }` — a record
 *    exists but is past `takeover`'s own grace-adjusted expiry judgment:
 *    stranded, not currently fenced, eligible for takeover.
 *  - `{ heldByAnyProcess: true, heldByThisProcess: <engineId match> }` — a
 *    live claim, matching exactly what a `takeover` attempt would treat as
 *    fenced right now.
 */
import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { Engine } from './index.ts';
import { WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER } from './workflow-claim-transitions.ts';

const activityRunCounts = new Map<string, number>();

function recordActivityRun(workflowId: string, label: string): void {
  const key = `${workflowId}:${label}`;
  activityRunCounts.set(key, (activityRunCounts.get(key) ?? 0) + 1);
}

function runCountFor(workflowId: string, label: string): number {
  return activityRunCounts.get(`${workflowId}:${label}`) ?? 0;
}

/** Parks on a signal so the claim stays held until the test explicitly releases it. */
const claimHolderWorkflow = workflow({ name: 'claim-holder-probe-workflow' }).execute(
  async function* (ctx: WorkflowContext) {
    yield* ctx.run(() => {
      recordActivityRun(ctx.workflowId, 'before');
    });
    yield* ctx.waitForSignal('go');
    return yield* ctx.run(() => {
      recordActivityRun(ctx.workflowId, 'after');
      return 'ran';
    });
  },
);

type ProbeWorkflows = { 'claim-holder-probe-workflow': typeof claimHolderWorkflow };
const workflows: ProbeWorkflows = { 'claim-holder-probe-workflow': claimHolderWorkflow };

const CLAIM_RENEW_INTERVAL_MS = 1_000;
const CLAIM_TTL_MS = 3_000;

function createProbeEngine(
  storage: MemoryStorage,
  getNow: () => number,
  overrides: Partial<{ startScheduler: boolean; recover: boolean }> = {},
) {
  return Engine.create({
    storage,
    workflows,
    ownership: 'workflow-lease',
    getNow,
    workflowClaimTtl: `${CLAIM_TTL_MS}ms`,
    workflowClaimRenewInterval: `${CLAIM_RENEW_INTERVAL_MS}ms`,
    backgroundTasks: 'manual',
    ...overrides,
  });
}

/** Mirrors `startParkedWorkflow` in the deployment-scenarios file: starts, then waits for the durable park. */
async function startParkedWorkflow(
  engine: { start: Engine<ProbeWorkflows, object>['start'] },
  storage: MemoryStorage,
  workflowId: string,
): Promise<void> {
  await engine.start('claim-holder-probe-workflow', null, { id: workflowId });
  const createTimeCheckpointBytes = await storage.get(KEYS.checkpoint(workflowId));
  const createTimeCheckpointLength = createTimeCheckpointBytes?.length ?? 0;
  await waitForCondition(() => runCountFor(workflowId, 'before') === 1, {
    label: `"before" step for "${workflowId}"`,
  });
  await waitForCondition(
    async () => {
      const bytes = await storage.get(KEYS.checkpoint(workflowId));
      return (bytes?.length ?? 0) > createTimeCheckpointLength;
    },
    { label: `parked checkpoint for "${workflowId}"` },
  );
}

describe('COR-65: engine.claimHolder (two real engines, one store)', () => {
  it('reports undefined for a workflow id with no claim record at all', async () => {
    const storage = new MemoryStorage();
    const engine = await createProbeEngine(storage, () => 5_000_000);

    await expect(engine.claimHolder('never-claimed')).resolves.toBeUndefined();

    await engine[Symbol.asyncDispose]();
  });

  it('reflects a claim held by a SECOND engine instance over the same durable storage, then reports unheld after release', async () => {
    const storage = new MemoryStorage();
    let nowA = 6_000_000;
    const engineA = await createProbeEngine(storage, () => nowA);

    const id = 'cross-process-1';
    await startParkedWorkflow(engineA, storage, id);

    // The holder (engineA) sees itself as the live holder.
    await expect(engineA.claimHolder(id)).resolves.toEqual({
      heldByThisProcess: true,
      heldByAnyProcess: true,
    });

    // A SECOND engine, sharing only the durable store — no in-memory tracking
    // of engineA's claim at all — reads the SAME durable state and sees it as
    // held by "any process", but explicitly NOT by itself. This is the actual
    // cross-process visibility COR-65 exists to provide.
    let nowB = nowA; // same instant — well within the live TTL.
    const engineB = await createProbeEngine(storage, () => nowB, { recover: false });
    await expect(engineB.claimHolder(id)).resolves.toEqual({
      heldByThisProcess: false,
      heldByAnyProcess: true,
    });

    // Drive the workflow to completion on its true owner, which releases the
    // claim (DELETEs the holder key) as part of terminal cleanup.
    await engineA.getHandle(id)?.signal('go');
    const result = await engineA.getHandle(id)?.result();
    expect(result).toBe('ran');
    expect(runCountFor(id, 'after')).toBe(1);

    // Both engines — the former holder and the never-holding second engine —
    // now read the SAME "no record" shape from the same durable key.
    await expect(engineA.claimHolder(id)).resolves.toBeUndefined();
    await expect(engineB.claimHolder(id)).resolves.toBeUndefined();

    await engineA[Symbol.asyncDispose]();
    await engineB[Symbol.asyncDispose]();
  });

  it('reports heldByAnyProcess: false for a stranded (expired, not yet reclaimed) claim, without itself taking over', async () => {
    const storage = new MemoryStorage();
    let nowA = 7_000_000;
    const engineA = await createProbeEngine(storage, () => nowA, {
      startScheduler: false, // engineA is abandoned below; leak no real timer.
    });

    const id = 'stranded-1';
    await startParkedWorkflow(engineA, storage, id);
    const holderBefore = await storage.get(KEYS.workflowOwnerHolder(id));
    expect(holderBefore).not.toBeNull();

    // CRASH: drop the reference. No dispose, no release, no further renewal.

    // A second engine boots WELL PAST the grace-adjusted expiry deadline —
    // manual clock advance, no real delay — but never calls takeover/resume.
    let nowB =
      nowA + CLAIM_TTL_MS + WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER * CLAIM_RENEW_INTERVAL_MS + 1;
    const engineB = await createProbeEngine(storage, () => nowB, { recover: false });

    await expect(engineB.claimHolder(id)).resolves.toEqual({
      heldByThisProcess: false,
      heldByAnyProcess: false,
    });

    // The read did not mutate anything: the durable holder record is
    // untouched (still the original engine, still epoch 1) — a claimHolder
    // read is not itself a takeover.
    const holderAfter = await storage.get(KEYS.workflowOwnerHolder(id));
    expect(holderAfter).not.toBeNull();
    expect(holderAfter).toEqual(holderBefore);

    await engineB[Symbol.asyncDispose]();
  });
});
