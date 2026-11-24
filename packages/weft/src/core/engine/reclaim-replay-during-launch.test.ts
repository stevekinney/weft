/**
 * A reclaim's replay that arrives while a resume of the same generation is in the middle of its
 * launch must join that resume, not start a second one (COR-1618). A resume that has adopted the
 * checkpoint is no longer joinable, and it is not yet a launched drive, so nothing a replay can
 * see in that interval would stop it: the resume therefore awaits nothing between adopting the
 * checkpoint and starting the generator, and does the one storage scan it needs before adopting.
 *
 * Drive A is `recoverAll()`'s resume, held in the scan of the run's child-cancellation records,
 * the only storage read of a resume that is not before its adoption's turn. The reclaim's replay
 * is released while A is held.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import { getInternals } from './internals.ts';
import {
  createRecoveringEngine,
  EXPIRED_AFTER_MS,
  letOtherDrivesStart,
  probeFor,
  strandWorkflow,
} from './reclaim-race.test-support.ts';

const WORKFLOW_ID = 'launch-window-run';

/** Holds the first scan of the run's child-cancellation records once armed, until released. */
class HoldingScanStorage extends MemoryStorage {
  armed = false;
  readonly reachedHold = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();

  override async *scan(
    prefix: string,
    options?: Parameters<MemoryStorage['scan']>[1],
  ): AsyncIterable<[string, Uint8Array]> {
    if (this.armed && prefix === KEYS.childCancellationPrefix(WORKFLOW_ID)) {
      this.armed = false;
      this.reachedHold.resolve();
      await this.release.promise;
    }
    yield* super.scan(prefix, options);
  }
}

describe('a reclaim replay that arrives while a resume is launching the generation', () => {
  it('joins that resume, so the activity runs once', async () => {
    const storage = new HoldingScanStorage();
    const startNow = 10_000_000;
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

    // Drive A, under the claim the reclaim took, is held in its scan.
    storage.armed = true;
    const recovery = engine.recoverAll();
    await storage.reachedHold.promise;
    expect(probe.runs).toBe(0);

    // The replay reaches its check while A is held, and every task it needs gets to run.
    reclaimGate.resolve();
    await letOtherDrivesStart();

    storage.release.resolve();
    await Promise.all([reclaimPass, recovery]);
    await letOtherDrivesStart();
    expect(await engine.getHandle(WORKFLOW_ID).result()).toBe('ran');
    expect(probe.runs).toBe(1);
  });
});
