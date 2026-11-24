/**
 * A launch that adopted a workflow's checkpoint and then failed before its generator or worker
 * started is not a live drive (COR-1618). The reclaim skips a replay when a drive already began
 * under the claim it took, so the skip must not fire for a launch that never got going: the
 * reclaim target records the failed drive for redrive at the claim's epoch, and the next pass has
 * to drive the run, not report it reclaimed with nothing running under a claim it keeps renewing.
 *
 * The launch is failed once with a transient storage error on the scan of the run's child
 * cancellation records, the first read after adoption (`rehydrateChildCancellationHandlers`).
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { waitForCondition } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { rejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { KEYS } from '../../storage/keys.ts';
import { currentExecutionAttempt } from './execution-attempts.ts';
import { getInternals } from './internals.ts';
import {
  createRecoveringEngine,
  EXPIRED_AFTER_MS,
  probeFor,
  strandWorkflow,
} from './reclaim-race.test-support.ts';

const WORKFLOW_ID = 'failed-launch-run';

/** Fails the first scan of the run's child-cancellation records, once armed. */
class FailingRelaunchStorage extends MemoryStorage {
  armed = false;
  failures = 0;

  override async *scan(
    prefix: string,
    options?: Parameters<MemoryStorage['scan']>[1],
  ): AsyncIterable<[string, Uint8Array]> {
    if (this.armed && prefix === KEYS.childCancellationPrefix(WORKFLOW_ID)) {
      this.armed = false;
      this.failures++;
      throw new Error('transient storage error after adoption');
    }
    yield* super.scan(prefix, options);
  }
}

describe('a drive that adopted and failed before it launched is redriven', () => {
  it("drives the run on the reclaim's next pass when the reclaim's own replay failed", async () => {
    const storage = new FailingRelaunchStorage();
    const startNow = 7_000_000;
    await strandWorkflow(storage, () => startNow, WORKFLOW_ID, false);
    const probe = probeFor(storage);
    const recovering = await createRecoveringEngine(storage, startNow + EXPIRED_AFTER_MS, false);
    await using engine = recovering.engine;
    const internals = getInternals(engine);
    const registry = internals.workflowClaimRegistry!;

    storage.armed = true;
    const first = await internals.workflowClaimRenewalTask!.runOnce();
    expect(storage.failures).toBe(1);
    expect(first.reclaim).toMatchObject({
      status: 'completed',
      outcomes: [{ workflowId: WORKFLOW_ID, status: 'error' }],
    });
    expect(registry.currentEpoch(WORKFLOW_ID)).not.toBeNull();
    // The scan is before adoption, so the failed resume leaves no attempt behind.
    expect(currentExecutionAttempt(internals, WORKFLOW_ID)).toBeUndefined();
    expect(probe.runs).toBe(0);

    const second = await internals.workflowClaimRenewalTask!.runOnce();
    expect(second.reclaim).toMatchObject({
      status: 'completed',
      outcomes: [{ workflowId: WORKFLOW_ID, status: 'reclaimed' }],
    });
    await waitForCondition(() => probe.runs === 1, { label: 'the redrive runs the activity' });
    expect(await engine.getHandle(WORKFLOW_ID).result()).toBe('ran');
    expect(probe.runs).toBe(1);
  });

  it("still drives the run when recoverAll()'s drive adopted under the reclaim's claim and failed", async () => {
    const storage = new FailingRelaunchStorage();
    const startNow = 8_000_000;
    await strandWorkflow(storage, () => startNow, WORKFLOW_ID, false);
    const probe = probeFor(storage);
    const recovering = await createRecoveringEngine(storage, startNow + EXPIRED_AFTER_MS, false);
    await using engine = recovering.engine;
    const internals = getInternals(engine);

    const reclaimGate = Promise.withResolvers<void>();
    const reclaimReachedGate = Promise.withResolvers<void>();
    internals.reclaimReplayGateForTesting = () => {
      reclaimReachedGate.resolve();
      return reclaimGate.promise;
    };
    const reclaimPass = internals.workflowClaimRenewalTask!.runOnce();
    await reclaimReachedGate.promise;

    // recoverAll()'s drive resumes under the claim the reclaim took, adopts, and then fails.
    storage.armed = true;
    await rejectionOf(engine.recoverAll());
    expect(storage.failures).toBe(1);
    expect(probe.runs).toBe(0);

    // The reclaim's replay must not take that failed launch for a live drive.
    reclaimGate.resolve();
    const pass = await reclaimPass;
    expect(pass.reclaim).toMatchObject({
      status: 'completed',
      outcomes: [{ workflowId: WORKFLOW_ID, status: 'reclaimed' }],
    });
    await waitForCondition(() => probe.runs === 1, {
      label: "the reclaim's replay runs the activity",
    });
    expect(await engine.getHandle(WORKFLOW_ID).result()).toBe('ran');
    expect(probe.runs).toBe(1);
  });
});
