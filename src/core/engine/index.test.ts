/**
 * `Engine`'s own wiring for `ownership: 'workflow-lease'` (ADR 0002),
 * specifically the seams `src/core/engine/index.ts` builds and threads into
 * `bootstrapWorkflowLeaseOwnership` — `#buildOwnerSideSignalPollTarget`
 * (WFT-79 review finding 1) here. Claim acquire/renew/takeover/release
 * mechanics themselves are pinned in `workflow-claim-registry.test.ts`,
 * `ownership-bootstrap.test.ts`, and the two-engine deployment scenarios in
 * `workflow-claim-deployment-scenarios.test.ts`; this file is the narrower
 * "does index.ts actually wire the seam" layer, driven end to end through
 * two real `Engine.create()` instances sharing one `MemoryStorage`.
 */
import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';

/** Per-workflow-id "before"/"after" side-effect counts, mirroring `workflow-claim-deployment-scenarios.test.ts`'s pattern so a replay bug shows up as a wrong count, not just a wrong final result. */
const runCounts = new Map<string, number>();

function recordRun(workflowId: string, label: string): void {
  const key = `${workflowId}:${label}`;
  runCounts.set(key, (runCounts.get(key) ?? 0) + 1);
}

function countFor(workflowId: string, label: string): number {
  return runCounts.get(`${workflowId}:${label}`) ?? 0;
}

const signalPollWorkflow = workflow({ name: 'signal-poll-workflow' }).execute(async function* (
  ctx: WorkflowContext,
) {
  yield* ctx.run(() => {
    recordRun(ctx.workflowId, 'before');
  });
  const payload = yield* ctx.waitForSignal<string>('go');
  return yield* ctx.run(() => {
    recordRun(ctx.workflowId, 'after');
    return `received:${payload}`;
  });
});

type SignalPollWorkflows = { 'signal-poll-workflow': typeof signalPollWorkflow };
const workflows: SignalPollWorkflows = { 'signal-poll-workflow': signalPollWorkflow };

const liveWaiterWorkflow = workflow({ name: 'live-waiter-workflow' }).execute(async function* (
  ctx: WorkflowContext,
) {
  // Registering a query handler keeps this run's Context live across the wait,
  // so the wait registers in `signalWaiters` instead of taking the
  // checkpoint-parked path the sibling tests exercise. That is the population
  // `wakeSignalWaiter` serves.
  ctx.onQuery('ping', () => 'pong');
  // A race branch keeps its signal wait as a LIVE in-memory waiter rather than
  // taking the checkpoint-parked path, which is the population wakeSignalWaiter serves.
  const payload = yield* ctx.race([ctx.waitForSignal<string>('go'), ctx.sleep('1h')]);
  return yield* ctx.run(() => {
    recordRun(ctx.workflowId, 'after');
    return `live:${String(payload)}`;
  });
});

type LiveWaiterWorkflows = { 'live-waiter-workflow': typeof liveWaiterWorkflow };
const liveWaiterWorkflows: LiveWaiterWorkflows = { 'live-waiter-workflow': liveWaiterWorkflow };

const CLAIM_RENEW_INTERVAL_MS = 1_000;
const CLAIM_TTL_MS = 3_000;

function createSignalPollEngine(storage: MemoryStorage, getNow: () => number) {
  return Engine.create({
    storage,
    workflows,
    ownership: 'workflow-lease',
    getNow,
    workflowClaimTtl: `${CLAIM_TTL_MS}ms`,
    workflowClaimRenewInterval: `${CLAIM_RENEW_INTERVAL_MS}ms`,
    backgroundTasks: 'manual',
  });
}

/** Starts `workflowId` on `engine` and waits until it has durably parked on `waitForSignal('go')`. */
async function startParkedWorkflow(
  engine: { start: Engine<SignalPollWorkflows, object>['start'] },
  storage: MemoryStorage,
  workflowId: string,
): Promise<void> {
  await engine.start('signal-poll-workflow', null, { id: workflowId });
  const createTimeBytes = await storage.get(KEYS.checkpoint(workflowId));
  const createTimeLength = createTimeBytes?.length ?? 0;
  await waitForCondition(() => countFor(workflowId, 'before') === 1, {
    label: `"before" step for "${workflowId}"`,
  });
  await waitForCondition(
    async () => {
      const bytes = await storage.get(KEYS.checkpoint(workflowId));
      return (bytes?.length ?? 0) > createTimeLength;
    },
    { label: `parked checkpoint for "${workflowId}"` },
  );
}

describe('Engine · owner-side signal-poll wiring (WFT-79 review finding 1)', () => {
  it('a signal delivered through a NON-owning engine reaches the owner via the renewal task pass, with no other wake involved', async () => {
    const storage = new MemoryStorage();
    let nowA = 10_000_000;
    const engineA = await createSignalPollEngine(storage, () => nowA);
    let nowB = nowA;
    const engineB = await createSignalPollEngine(storage, () => nowB);

    const id = 'signal-poll-owner';
    await startParkedWorkflow(engineA, storage, id);
    expect(getInternals(engineA).workflowClaimRegistry?.currentEpoch(id)).not.toBeNull();
    expect(getInternals(engineB).workflowClaimRegistry?.currentEpoch(id)).toBeNull();

    // Deliver the signal through engine B — the NON-owning engine. This only
    // durably buffers the payload; engine B has no in-memory waiter or parked
    // marker for `id`, so nothing on B can wake it.
    await engineB.signal(id, 'go', 'from-b');

    // No unrelated wake anywhere: no engineA.signal(...) call, no
    // engineA.resume(id), no explicit handle drive — only the claim-renewal
    // lifecycle task's own pass, which is what carries the owner-side signal
    // poll under `backgroundTasks: 'manual'`.
    const pass = await getInternals(engineA).workflowClaimRenewalTask!.runOnce();
    expect(pass.signalPoll?.status).toBe('completed');
    if (pass.signalPoll?.status === 'completed') {
      expect(pass.signalPoll.result.wokenCount).toBeGreaterThan(0);
    }

    const handle = engineA.getHandle(id);
    const result = await handle.result();

    expect(result).toBe('received:from-b');
    expect(countFor(id, 'before')).toBe(1);
    expect(countFor(id, 'after')).toBe(1);

    await engineA[Symbol.asyncDispose]();
    await engineB[Symbol.asyncDispose]();
  });

  it('without a buffered signal, a poll pass reports the parked wait but does not wake it', async () => {
    const storage = new MemoryStorage();
    let now = 11_000_000;
    const engineA = await createSignalPollEngine(storage, () => now);

    const id = 'signal-poll-no-signal-yet';
    await startParkedWorkflow(engineA, storage, id);

    const pass = await getInternals(engineA).workflowClaimRenewalTask!.runOnce();

    expect(pass.signalPoll?.status).toBe('completed');
    if (pass.signalPoll?.status === 'completed') {
      expect(pass.signalPoll.result.outcomes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ workflowId: id, signalName: 'go', status: 'not-buffered' }),
        ]),
      );
      expect(pass.signalPoll.result.wokenCount).toBe(0);
    }
    expect(countFor(id, 'after')).toBe(0);

    await engineA[Symbol.asyncDispose]();
  });
});

describe('Engine · owner-side signal poll for LIVE in-memory waiters', () => {
  it('wakes a live signal waiter when the signal was buffered through another engine', async () => {
    const storage = new MemoryStorage();
    let now = 20_000_000;
    const engineA = await Engine.create({
      storage,
      workflows: liveWaiterWorkflows,
      ownership: 'workflow-lease',
      getNow: () => now,
      workflowClaimTtl: `${CLAIM_TTL_MS}ms`,
      workflowClaimRenewInterval: `${CLAIM_RENEW_INTERVAL_MS}ms`,
      backgroundTasks: 'manual',
    });
    const engineB = await Engine.create({
      storage,
      workflows: liveWaiterWorkflows,
      ownership: 'workflow-lease',
      getNow: () => now,
      workflowClaimTtl: `${CLAIM_TTL_MS}ms`,
      workflowClaimRenewInterval: `${CLAIM_RENEW_INTERVAL_MS}ms`,
      backgroundTasks: 'manual',
    });

    const id = 'live-waiter-1';
    await engineA.start('live-waiter-workflow', null, { id });
    await waitForCondition(async () => (await engineA.query(id, 'ping')) === 'pong', {
      label: 'live context reachable through its query handler',
    });

    // Buffer the signal through the NON-owning engine, then drive only engine
    // A's renewal pass. Nothing else can wake this waiter.
    await engineB.signal(id, 'go', 'from-b');
    const pass = await getInternals(engineA).workflowClaimRenewalTask!.runOnce();
    expect(pass.signalPoll?.status).toBe('completed');

    await expect(engineA.getHandle(id).result()).resolves.toBe('live:from-b');
    expect(countFor(id, 'after')).toBe(1);

    await engineA[Symbol.asyncDispose]();
    await engineB[Symbol.asyncDispose]();
  });
});
