/**
 * What a reclaim's forced replay checks just before it restarts a workflow (COR-1618), forced
 * through the reclaim gate and a storage read a test holds:
 *
 * - the claim epoch is read again after the gate, so a claim lost and taken back during the
 *   reclaim's awaits is checked against the claim held now;
 * - the check shares its synchronous turn with the replay's join-or-register decision, so a drive
 *   that began while the replay was reading the workflow's state is not driven a second time;
 * - the check names the generation it is replaying, so a drive of another generation under the same
 *   claim does not stop the replay.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { waitForCondition } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { KEYS } from '../../storage/keys.ts';
import { encode } from '../codec.ts';
import { getInternals } from './internals.ts';
import {
  createRecoveringEngine,
  EXPIRED_AFTER_MS,
  letOtherDrivesStart,
  probeFor,
  strandWorkflow,
} from './reclaim-race.test-support.ts';
import { decodeWorkflowState } from './validation.ts';

const WORKFLOW_ID = 'recheck-run';

/** Holds the Nth read of the run's stored state once armed, until a test releases it. */
class HoldingReadStorage extends MemoryStorage {
  /** Which read of the run's state to hold, counted from arming; `null` while disarmed. */
  holdRead: number | null = null;
  /** Runs while the read is held, before it reads, so a test can change what it will see. */
  whileHeld: (() => Promise<void>) | null = null;
  readonly reachedHold = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();
  #reads = 0;

  override async get(key: string): Promise<Uint8Array | null> {
    if (this.holdRead !== null && key === KEYS.workflow(WORKFLOW_ID)) {
      this.#reads++;
      if (this.#reads === this.holdRead) {
        this.reachedHold.resolve();
        await this.release.promise;
        await this.whileHeld?.();
      }
    }
    return super.get(key);
  }
}

async function holdReclaimAtGate(storage: HoldingReadStorage) {
  const startNow = 9_000_000;
  await strandWorkflow(storage, () => startNow, WORKFLOW_ID, false);
  const probe = probeFor(storage);
  probe.hold = Promise.withResolvers<void>();
  const recovering = await createRecoveringEngine(storage, startNow + EXPIRED_AFTER_MS, false);
  const internals = getInternals(recovering.engine);
  const reclaimGate = Promise.withResolvers<void>();
  const reachedGate = Promise.withResolvers<void>();
  internals.reclaimReplayGateForTesting = () => {
    reachedGate.resolve();
    return reclaimGate.promise;
  };
  const reclaimPass = internals.workflowClaimRenewalTask!.runOnce();
  await reachedGate.promise;
  return { ...recovering, internals, probe, reclaimGate, reclaimPass };
}

describe('a reclaim replay re-checks for a drive just before it restarts the workflow', () => {
  it('checks against the claim held after the gate when the claim was lost and taken back', async () => {
    const storage = new HoldingReadStorage();
    const held = await holdReclaimAtGate(storage);
    await using engine = held.engine;
    const registry = held.internals.workflowClaimRegistry!;
    const claimOnEntry = registry.currentEpoch(WORKFLOW_ID)!;

    // The claim is lost and taken back while the reclaim waits: `recoverAll()` acquires a new one
    // and drives the run under it.
    await registry.release(WORKFLOW_ID, claimOnEntry);
    const recovery = engine.recoverAll();
    await waitForCondition(() => held.probe.runs === 1, { label: 'the drive under the new claim' });
    expect(registry.currentEpoch(WORKFLOW_ID)).toBeGreaterThan(claimOnEntry);

    held.reclaimGate.resolve();
    await letOtherDrivesStart();
    held.probe.hold?.resolve();
    await Promise.all([held.reclaimPass, recovery]);
    expect(await engine.getHandle(WORKFLOW_ID).result()).toBe('ran');
    expect(held.probe.runs).toBe(1);
  });

  it('skips a drive that began while the replay was reading the key it decides on', async () => {
    const storage = new HoldingReadStorage();
    const held = await holdReclaimAtGate(storage);
    await using engine = held.engine;

    // The replay reads the run's state twice, in `resume()` and then in
    // `resumeWorkflowFromStorage`, and decides on what the second read returns. Hold that one.
    storage.holdRead = 2;
    held.reclaimGate.resolve();
    await storage.reachedHold.promise;

    // `recoverAll()` drives the run to its activity while the replay is held.
    const recovery = engine.recoverAll();
    await waitForCondition(() => held.probe.runs === 1, { label: "recoverAll()'s drive" });
    await recovery;

    storage.release.resolve();
    await letOtherDrivesStart();
    held.probe.hold?.resolve();
    await held.reclaimPass;
    expect(await engine.getHandle(WORKFLOW_ID).result()).toBe('ran');
    expect(held.probe.runs).toBe(1);
  });

  it('replays when the drive under the claim is of another generation', async () => {
    const storage = new HoldingReadStorage();
    const held = await holdReclaimAtGate(storage);
    await using engine = held.engine;

    storage.holdRead = 2;
    held.reclaimGate.resolve();
    await storage.reachedHold.promise;
    const recovery = engine.recoverAll();
    await waitForCondition(() => held.probe.runs === 1, { label: "recoverAll()'s drive" });
    await recovery;

    // The id is now a different generation than the one the drive under the claim launched.
    storage.whileHeld = async () => {
      const bytes = (await storage.get(KEYS.workflow(WORKFLOW_ID)))!;
      const state = decodeWorkflowState(bytes);
      await storage.put(
        KEYS.workflow(WORKFLOW_ID),
        encode({ ...state, workflowExecutionToken: 'replacement-generation' }),
      );
    };
    storage.release.resolve();
    await letOtherDrivesStart();
    held.probe.hold?.resolve();
    await held.reclaimPass;
    // The replay went on to drive the other generation, which is not what the first drive runs.
    await waitForCondition(() => held.probe.runs === 2, { label: 'the replay drives the run' });
  });
});
