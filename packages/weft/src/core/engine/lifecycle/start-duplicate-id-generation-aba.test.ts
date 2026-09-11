/**
 * WFT-153: the residual ABA hole the WFT-152 duplicate-id fence left open.
 *
 * `start-terminal-conflict-purge.ts`'s duplicate-id `conditionalBatch`
 * precondition (WFT-152) compares the observed `wf:<id>` VALUE, so it cannot
 * tell "this id was never used" from "a run existed here and was purged". If
 * a racing winner completes and is PURGED before a slower loser's create
 * batch commits, `wf:<id>` looks absent again, the value-only condition
 * matches, and — before this fix — both starts would execute.
 *
 * This test builds the exact interleaving deterministically rather than
 * relying on timing: a stallable storage wrapper holds engine B's
 * duplicate-id read open (via a stalled `get()` on the workflow key) until
 * engine A has started, completed, AND purged the SAME explicit id — durably
 * bumping `wf-gen:<id>` in the process. Only once that has happened does B's
 * read resolve and its create batch commit, so its `duplicateIdGenerationCondition`
 * (captured from the pre-purge, never-used generation) is checked against the
 * now-bumped live value and loses the CAS.
 *
 * `recover: false` on both engines keeps boot-time recovery out of the race,
 * matching `start-duplicate-id-race.test.ts`'s WFT-152 harness.
 *
 * Stalls `get()` rather than `conditionalBatch()` directly: the CAS itself is
 * checked against LIVE storage at commit time regardless of when its own
 * preconditions were READ, so what matters for this scenario is only that B's
 * observed generation value is captured BEFORE A's purge — stalling the read
 * that captures it is equivalent to (and simpler than) stalling the later
 * commit call, and this is what a "stall the next `conditionalBatch` call"
 * harness would need to gate on anyway (B's create-batch `conditionalBatch`
 * touches several keys, none of which uniquely identify "B's commit" the way
 * B's own duplicate-id read on `workflowKey` does).
 */
import { describe, expect, it } from 'bun:test';

import { KEYS, type Storage } from '../../../storage/interface.ts';
import { MemoryStorage } from '../../../storage/memory.ts';
import { waitForCondition } from '../../../testing/fake-timers.test-support.ts';
import { workflow, type WorkflowContext } from '../../types.ts';
import { WorkflowAlreadyExistsError } from '../errors.ts';
import { Engine } from '../index.ts';

const abaWorkflow = workflow({ name: 'aba-race' }).execute(async function* (ctx: WorkflowContext) {
  return yield* ctx.run(() => 'ran');
});

const workflows = { 'aba-race': abaWorkflow };

/**
 * Wraps a real `Storage` and lets a test stall the NEXT `get()` call for one
 * specific key until `release()` is called. Everything else passes straight
 * through to the wrapped storage, and — crucially — is bound to the real
 * instance rather than the proxy, so `MemoryStorage`'s private fields resolve
 * correctly under method-call syntax.
 */
function createStallableStorage(inner: Storage): {
  storage: Storage;
  stallNextGet: (key: string) => void;
  stalledCount: () => number;
  release: () => void;
} {
  let stallKey: string | null = null;
  let gate: Promise<void> | null = null;
  let releaseGate: (() => void) | null = null;
  let stalledCount = 0;

  const storage = new Proxy(inner, {
    get(target, prop, _receiver) {
      if (prop === 'get') {
        return async (key: string): Promise<Uint8Array | null> => {
          if (key === stallKey && gate !== null) {
            stalledCount += 1;
            const heldGate = gate;
            stallKey = null;
            gate = null;
            await heldGate;
          }
          return target.get(key);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return {
    storage,
    stallNextGet: (key: string) => {
      stallKey = key;
      gate = new Promise((resolve) => {
        releaseGate = resolve;
      });
    },
    stalledCount: () => stalledCount,
    release: () => releaseGate?.(),
  };
}

describe('WFT-153: explicit-id start fence pre-CAS ABA (purge between read and commit)', () => {
  it('the loser fails its CAS once the winner has completed and purged, instead of creating a duplicate run', async () => {
    const workflowId = `aba-race-${crypto.randomUUID()}`;
    const workflowKey = KEYS.workflow(workflowId);
    const generationKey = KEYS.workflowGeneration(workflowId);

    const baseStorage = new MemoryStorage();
    const stall = createStallableStorage(baseStorage);

    await using engineA = await Engine.create({
      storage: stall.storage,
      workflows,
      recover: false,
    });
    await using engineB = await Engine.create({
      storage: stall.storage,
      workflows,
      recover: false,
    });

    // Arm the stall BEFORE engine B's start call reaches its duplicate-id read,
    // so that read is guaranteed to observe "never used" (both `wf:<id>` and
    // `wf-gen:<id>` absent) — the state that existed before engine A ever ran.
    stall.stallNextGet(workflowKey);
    const loserPromise = engineB.start('aba-race', null, { id: workflowId });

    // Deterministically wait for B's read to actually be parked on the stall,
    // rather than assuming an interleaving from timing.
    await waitForCondition(() => stall.stalledCount() === 1, {
      label: 'engine B duplicate-id read stalled',
    });

    // Engine A now starts, completes, and purges the SAME id — entirely while
    // B's read is parked. The purge bumps `wf-gen:<id>` from absent to `1` in
    // the same atomic batch that deletes `wf:<id>`.
    const winner = await engineA.start('aba-race', null, { id: workflowId });
    await winner.result();
    const generationBeforePurge = await baseStorage.get(generationKey);
    expect(generationBeforePurge).toBeNull();
    const purgeResult = await engineA.purge({ idPrefix: workflowId });
    expect(purgeResult.deleted).toBe(1);
    const generationAfterPurge = await baseStorage.get(generationKey);
    expect(generationAfterPurge).not.toBeNull();

    // Release B's stalled read. `wf:<id>` is absent again (post-purge), so its
    // VALUE-only duplicate-id condition would match — but `wf-gen:<id>` has
    // moved, so `duplicateIdGenerationCondition` (captured pre-purge, as
    // "never used") now loses the CAS.
    stall.release();

    await expect(loserPromise).rejects.toBeInstanceOf(WorkflowAlreadyExistsError);

    // No duplicate run was left behind: the id is free again, exactly as the
    // winner's purge left it.
    expect(await engineA.get(workflowId)).toBeNull();
  });
});

describe('WFT-153: onTerminalConflict "start-new" reads the post-bump generation for its OWN restart', () => {
  it('two successive start-new restarts of the same id both succeed, and the generation strictly increases', async () => {
    const workflowId = `aba-restart-${crypto.randomUUID()}`;
    const generationKey = KEYS.workflowGeneration(workflowId);
    const storage = new MemoryStorage();
    await using engine = await Engine.create({ storage, workflows, recover: false });

    // A restart's own displacing purge conditions AND bumps `wf-gen:<id>` in the
    // SAME create-batch commit. If that CAS were built from the wrong (already
    // post-bump) value, this restart would incorrectly fence itself out on its
    // own legitimate restart — the exact bug WFT-153's design has to avoid.
    const first = await engine.start('aba-race', null, { id: workflowId });
    await first.result();
    expect(await storage.get(generationKey)).toBeNull();

    const second = await engine.start('aba-race', null, {
      id: workflowId,
      onTerminalConflict: 'start-new',
    });
    await second.result();
    const generationAfterFirstRestart = await storage.get(generationKey);
    expect(generationAfterFirstRestart).not.toBeNull();

    const third = await engine.start('aba-race', null, {
      id: workflowId,
      onTerminalConflict: 'start-new',
    });
    await third.result();
    const generationAfterSecondRestart = await storage.get(generationKey);
    expect(generationAfterSecondRestart).not.toBeNull();
    expect(generationAfterSecondRestart).not.toEqual(generationAfterFirstRestart);

    const finalState = await engine.get(workflowId);
    expect(finalState?.status).toBe('completed');
  });
});
