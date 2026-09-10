/**
 * WFT-21, Codex review round 10, P1: `launchWorkflowFromCheckpoint()`
 * (`checkpoint-launch.ts`) — `fork()`'s only caller for driving a newly
 * planted run — set `internals.checkpoints` for the new generation but
 * never called `rememberCommittedCheckpointBytes()`, unlike `start()`
 * (round 5) and `resume()` (pre-existing). Without that priming, a fork's
 * FIRST checkpoint commit carried no `expectedSerialized` checkpoint-bytes
 * CAS precondition — the exact class of gap round 5 closed for `start()`
 * — leaving a window inside that first commit's own later awaits (e.g.
 * event-log compaction reading storage) where a concurrent cancel +
 * `start-new` replacement of the same workflow id could land, and a stale
 * commit for the displaced fork generation could silently overwrite the
 * replacement's checkpoint and history.
 *
 * This test verifies the mechanism directly and deterministically: right
 * after `fork()` returns, the forked workflow's committed-checkpoint-bytes
 * baseline must already be primed to the fork's own initial checkpoint
 * bytes — mirroring the exact assertion `resume.ts`'s equivalent priming
 * would satisfy. Before the fix, `getCommittedCheckpointBytes()` returned
 * `undefined` for a freshly-forked workflow id.
 */
import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../../storage/interface.ts';
import { MemoryStorage } from '../../../storage/memory.ts';
import { Engine } from '../../engine.ts';
import { workflow, type WorkflowContext } from '../../types.ts';
import { getCommittedCheckpointBytes } from '../checkpoint-commit-snapshots.ts';
import { getInternals } from '../internals.ts';

describe("fork()'s checkpoint-bytes CAS baseline — WFT-21 Codex review round 10 P1", () => {
  it("primes the forked workflow's committed-checkpoint-bytes baseline at launch, matching its own durably-committed initial checkpoint", async () => {
    const storage = new MemoryStorage();
    const type = 'fork-cas-baseline-race';
    const definition = workflow({ name: type, description: 'v1' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.waitForSignal<string>('go');
    });

    const engine = new Engine({ storage });
    try {
      engine.register(definition);
      const sourceHandle = await engine.start(type, null, { id: 'fork-cas-baseline-source' });

      const forkedHandle = await engine.fork(sourceHandle.id);
      const internals = getInternals(engine);

      // The fix: primed synchronously, inside `launchWorkflowFromCheckpoint()`,
      // before `fork()` ever returns — no quiescence wait needed.
      const primed = getCommittedCheckpointBytes(internals, forkedHandle.id);
      expect(primed).toBeDefined();

      const durablyCommitted = await storage.get(KEYS.checkpoint(forkedHandle.id));
      expect(durablyCommitted).not.toBeNull();
      expect(primed).toEqual(durablyCommitted!);

      await engine.signal(forkedHandle.id, 'go', 'done');
      await expect(forkedHandle.result()).resolves.toBe('done');
      await engine.signal(sourceHandle.id, 'go', 'done');
      await expect(sourceHandle.result()).resolves.toBe('done');
    } finally {
      engine[Symbol.dispose]();
    }
  });
});
