/**
 * An inline start's launch is queued, and its generator exists only once the queue flushes. A
 * reclaim can meet the run in that state: a listing takes its exclude set before the start folds
 * its claim and then lists the start's own holder record, so the pass redrives a run this engine
 * is about to drive itself. The reclaim leaves the run to the queued launch and returns (COR-1618).
 * It must not wait for the flush: under `inlineLaunchScheduling: 'manual'` only the host flushes,
 * and a host that awaits the pass before it flushes would wait forever, along with the renewal of
 * every other claim the pass carries.
 *
 * A queued launch that throws before its generator exists drives nothing, and nothing else would:
 * the engine holds the run's checkpoint and renews its claim, which hides the run from
 * `recoverAll()` and from the reclaim scan alike. So the flush reports the failure and lets the
 * run go, in memory and durably, and the next reclaim pass acquires and drives it as an ownerless
 * running workflow.
 *
 * A start enqueued under a claim the engine has since lost and taken back carries the checkpoint
 * of its enqueue, which another holder may have advanced. The reclaim that took the claim back
 * does not defer to that start; it drives the run from storage, and the flush discards the start.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { waitForCondition } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { KEYS } from '../../storage/keys.ts';
import { CleanupWarningEvent } from '../events.ts';
import { createLifecycleCallbacks } from './callback-creators.ts';
import { currentExecutionAttempt } from './execution-attempts.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { resumeStoredWorkflow } from './lifecycle/resume.ts';
import {
  hasQueuedInlineWorkflowStart,
  hasQueuedOrLaunchingInlineWorkflowStart,
} from './local-execution.ts';
import { countingWorkflow, letOtherDrivesStart, probeFor } from './reclaim-race.test-support.ts';
import type { WorkflowClaimRenewalPassResult } from './workflow-claim-renewal-task.ts';

const WORKFLOW_ID = 'queued-start-run';
const FLUSH_FAILURE = 'transient storage error in the queued launch';

class RacingStorage extends MemoryStorage {
  /** While set, the holder scan of a reclaim listing waits here. */
  holderScanGate: PromiseWithResolvers<void> | null = null;
  readonly reachedHolderScan = Promise.withResolvers<void>();
  /** When armed, the next read of the run's state throws once. */
  failNextStateRead = false;
  stateReadFailures = 0;

  override async *scan(
    prefix: string,
    options?: Parameters<MemoryStorage['scan']>[1],
  ): AsyncIterable<[string, Uint8Array]> {
    if (this.holderScanGate !== null && prefix === KEYS.workflowOwnerHolder('')) {
      const gate = this.holderScanGate;
      this.holderScanGate = null;
      this.reachedHolderScan.resolve();
      await gate.promise;
    }
    yield* super.scan(prefix, options);
  }

  override async get(key: string): Promise<Uint8Array | null> {
    if (this.failNextStateRead && key === KEYS.workflow(WORKFLOW_ID)) {
      this.failNextStateRead = false;
      this.stateReadFailures++;
      throw new Error(FLUSH_FAILURE);
    }
    return super.get(key);
  }
}

function createEngine(storage: RacingStorage) {
  return Engine.create({
    storage,
    workflows: { counted: countingWorkflow(storage) },
    ownership: 'workflow-lease',
    backgroundTasks: 'manual',
    startScheduler: false,
    recover: false,
    inlineLaunchScheduling: 'manual',
  });
}

type CountingEngine = Awaited<ReturnType<typeof createEngine>>;

function collectWarnings(engine: CountingEngine): CleanupWarningEvent[] {
  const warnings: CleanupWarningEvent[] = [];
  engine.addEventListener(CleanupWarningEvent.type, (event) => {
    warnings.push(event);
  });
  return warnings;
}

const RECLAIMED = {
  status: 'completed',
  outcomes: [{ workflowId: WORKFLOW_ID, status: 'reclaimed' }],
};

/**
 * Starts the run while a reclaim pass is inside its holder scan, so the pass lists the start's
 * own claim and reaches the run's redrive while the launch is still queued. `beforeRelease` runs
 * with the start queued and the pass still held. The pass is returned unsettled, in an object, so
 * awaiting this function does not await it.
 */
async function listQueuedStartInReclaimPass(
  engine: CountingEngine,
  storage: RacingStorage,
  beforeRelease: () => Promise<void> = async () => {},
): Promise<{ pass: Promise<WorkflowClaimRenewalPassResult> }> {
  const internals = getInternals(engine);
  const holderScanGate = Promise.withResolvers<void>();
  storage.holderScanGate = holderScanGate;
  const pass = internals.workflowClaimRenewalTask!.runOnce();
  await storage.reachedHolderScan.promise;

  await engine.start('counted', null, { id: WORKFLOW_ID });
  expect(internals.workflowClaimRegistry!.currentEpoch(WORKFLOW_ID)).not.toBeNull();
  expect(hasQueuedInlineWorkflowStart(internals, WORKFLOW_ID)).toBe(true);
  await beforeRelease();
  holderScanGate.resolve();
  return { pass };
}

describe('a reclaim that meets a start whose inline launch is still queued', () => {
  it('returns without waiting for the flush, which then drives the run once', async () => {
    const storage = new RacingStorage();
    await using engine = await createEngine(storage);
    const internals = getInternals(engine);
    const warnings = collectWarnings(engine);
    const probe = probeFor(storage);
    const { pass } = await listQueuedStartInReclaimPass(engine, storage);

    // The host awaits the pass before it flushes, as a `'manual'` host may: the pass resolves.
    const result = await pass;
    expect(result.reclaim).toMatchObject(RECLAIMED);
    await letOtherDrivesStart();
    expect(probe.runs).toBe(0);
    expect(hasQueuedInlineWorkflowStart(internals, WORKFLOW_ID)).toBe(true);

    await engine.flushInlineLaunches();
    await waitForCondition(() => probe.runs === 1, { label: 'the queued launch drives the run' });
    expect(await engine.getHandle(WORKFLOW_ID).result()).toBe('ran');
    expect(probe.runs).toBe(1);
    expect(warnings).toEqual([]);
  });

  it('leaves a failed flush to the next pass, which drives the run once', async () => {
    const storage = new RacingStorage();
    await using engine = await createEngine(storage);
    const internals = getInternals(engine);
    const warnings = collectWarnings(engine);
    const probe = probeFor(storage);
    const { pass } = await listQueuedStartInReclaimPass(engine, storage);

    const result = await pass;
    expect(result.reclaim).toMatchObject(RECLAIMED);

    storage.failNextStateRead = true;
    await engine.flushInlineLaunches();
    expect(storage.stateReadFailures).toBe(1);
    expect(probe.runs).toBe(0);
    expect(warnings.map((warning) => warning.error.message)).toEqual([FLUSH_FAILURE]);

    const second = await internals.workflowClaimRenewalTask!.runOnce();
    expect(second.reclaim).toMatchObject(RECLAIMED);
    await waitForCondition(() => probe.runs === 1, { label: 'the next pass drives the run' });
    expect(await engine.getHandle(WORKFLOW_ID).result()).toBe('ran');
    expect(probe.runs).toBe(1);
  });

  it('drives the run itself when the start was enqueued under a claim since lost and taken back', async () => {
    const storage = new RacingStorage();
    await using engine = await createEngine(storage);
    const internals = getInternals(engine);
    const registry = internals.workflowClaimRegistry!;
    const warnings = collectWarnings(engine);
    const probe = probeFor(storage);
    // The activity is held, so the run is still running when the stale start is flushed.
    probe.hold = Promise.withResolvers<void>();
    const { pass } = await listQueuedStartInReclaimPass(engine, storage, async () => {
      // The start's claim lapses and this engine takes the run back under a new claim while the
      // launch is still queued.
      const enqueuedUnder = registry.currentEpoch(WORKFLOW_ID)!;
      expect(await registry.release(WORKFLOW_ID, enqueuedUnder)).toMatchObject({
        status: 'released',
      });
      expect(await registry.acquire(WORKFLOW_ID)).toMatchObject({ status: 'acquired' });
      expect(registry.currentEpoch(WORKFLOW_ID)).not.toBe(enqueuedUnder);
    });

    // The stale queued start is no reason to defer: the reclaim's replay drives the run.
    const result = await pass;
    expect(result.reclaim).toMatchObject(RECLAIMED);
    await waitForCondition(() => probe.runs === 1, {
      label: "the reclaim's replay drives the run",
    });

    // The flush discards the stale start instead of launching its enqueue-time checkpoint beside
    // the replay's generator.
    await engine.flushInlineLaunches();
    expect(hasQueuedOrLaunchingInlineWorkflowStart(internals, WORKFLOW_ID)).toBe(false);
    expect(internals.inlineStrategy!.hasGenerator(WORKFLOW_ID)).toBe(true);
    probe.hold.resolve();
    expect(await engine.getHandle(WORKFLOW_ID).result()).toBe('ran');
    expect(probe.runs).toBe(1);
    expect(warnings).toEqual([]);
  });
});

describe("a reclaim's replay that meets a start whose inline launch is still queued", () => {
  it('returns the running handle and registers no resume of its own', async () => {
    const storage = new RacingStorage();
    await using engine = await createEngine(storage);
    const internals = getInternals(engine);
    const probe = probeFor(storage);
    await engine.start('counted', null, { id: WORKFLOW_ID });
    const claimEpoch = internals.workflowClaimRegistry!.currentEpoch(WORKFLOW_ID)!;

    // The replay a reclaim issues after its entry check, when a start of the run was queued in
    // between (a delayed start fired, say): it defers to the queued launch like the entry does.
    const handle = await resumeStoredWorkflow(
      internals,
      WORKFLOW_ID,
      createLifecycleCallbacks(engine),
      undefined,
      { forceReplayFromStorage: true, skipIfLaunchedUnderClaimEpoch: claimEpoch },
    );
    expect(internals.resumesAwaitingAdoption.has(WORKFLOW_ID)).toBe(false);
    expect(hasQueuedInlineWorkflowStart(internals, WORKFLOW_ID)).toBe(true);
    expect(probe.runs).toBe(0);

    await engine.flushInlineLaunches();
    expect(await handle.result()).toBe('ran');
    expect(probe.runs).toBe(1);
  });
});

describe('a queued inline launch that fails before its generator exists', () => {
  it('reports the failure and lets the run go, and the next reclaim pass drives it', async () => {
    const storage = new RacingStorage();
    await using engine = await createEngine(storage);
    const internals = getInternals(engine);
    const registry = internals.workflowClaimRegistry!;
    const warnings = collectWarnings(engine);
    const probe = probeFor(storage);
    await engine.start('counted', null, { id: WORKFLOW_ID });
    expect(registry.currentEpoch(WORKFLOW_ID)).not.toBeNull();

    storage.failNextStateRead = true;
    await engine.flushInlineLaunches();
    expect(storage.stateReadFailures).toBe(1);
    expect(probe.runs).toBe(0);
    expect(
      warnings.map((warning) => [warning.source, warning.workflowId, warning.error.message]),
    ).toEqual([['inline-launch', WORKFLOW_ID, FLUSH_FAILURE]]);

    // In memory the engine no longer holds the run; durably it is running and ownerless, which is
    // what the reclaim scan looks for.
    expect(internals.checkpoints.has(WORKFLOW_ID)).toBe(false);
    expect(currentExecutionAttempt(internals, WORKFLOW_ID)).toBeUndefined();
    expect(hasQueuedOrLaunchingInlineWorkflowStart(internals, WORKFLOW_ID)).toBe(false);
    expect(registry.currentEpoch(WORKFLOW_ID)).toBeNull();
    expect(await storage.get(KEYS.workflowOwnerHolder(WORKFLOW_ID))).toBeNull();

    const pass = await internals.workflowClaimRenewalTask!.runOnce();
    expect(pass.reclaim).toMatchObject(RECLAIMED);
    await waitForCondition(() => probe.runs === 1, { label: 'the reclaim drives the run' });
    expect(await engine.getHandle(WORKFLOW_ID).result()).toBe('ran');
    expect(probe.runs).toBe(1);
  });
});
