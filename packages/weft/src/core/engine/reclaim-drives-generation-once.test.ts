/**
 * A claim takeover and `recoverAll()` both drive a workflow this engine has just come to hold.
 * The reclaim pass takes the dead owner's claim and then pauses (reloading pending async
 * activities) before it replays the workflow from storage; a `recoverAll()` that runs in that
 * pause resumes the same generation under the claim the reclaim already installed. The reclaim's
 * forced replay skips the local-ownership check `recoverAll()` makes, so unless it notices the
 * drive it would start a second one, and the activity would run twice (COR-1618).
 *
 * The reclaim is held at `reclaimReplayGateForTesting`, the one seam added for this, and the
 * store-backed counter counts how many times the activity ran. Each case must end with it at one.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { waitForCondition } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { getInternals } from './internals.ts';
import {
  createRecoveringEngine,
  EXPIRED_AFTER_MS,
  type Hold,
  letOtherDrivesStart,
  probeFor,
  strandWorkflow,
} from './reclaim-race.test-support.ts';

type Interleaving = {
  name: string;
  /** Hold the first `resolveWorkflowServices` call, so a resume stays before it adopts. */
  holdResolver: boolean;
  /** Hold the first activity, so a drive that adopted stays running. */
  holdActivity: boolean;
  /** Whether the reclaim's replay is released before `recoverAll()` starts. */
  releaseReclaimFirst: boolean;
};

const INTERLEAVINGS: Interleaving[] = [
  {
    name: 'drive A is held in resolveWorkflowServices, before it adopts',
    holdResolver: true,
    holdActivity: false,
    releaseReclaimFirst: false,
  },
  {
    name: 'drive A has adopted and is running',
    holdResolver: false,
    holdActivity: true,
    releaseReclaimFirst: false,
  },
  {
    name: "the reclaim's resume registered first",
    holdResolver: true,
    holdActivity: false,
    releaseReclaimFirst: true,
  },
];

describe('a claim takeover that races recoverAll() drives the generation once', () => {
  describe.each(INTERLEAVINGS)('$name', (interleaving) => {
    it('runs the activity exactly once', async () => {
      const storage = new MemoryStorage();
      const startNow = 5_000_000;
      await strandWorkflow(storage, () => startNow, 'raced-run', false);
      const probe = probeFor(storage);
      if (interleaving.holdActivity) probe.hold = Promise.withResolvers<void>();

      const recovering = await createRecoveringEngine(
        storage,
        startNow + EXPIRED_AFTER_MS,
        interleaving.holdResolver,
      );
      await using engine = recovering.engine;
      const internals = getInternals(engine);

      const reclaimGate = Promise.withResolvers<void>();
      const reclaimReachedGate = Promise.withResolvers<void>();
      internals.reclaimReplayGateForTesting = () => {
        reclaimReachedGate.resolve();
        return reclaimGate.promise;
      };

      // The reclaim takes the dead owner's claim and stops at the gate.
      const reclaimPass = internals.workflowClaimRenewalTask!.runOnce();
      await reclaimReachedGate.promise;
      expect(internals.workflowClaimRegistry!.currentEpoch('raced-run')).not.toBeNull();

      let recovery: Promise<unknown>;
      if (interleaving.releaseReclaimFirst) {
        // The reclaim's resume registers before `recoverAll()` looks.
        reclaimGate.resolve();
        await waitForCondition(() => recovering.resolver.calls === 1, {
          label: "the reclaim's resume is held in resolveWorkflowServices",
        });
        recovery = engine.recoverAll();
      } else {
        recovery = engine.recoverAll();
        await waitForCondition(
          () => (interleaving.holdResolver ? recovering.resolver.calls === 1 : probe.runs === 1),
          { label: 'drive A is held where the case needs it' },
        );
        reclaimGate.resolve();
      }
      await letOtherDrivesStart();
      recovering.resolver.hold?.resolve();
      await letOtherDrivesStart();
      probe.hold?.resolve();

      const [pass] = await Promise.all([reclaimPass, recovery]);
      expect(pass.reclaim).toMatchObject({ status: 'completed' });
      expect(await engine.getHandle('raced-run').result()).toBe('ran');
      expect(probe.runs).toBe(1);
    });
  });
});

/**
 * Holds the reclaim pass's last candidate scan (the bounded read of authoritative workflow
 * records, the only `wf:` scan that passes a limit) after the candidates of its earlier scans are
 * collected, so a test can run `recoverAll()` between the listing and the attempts.
 */
class ListingGatedStorage extends MemoryStorage {
  gate: Hold | null = null;
  readonly reachedGate = Promise.withResolvers<void>();

  override async *scan(
    prefix: string,
    options?: Parameters<MemoryStorage['scan']>[1],
  ): AsyncIterable<[string, Uint8Array]> {
    if (this.gate !== null && prefix === 'wf:' && options?.limit !== undefined) {
      this.reachedGate.resolve();
      await this.gate.promise;
    }
    yield* super.scan(prefix, options);
  }
}

type SiblingCase = {
  name: string;
  /** What the attempt does with the claim, and so what the activity count shows. */
  outcome: string;
  /** What lands on the engine between the listing and the attempt. */
  claimLandsAs: 'held-resume' | 'running-drive' | 'bare-claim';
};

const SIBLING_CASES: SiblingCase[] = [
  {
    name: "recoverAll()'s fresh claim is held in resolveWorkflowServices, before its drive adopts",
    outcome: 'redrives by joining the resume recoverAll() holds, so the run is driven once',
    claimLandsAs: 'held-resume',
  },
  {
    name: "recoverAll()'s fresh claim has a running drive",
    outcome: 'leaves the drive recoverAll() already runs alone, so the activity runs once',
    claimLandsAs: 'running-drive',
  },
  {
    name: 'a claim landed and nothing drives it yet',
    outcome: 'redrives the claim nothing drives, so the run completes and its activity runs once',
    claimLandsAs: 'bare-claim',
  },
];

describe('a held claim reaches attemptWorkflowClaimTakeover between listing and attempt', () => {
  describe.each(SIBLING_CASES)('$name', ({ claimLandsAs, outcome }) => {
    it(`the attempt ${outcome}`, async () => {
      const storage = new ListingGatedStorage();
      const startNow = 6_000_000;
      await strandWorkflow(storage, () => startNow, 'sibling-run', true);
      const probe = probeFor(storage);
      if (claimLandsAs === 'running-drive') probe.hold = Promise.withResolvers<void>();

      const recovering = await createRecoveringEngine(
        storage,
        startNow + EXPIRED_AFTER_MS,
        claimLandsAs === 'held-resume',
      );
      await using engine = recovering.engine;
      const internals = getInternals(engine);
      const registry = internals.workflowClaimRegistry!;
      expect(registry.currentEpoch('sibling-run')).toBeNull();

      // The candidate is listed while this engine does not hold it.
      storage.gate = Promise.withResolvers<void>();
      const reclaimPass = internals.workflowClaimRenewalTask!.runOnce();
      await storage.reachedGate.promise;
      expect(registry.currentEpoch('sibling-run')).toBeNull();

      let recovery: Promise<unknown> = Promise.resolve();
      if (claimLandsAs === 'bare-claim') {
        expect(await registry.acquire('sibling-run')).toMatchObject({ status: 'acquired' });
      } else {
        // `recoverAll()` acquires the claim, and then the attempt runs.
        recovery = engine.recoverAll();
        await waitForCondition(
          () =>
            claimLandsAs === 'held-resume' ? recovering.resolver.calls === 1 : probe.runs === 1,
          { label: "recoverAll()'s drive is where the case needs it" },
        );
      }
      storage.gate.resolve();
      await letOtherDrivesStart();
      recovering.resolver.hold?.resolve();
      await letOtherDrivesStart();
      probe.hold?.resolve();

      const [pass] = await Promise.all([reclaimPass, recovery]);
      expect(pass.reclaim).toMatchObject({
        status: 'completed',
        outcomes: [{ workflowId: 'sibling-run', status: 'reclaimed' }],
      });
      expect(await engine.getHandle('sibling-run').result()).toBe('ran');
      expect(probe.runs).toBe(1);
    });
  });
});
