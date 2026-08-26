/**
 * WFT-79 acceptance criteria: `ownership: 'workflow-lease'` deployment
 * scenarios, end to end, against two (or more) REAL `Engine.create()`
 * instances sharing one `MemoryStorage` — never a mock of the claim
 * mechanism, never a real sleep. Every engine here gets its OWN mutable
 * `now` closure (never shared between engines — a shared clock let one
 * engine's real renewal interval race a `takeover()` a prior draft of this
 * file called directly, corrupting the result) and `backgroundTasks:
 * 'manual'` (a real `setInterval` reclaim scan can race a directly-invoked
 * `takeover()` on slow CI). Engines this file deliberately "crashes" (drops
 * the reference to, without disposing) also get `startScheduler: false` so
 * the abandoned engine leaks no real timer into later tests.
 *
 * This file complements, rather than duplicates, existing coverage:
 * `workflow-claim-two-engine.test.ts` pins the WFT-78 claim-acquisition
 * races (start, recovery, bulk retry) via a manually-installed registry —
 * written before the engine-level bootstrap was wired end to end.
 * `workflow-lease-ownership.test.ts` pins engine-level bootstrap ordering,
 * gate wiring, and dispose-release mechanics for a SINGLE engine. This file
 * is the TWO-engine deployment-lifecycle layer that sits on top of both: the
 * six scenarios ADR 0002 names as requiring end-to-end proof — rolling
 * release, awaited shutdown promptness, crash recovery, the exact expiry
 * boundary, takeover isolation, and rollback inertness — driven entirely
 * through `Engine.create({ ownership: 'workflow-lease' })`'s production
 * wiring (no manually-installed registries), since that wiring is now fully
 * live (WFT-79).
 *
 * One genuine ADR/code gap surfaced while writing this file and is pinned
 * rather than routed around: see the "CRASH" describe block's doc comment.
 */
import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import {
  waitForCondition,
  waitForRealTimersForTesting,
} from '../../testing/fake-timers.test-support.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import {
  Engine,
  OwnershipModeMismatchError,
  WeftWorkflowClaimLostWarning,
  WorkflowClaimUnavailableError,
} from './index.ts';
import { getInternals } from './internals.ts';
import { decodeWorkflowClaimHolder } from './workflow-claim-codec.ts';
import { WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER } from './workflow-claim-transitions.ts';

/** Per-workflow-id activity execution counts. Ids are unique per test, so one shared map is safe. */
const activityRunCounts = new Map<string, number>();

function recordActivityRun(workflowId: string, label: string): void {
  const key = `${workflowId}:${label}`;
  activityRunCounts.set(key, (activityRunCounts.get(key) ?? 0) + 1);
}

function runCountFor(workflowId: string, label: string): number {
  return activityRunCounts.get(`${workflowId}:${label}`) ?? 0;
}

/**
 * Records a "before" side effect, parks on `waitForSignal('go')`, then
 * records an "after" side effect and returns it — used by every scenario
 * below so a checkpoint/replay bug (the sharpest failure mode a handoff can
 * introduce) shows up as `before` running MORE than once, not merely as a
 * wrong final result.
 */
const parkedCounterWorkflow = workflow({ name: 'deployment-scenario-workflow' }).execute(
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

type SharedWorkflows = { 'deployment-scenario-workflow': typeof parkedCounterWorkflow };
const workflows: SharedWorkflows = { 'deployment-scenario-workflow': parkedCounterWorkflow };

/**
 * Starts `workflowId` on `engine` and waits until it has durably parked on
 * its `waitForSignal('go')` — i.e. the "before" `ctx.run()` step has already
 * run AND its checkpoint has committed. Snapshotting the checkpoint length
 * MUST happen immediately after `start()` returns, in this same function —
 * a first draft snapshotted it lazily, inside a separate later "wait" call,
 * which raced multiple concurrently-starting workflows: by the time the
 * SECOND id's snapshot was taken, its checkpoint had already advanced past
 * "created" while this function was busy polling the first id, so the
 * snapshot captured the POST-park length and the growth check never
 * resolved. `start()`'s create batch writes an initial `KEYS.checkpoint`
 * entry (confirmed empirically — non-null immediately after `start()`
 * resolves, before the first inline turn even runs, since `start()` only
 * queues that turn onto the inline-launch macrotask rather than running it
 * inline), so polling merely "checkpoint !== null" would also race the
 * "before" activity. Polling the OBSERVABLE side effect
 * (`activityRunCounts`) first, then confirming the checkpoint bytes grew
 * past the CORRECTLY-timed create-time snapshot, settles both the side
 * effect and its durable commit before the caller proceeds.
 */
async function startParkedWorkflow(
  engine: { start: Engine<SharedWorkflows, object>['start'] },
  storage: MemoryStorage,
  workflowId: string,
): Promise<void> {
  await engine.start('deployment-scenario-workflow', null, { id: workflowId });
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

async function readHolder(storage: MemoryStorage, workflowId: string) {
  const raw = await storage.get(KEYS.workflowOwnerHolder(workflowId));
  return raw === null ? null : decodeWorkflowClaimHolder(raw);
}

/** Standard tuning for every engine in this file: 1s renew, 3s TTL (grace = 2s). */
const CLAIM_RENEW_INTERVAL_MS = 1_000;
const CLAIM_TTL_MS = 3_000;

function createDeploymentEngine(
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

function captureWarnings(): { warnings: Error[]; stop: () => void } {
  const warnings: Error[] = [];
  const listener = (warning: Error): void => {
    warnings.push(warning);
  };
  process.on('warning', listener);
  return { warnings, stop: () => process.off('warning', listener) };
}

describe('WFT-79: workflow-lease deployment scenarios (two real engines, one store)', () => {
  describe('ROLLING RELEASE', () => {
    it('an outgoing engine disposes gracefully while holding claims; the incoming engine picks every one up, running none twice', async () => {
      const storage = new MemoryStorage();
      let nowA = 1_000_000;
      const engineA = await createDeploymentEngine(storage, () => nowA);

      const ids = ['rolling-1', 'rolling-2', 'rolling-3'];
      for (const id of ids) {
        await startParkedWorkflow(engineA, storage, id);
      }
      for (const id of ids) {
        expect(runCountFor(id, 'before')).toBe(1);
        expect(getInternals(engineA).workflowClaimRegistry?.currentEpoch(id)).toBe(1);
      }

      // Graceful handoff: released claims, no crash, no expiry wait.
      await engineA[Symbol.asyncDispose]();
      for (const id of ids) {
        expect(await readHolder(storage, id)).toBeNull();
      }

      let nowB = nowA; // same instant — a clean handoff needs no clock advance at all.
      const engineB = await createDeploymentEngine(storage, () => nowB);

      for (const id of ids) {
        // recoverAll() (run by Engine.create) already re-acquired and re-parked
        // every id — assert the claim, then drive it to completion.
        expect(getInternals(engineB).workflowClaimRegistry?.currentEpoch(id)).toBe(2);
        await engineB.getHandle(id)?.signal('go');
        const result = await engineB.getHandle(id)?.result();
        expect(result).toBe('ran');
      }

      // The sharpest handoff-replay pin: "before" ran exactly once per id,
      // TOTAL, across both engines — a checkpoint/replay bug would show up
      // here as 2, not as a wrong final result.
      for (const id of ids) {
        expect(runCountFor(id, 'before')).toBe(1);
        expect(runCountFor(id, 'after')).toBe(1);
      }

      await engineB[Symbol.asyncDispose]();
    });
  });

  describe('AWAITED SHUTDOWN', () => {
    it('await engine[Symbol.asyncDispose]() releases held claims BEFORE resolving, so a successor acquires immediately rather than waiting out a long TTL', async () => {
      const storage = new MemoryStorage();
      let nowA = 2_000_000;
      // A deliberately LONG TTL: if release-before-resolve did not hold, a
      // successor at the SAME instant would have to wait this entire TTL out.
      const engineA = await Engine.create({
        storage,
        workflows,
        ownership: 'workflow-lease',
        getNow: () => nowA,
        workflowClaimTtl: '10m',
        workflowClaimRenewInterval: '30s',
        backgroundTasks: 'manual',
      });

      const id = 'awaited-shutdown-1';
      await startParkedWorkflow(engineA, storage, id);
      const holderBefore = await readHolder(storage, id);
      expect(holderBefore?.epoch).toBe(1);

      await engineA[Symbol.asyncDispose]();
      expect(await readHolder(storage, id)).toBeNull();

      // SAME instant, same TTL config — success here is proof of promptness,
      // not of enough time having passed.
      const nowB = nowA;
      const engineB = await Engine.create({
        storage,
        workflows,
        ownership: 'workflow-lease',
        getNow: () => nowB,
        workflowClaimTtl: '10m',
        workflowClaimRenewInterval: '30s',
        backgroundTasks: 'manual',
      });

      const holderAfter = await readHolder(storage, id);
      // Release deletes the holder without rotating the epoch (ADR's `release`
      // row), so the successor's next acquire mints epoch 2, not a fresh 1 —
      // pin that continuity, not only "some claim exists".
      expect(holderAfter?.epoch).toBe(2);
      expect(getInternals(engineB).workflowClaimRegistry?.currentEpoch(id)).toBe(2);

      await engineB.getHandle(id)?.signal('go');
      const result = await engineB.getHandle(id)?.result();
      expect(result).toBe('ran');
      expect(runCountFor(id, 'before')).toBe(1);
      expect(runCountFor(id, 'after')).toBe(1);

      await engineB[Symbol.asyncDispose]();
    });
  });

  /**
   * CRASH scenario, and the ADR/code gap it surfaced.
   *
   * ADR 0002 § "Reclaiming stranded claims" frames the recurring reclaim scan
   * as the fix for a stranded claim: "the successor skips those workflows
   * and, with no further scan, they stay stranded until something else
   * happens to touch them... the engine therefore runs a recurring reclaim
   * scan." Read at face value that sentence promises the reclaim scan is
   * what un-strands the workflow. It is NOT: `takeover()` (driven by the
   * reclaim scan, `workflow-claim-reclaim-scan.ts` +
   * `ownership-bootstrap.ts`'s `createWorkflowClaimReclaimTarget`) moves only
   * the DURABLE CLAIM — it never calls `resumeWorkflowFromStorage` or
   * anything else that relaunches the workflow's generator. Confirmed
   * empirically (not just by reading): after a successful reclaim, the
   * workflow makes NO progress on the successor until something separately
   * calls `engine.resume(id)` (or a fresh `recoverAll()` sweep) for it — the
   * exact "stay stranded until something else happens to touch them" fate
   * the ADR describes reclaim as fixing. Worse, once reclaimed, the
   * successor's OWN renewal task now keeps that claim alive indefinitely
   * even though it never drives the workflow, which shields the still-stuck
   * workflow from ever being reclaimed a second time by a THIRD engine that
   * might actually resume it.
   *
   * This is written as a two-step test against ACTUAL behavior — reclaim,
   * then an explicit `resume()` — with the negative control (`resume()`
   * before reclaim throws `WorkflowClaimUnavailableError`) proving the
   * reclaim step was load-bearing. It does not assert the gap is fine; see
   * this task's returned summary.
   */
  describe('CRASH', () => {
    it('a stranded claim is reclaimed once expired, and the reclaim scan drives the workflow itself — no explicit resume() needed', async () => {
      const storage = new MemoryStorage();
      let nowA = 3_000_000;
      const engineA = await createDeploymentEngine(storage, () => nowA, {
        startScheduler: false, // engineA is abandoned below; leak no real timer.
      });

      const id = 'crash-1';
      await startParkedWorkflow(engineA, storage, id);
      expect(getInternals(engineA).workflowClaimRegistry?.currentEpoch(id)).toBe(1);
      const holderBeforeCrash = await readHolder(storage, id);
      expect(holderBeforeCrash?.engineId).toBe(
        getInternals(engineA).workflowClaimRegistry?.engineId,
      );

      // CRASH: drop the reference. No dispose, no release, no further renewal.
      // (engineA is simply never touched again after this point.)

      // Successor boots WHILE the holder is still live (not yet expired) —
      // its own recoverAll() must skip this id (acquire, not takeover, and
      // acquire does not consider expiry — only an absent holder).
      let nowB = nowA + 500; // well under the 3s TTL
      const engineB = await createDeploymentEngine(storage, () => nowB);
      expect(getInternals(engineB).workflowClaimRegistry?.currentEpoch(id)).toBeNull();

      // Negative control: an explicit resume() this early loses the CAS —
      // proves the workflow is genuinely stranded, not just idle.
      await expect(engineB.resume(id)).rejects.toBeInstanceOf(WorkflowClaimUnavailableError);
      await expect(engineB.resume(id)).rejects.toMatchObject({
        workflowId: id,
        heldBy: holderBeforeCrash?.engineId,
      });
      expect(getInternals(engineB).workflowClaimRegistry?.currentEpoch(id)).toBeNull();

      // Advance PAST the grace-adjusted expiry judgment and drive engineB's
      // claim-renewal lifecycle task — this is what runs the reclaim scan.
      nowB =
        nowA +
        CLAIM_TTL_MS +
        WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER * CLAIM_RENEW_INTERVAL_MS +
        1;
      const reclaimPass = await getInternals(engineB).workflowClaimRenewalTask!.runOnce();
      expect(reclaimPass.reclaim?.status).toBe('completed');
      if (reclaimPass.reclaim?.status === 'completed') {
        expect(reclaimPass.reclaim.outcomes).toContainEqual({
          workflowId: id,
          status: 'reclaimed',
        });
      }

      // The DURABLE holder now names engineB, at a fresh epoch — the claim
      // genuinely moved, read back from storage rather than trusted from the
      // pass result alone.
      const holderAfterReclaim = await readHolder(storage, id);
      expect(holderAfterReclaim?.engineId).toBe(
        getInternals(engineB).workflowClaimRegistry?.engineId,
      );
      expect(holderAfterReclaim?.epoch).toBe(2);
      expect(getInternals(engineB).workflowClaimRegistry?.currentEpoch(id)).toBe(2);

      // The workflow is signal-parked, so nothing downstream of the park has
      // run yet — reclaiming a claim cannot invent the signal it is waiting on.
      expect(runCountFor(id, 'after')).toBe(0);

      // But the reclaim scan drove it: the successor relaunched the generator
      // from its last checkpoint and it re-parked on `waitForSignal`. The proof
      // is that delivering the signal alone completes it — no `engine.resume()`
      // call anywhere below. Without the scan driving the workflow, taking the
      // claim would only move durable keys and this signal would land on a
      // workflow no engine is running.
      const handle = engineB.getHandle(id);
      await handle.signal('go');
      const result = await handle.result();
      expect(result).toBe('ran');

      // Exactly once, total, across both engines — the crashed engine's
      // workflow is not lost, and reclaim + resume did not double-run it.
      expect(runCountFor(id, 'before')).toBe(1);
      expect(runCountFor(id, 'after')).toBe(1);

      await engineB[Symbol.asyncDispose]();
    });
  });

  describe('EXPIRY BOUNDARY', () => {
    it('pins the exact grace-adjusted expiry judgment: not-expired AT the deadline, not-expired just before, expired only just after', async () => {
      const storage = new MemoryStorage();
      let nowA = 4_000_000;
      const engineA = await createDeploymentEngine(storage, () => nowA, {
        startScheduler: false,
      });

      const id = 'boundary-1';
      await startParkedWorkflow(engineA, storage, id);
      const holderBefore = await readHolder(storage, id);
      expect(holderBefore).not.toBeNull();
      const victimEngineId = getInternals(engineA).workflowClaimRegistry!.engineId;
      // Read the REAL expiresAt this engine wrote, rather than recomputing it,
      // so the boundary is pinned against the actual durable value.
      const expiresAt = holderBefore!.expiresAt;
      const graceAdjustedDeadline =
        expiresAt + WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER * CLAIM_RENEW_INTERVAL_MS;

      // engineA is abandoned here (crash-without-release), same as the CRASH
      // scenario — the successor below reads its holder directly.

      let nowB = graceAdjustedDeadline; // will be mutated per attempt below.
      const engineB = await createDeploymentEngine(storage, () => nowB);
      const successorEngineId = getInternals(engineB).workflowClaimRegistry!.engineId;
      const registry = getInternals(engineB).workflowClaimRegistry!;

      // AT the grace-adjusted deadline: NOT expired (the ADR's "earlier than"
      // wording is strict — equal is not earlier).
      nowB = graceAdjustedDeadline;
      const atDeadline = await registry.takeover(id);
      expect(atDeadline.status).toBe('not-expired');
      const holderAtDeadline = await readHolder(storage, id);
      expect(holderAtDeadline?.engineId).toBe(victimEngineId);
      expect(holderAtDeadline?.epoch).toBe(1);

      // JUST BEFORE: also not expired.
      nowB = graceAdjustedDeadline - 1;
      const justBefore = await registry.takeover(id);
      expect(justBefore.status).toBe('not-expired');
      const holderJustBefore = await readHolder(storage, id);
      expect(holderJustBefore?.engineId).toBe(victimEngineId);
      expect(holderJustBefore?.epoch).toBe(1);

      // JUST AFTER: expired — the durable holder actually changes hands.
      nowB = graceAdjustedDeadline + 1;
      const justAfter = await registry.takeover(id);
      expect(justAfter.status).toBe('acquired');
      const holderJustAfter = await readHolder(storage, id);
      expect(holderJustAfter?.engineId).toBe(successorEngineId);
      expect(holderJustAfter?.epoch).toBe(2);

      await engineB[Symbol.asyncDispose]();
    });
  });

  describe('TAKEOVER', () => {
    it('a successor taking over ONE claim deposes only that workflow on the previous owner — its other claimed workflows keep running durably', async () => {
      const storage = new MemoryStorage();
      let nowA = 5_000_000;
      const engineA = await createDeploymentEngine(storage, () => nowA);

      const takenOverId = 'takeover-x';
      const untouchedId = 'takeover-y';
      await startParkedWorkflow(engineA, storage, takenOverId);
      await startParkedWorkflow(engineA, storage, untouchedId);
      expect(getInternals(engineA).workflowClaimRegistry?.currentEpoch(takenOverId)).toBe(1);
      expect(getInternals(engineA).workflowClaimRegistry?.currentEpoch(untouchedId)).toBe(1);

      // Deliberately no signal yet: signalling `takenOverId` BEFORE deposition
      // was this test's first draft, and it produced a genuinely different
      // (and non-deterministic) scenario, not this one — signalling a workflow
      // engineA still legitimately owns starts a real in-flight turn that
      // races the takeover below, and the turn can win: its "after" activity
      // completes before the turn's own checkpoint write loses its CAS. That
      // is not a bug; it is ADR 0002's own documented, bounded caveat
      // ("the deposed engine's already-in-flight, non-abort-checking
      // activities can complete... before its next write loses its CAS" —
      // confirmed empirically, see this task's returned summary), but it is a
      // DIFFERENT scenario than "deposed while genuinely idle, then signalled
      // after," which is what this test isolates below.
      //
      // Successor takes over ONLY `takenOverId`, via a direct registry call —
      // the sanctioned precision pattern this repo already uses (e.g.
      // `workflow-lease-ownership.test.ts` calls `registry.acquire()`
      // directly) to isolate ONE workflow's takeover from a blanket reclaim
      // sweep that would otherwise treat both ids identically (both claimed
      // at the same instant, same TTL).
      let nowB =
        nowA +
        CLAIM_TTL_MS +
        WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER * CLAIM_RENEW_INTERVAL_MS +
        1;
      const engineB = await createDeploymentEngine(storage, () => nowB);
      const takeoverResult =
        await getInternals(engineB).workflowClaimRegistry!.takeover(takenOverId);
      expect(takeoverResult.status).toBe('acquired');

      const { warnings, stop } = captureWarnings();
      try {
        // Drive engineA's OWN renewal pass. `takenOverId`'s renew loses its
        // CAS (the holder bytes changed under it) regardless of engineA's own
        // clock — the renew condition is byte-equality, not a time judgment.
        // `untouchedId`'s renew succeeds normally.
        const pass = await getInternals(engineA).workflowClaimRenewalTask!.runOnce();
        expect(pass.outcomes).toContainEqual({ workflowId: untouchedId, status: 'renewed' });
        const takenOverOutcome = pass.outcomes.find(
          (outcome) => outcome.workflowId === takenOverId,
        );
        expect(takenOverOutcome?.status).toBe('failed');

        // `process.emitWarning` dispatches to 'warning' listeners on a later
        // tick, not synchronously within the call that triggered it — poll
        // for delivery instead of reading `warnings` immediately.
        await waitForCondition(
          () =>
            warnings.some(
              (warning): boolean =>
                warning instanceof WeftWorkflowClaimLostWarning &&
                warning.workflowId === takenOverId,
            ),
          { label: `claim-lost warning for "${takenOverId}"` },
        );
      } finally {
        stop();
      }

      // ISOLATION, in the registry's own bookkeeping: losing one claim did
      // not touch the other's local tracking.
      expect(getInternals(engineA).workflowClaimRegistry?.currentEpoch(takenOverId)).toBeNull();
      expect(getInternals(engineA).workflowClaimRegistry?.currentEpoch(untouchedId)).toBe(1);

      // ISOLATION, durably: the untouched workflow keeps making real progress
      // on engineA, completely unaffected by its sibling's deposition.
      await engineA.getHandle(untouchedId)?.signal('go');
      const untouchedResult = await engineA.getHandle(untouchedId)?.result();
      expect(untouchedResult).toBe('ran');
      expect(runCountFor(untouchedId, 'after')).toBe(1);

      // DEPOSITION, durably: signalling the deposed engineA's copy of
      // `takenOverId` NOW (genuinely idle — no in-flight turn to race) still
      // durably buffers the signal (buffering is intentionally external — any
      // engine may write it), but the LOCAL wake must not drive the generator.
      //
      // NOTE (see this task's returned summary for the full finding): the
      // signal-wake path (`deliverBufferedSignals` → `resumeParkedInlineWorkflow`
      // → `resumeWorkflowFromStorage`) does NOT go through
      // `confirmWakeOwnership`/`wakeOwnershipCheck` the way sleep, wait-condition,
      // async-activity, and inline-macrotask-drive wakes do — so no
      // `WeftWorkflowWakeDiscardedWarning` fires here. It IS still safe: that
      // resume path's own `acquireStandaloneClaimBeforeResume` runs a real
      // `registry.acquire()` CAS BEFORE the generator relaunches, loses it
      // (the holder now names engineB), throws `WorkflowClaimUnavailableError`,
      // and `signals.ts`'s `void callbacks.resumeParkedInlineWorkflow(...)` call
      // swallows that rejection via `swallowPromiseRejection` — confirmed
      // empirically, not just by reading. So execution safety holds (no
      // double-run below), but the ADR's observability contract for this
      // wake kind is unmet — pinning the safety property, not the silence.
      await engineA.getHandle(takenOverId)?.signal('go');
      // fixed delay: negative assertion — no discard warning is emitted on this path (see the note above), so there is no positive event to await; this bounds how long a wrongly-driven generator is given to run before asserting it did not.
      await waitForRealTimersForTesting(50);
      expect(runCountFor(takenOverId, 'after')).toBe(0);

      // NOT LOST: the new owner explicitly resumes it and consumes the
      // signal that was already durably buffered on engineA above — cross-
      // engine buffer honor, not a re-signal from engineB.
      const takenOverHandle = await engineB.resume(takenOverId);
      const takenOverResult = await takenOverHandle.result();
      expect(takenOverResult).toBe('ran');
      expect(runCountFor(takenOverId, 'before')).toBe(1);
      expect(runCountFor(takenOverId, 'after')).toBe(1);

      await engineA[Symbol.dispose]();
      await engineB[Symbol.asyncDispose]();
    });

    /**
     * WFT-79 review finding: `acquireStandaloneClaimBeforeResume` used to
     * skip its durable re-check entirely whenever this engine's LOCAL claim
     * cache still had an epoch for the workflow — the exact stale-cache
     * hazard this test isolates. Unlike the test above, engineA's own
     * renewal pass never runs here, so `currentEpoch(takenOverId)` is STILL
     * the pre-takeover value when the signal-driven resume happens — the
     * "stalled, deposed, not yet self-detected" window the old shortcut
     * treated as proof of live ownership.
     */
    it('a checkpoint-parked resume does not trust a stale local claim cache when the durable holder already shows a takeover', async () => {
      const storage = new MemoryStorage();
      let nowA = 5_500_000;
      const engineA = await createDeploymentEngine(storage, () => nowA);

      const id = 'stale-cache-resume';
      await startParkedWorkflow(engineA, storage, id);
      expect(getInternals(engineA).workflowClaimRegistry?.currentEpoch(id)).toBe(1);

      // Successor takes over directly, past expiry+grace — engineA's own
      // renewal pass is deliberately never run, so its local cache still
      // reports epoch 1 for `id`.
      const nowB = nowA + CLAIM_TTL_MS + WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER * 1_000 + 1;
      const engineB = await createDeploymentEngine(storage, () => nowB);
      const takeoverResult = await getInternals(engineB).workflowClaimRegistry!.takeover(id);
      expect(takeoverResult.status).toBe('acquired');
      expect(getInternals(engineA).workflowClaimRegistry?.currentEpoch(id)).toBe(1);

      // Signal engineA's copy: `deliverBufferedSignals` →
      // `resumeParkedInlineWorkflow` → `resumeWorkflowFromStorage` →
      // `acquireStandaloneClaimBeforeResume`, hitting the stale-cache branch.
      await engineA.getHandle(id)?.signal('go');
      // fixed delay: negative assertion — proving the stale generator never advanced has no observable event to await instead.
      await waitForRealTimersForTesting(50);
      expect(runCountFor(id, 'after')).toBe(0);

      // The successor completes it normally, consuming the durably-buffered signal.
      const handle = await engineB.resume(id);
      await expect(handle.result()).resolves.toBe('ran');
      expect(runCountFor(id, 'before')).toBe(1);
      expect(runCountFor(id, 'after')).toBe(1);

      await engineA[Symbol.dispose]();
      await engineB[Symbol.asyncDispose]();
    });
  });

  describe('ROLLBACK', () => {
    it('starting the other fencing mode against an already-stamped store is rejected', async () => {
      const storage = new MemoryStorage();
      let now = 6_000_000;
      const engineA = await createDeploymentEngine(storage, () => now);
      expect(await storage.get(KEYS.ownershipModeMarker())).not.toBeNull();

      await expect(Engine.create({ storage, workflows, ownership: 'lease' })).rejects.toThrow(
        OwnershipModeMismatchError,
      );

      // 'none' never touches the marker, so it is NOT rejected — but it also
      // does not run concurrently with a live workflow-lease engine in this
      // test: construct exactly once, dispose immediately, since its whole
      // point here is only to prove the marker doesn't block construction.
      // Its interaction with LEFTOVER (not live) workflow-lease keys is the
      // next test, which is the actually-supported stop-all rollback
      // sequence.
      const noneEngine = await Engine.create({ storage, workflows, recover: false });
      expect(noneEngine).toBeDefined();
      await noneEngine[Symbol.asyncDispose]();

      await engineA[Symbol.asyncDispose]();
    });

    /**
     * The ADR's actually-supported rollback sequence: stop every
     * `workflow-lease` engine FIRST (here, simulated as a crash — the harder
     * case, since it leaves the holder key behind uncleaned, unlike a
     * graceful release), confirm none remain, THEN start `ownership: 'none'`.
     * This does not test — and the comment above deliberately does not claim
     * — that `'none'` is safe to run CONCURRENTLY with a live `workflow-lease`
     * owner; the ADR is explicit that overlap is unsafe and out of scope for
     * automatic prevention. This proves the STOPPED-first sequence works and
     * that the leftover keys neither block it nor get mutated by it.
     */
    it('once every workflow-lease engine has stopped, leftover wf-owner-* keys are inert to a downgraded ownership: "none" engine', async () => {
      const storage = new MemoryStorage();
      let now = 7_000_000;
      const engineA = await createDeploymentEngine(storage, () => now, {
        startScheduler: false,
      });

      const id = 'rollback-1';
      await startParkedWorkflow(engineA, storage, id);

      // Crash (not a graceful release): the harder case for "inert", since
      // the holder key is left behind, not cleaned up.
      const epochBytesBefore = await storage.get(KEYS.workflowOwnerEpoch(id));
      const holderBytesBefore = await storage.get(KEYS.workflowOwnerHolder(id));
      expect(epochBytesBefore).not.toBeNull();
      expect(holderBytesBefore).not.toBeNull();

      // Downgrade: a fresh 'none' engine against the SAME store. 'none' never
      // reads or writes the marker, and never touches wf-owner-* keys at all
      // (`acquireStandaloneClaimBeforeResume`'s very first guard is
      // `ownershipMode !== 'workflow-lease'`).
      const noneEngine = await Engine.create({ storage, workflows });

      // Recovered and runs normally — the leftover claim keys did not block
      // recovery of a workflow they still (durably, but irrelevantly) name.
      const handle = noneEngine.getHandle(id);
      await handle.signal('go');
      const result = await handle.result();
      expect(result).toBe('ran');
      expect(runCountFor(id, 'after')).toBe(1);

      // INERT, precisely: the leftover bytes are byte-identical before and
      // after the 'none' engine's entire run, including this terminal
      // commit — proof 'none' neither read nor wrote them, not merely that
      // it didn't visibly fail.
      const epochBytesAfter = await storage.get(KEYS.workflowOwnerEpoch(id));
      const holderBytesAfter = await storage.get(KEYS.workflowOwnerHolder(id));
      expect(epochBytesAfter).toEqual(epochBytesBefore);
      expect(holderBytesAfter).toEqual(holderBytesBefore);

      // The ownership-mode marker itself is also untouched by 'none'.
      expect(await storage.get(KEYS.ownershipModeMarker())).not.toBeNull(); // still stamped 'workflow-lease' from engineA's construction.

      await noneEngine[Symbol.asyncDispose]();
    });
  });

  describe('TERMINAL RELEASE (WFT-79)', () => {
    it('releases the claim on completion, so a completed workflow is absent from the next renewal pass', async () => {
      const storage = new MemoryStorage();
      let now = 8_000_000;
      const engine = await createDeploymentEngine(storage, () => now, {
        startScheduler: false,
      });

      const id = 'terminal-release-complete';
      await startParkedWorkflow(engine, storage, id);
      expect(getInternals(engine).workflowClaimRegistry?.currentEpoch(id)).not.toBeNull();

      const handle = engine.getHandle(id);
      await handle.signal('go');
      const result = await handle.result();
      expect(result).toBe('ran');

      // The completed workflow's claim is gone — not merely renewed forever.
      expect(getInternals(engine).workflowClaimRegistry?.currentEpoch(id)).toBeNull();
      expect(await storage.get(KEYS.workflowOwnerHolder(id))).toBeNull();

      // And the next renewal pass no longer lists or renews it.
      const pass = await getInternals(engine).workflowClaimRenewalTask!.runOnce();
      expect(pass.outcomes.map((outcome) => outcome.workflowId)).not.toContain(id);

      await engine[Symbol.asyncDispose]();
    });

    it('releases the claim on external cancellation too', async () => {
      const storage = new MemoryStorage();
      let now = 9_000_000;
      const engine = await createDeploymentEngine(storage, () => now, {
        startScheduler: false,
      });

      const id = 'terminal-release-cancel';
      await startParkedWorkflow(engine, storage, id);
      expect(getInternals(engine).workflowClaimRegistry?.currentEpoch(id)).not.toBeNull();

      await engine.cancel(id);

      expect(getInternals(engine).workflowClaimRegistry?.currentEpoch(id)).toBeNull();
      expect(await storage.get(KEYS.workflowOwnerHolder(id))).toBeNull();

      const pass = await getInternals(engine).workflowClaimRenewalTask!.runOnce();
      expect(pass.outcomes.map((outcome) => outcome.workflowId)).not.toContain(id);

      await engine[Symbol.asyncDispose]();
    });
  });
});
