/**
 * WFT-21, Codex review round 5, P1: `persistWorkerCheckpoint()`'s round-4
 * fix (reattaching the HOST's own `workflowExecutionToken` rather than
 * trusting the worker-returned bytes) read the host's current
 * `WorkflowState` via an AWAITED storage read (`loadWorkflowState()`). That
 * await was itself a window: a concurrent cancel + `start-new` REPLACEMENT
 * of the same workflow ID could commit its own fresh generation while this
 * read was in flight, so the read returned the REPLACEMENT's token and
 * stamped it onto the STALE worker's checkpoint — which could then pass
 * the checkpoint-bytes CAS (`expectedSerialized`, now primed at every
 * launch including `start()`'s own `rememberCommittedCheckpointBytes()`
 * call) and silently overwrite the replacement's own checkpoint and
 * history with the OLD generation's stale content.
 *
 * The fix reads `internals.checkpoints.get(workflowId)` SYNCHRONOUSLY
 * instead — the host's own in-memory record of the CURRENT generation,
 * updated by every launch (`start()`, fork, `resume()`) before any worker
 * could ever be dispatched work for that generation, with no yield point
 * for a concurrent replacement to land inside. A stale worker's checkpoint
 * arriving for a workflow ID whose generation has already moved on is now
 * rejected outright, never silently reattached to the new generation.
 *
 * This test reproduces the vulnerability directly: no gating is needed,
 * since the bug is reproducible by simple sequencing — commit a genuine
 * `start-new` replacement first, THEN attempt to commit a stale worker
 * checkpoint captured from the OLD generation. Before the fix, the awaited
 * `loadWorkflowState()` read (called AFTER the replacement fully
 * committed) returned the replacement's own state regardless of ordering,
 * reproducing the identical race outcome without needing precise
 * interleaving.
 */
import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { deserializeCheckpoint, serializeCheckpoint } from '../checkpoint.ts';
import type { ContextOperationRequest } from '../context.ts';
import { Engine } from '../engine.ts';
import { workflow, type SearchAttributeValue, type WorkflowContext } from '../types.ts';
import { persistCheckpoint, type PersistCheckpointCallbacks } from './checkpoint-io.ts';
import { getInternals } from './internals.ts';

const staleWorkerOperation: ContextOperationRequest = {
  type: 'sleep',
  operationId: 'stale-worker-operation',
  duration: 1_000,
  scheduledFireAt: 2_000,
};

function createStaleWorkerPersistCallbacks(workflowId: string): PersistCheckpointCallbacks {
  return {
    appendTimelineBatchOperations: (_workflowId, _operation, step, timestamp, operations) => {
      operations.push({
        type: 'put',
        key: KEYS.timeline(workflowId, step),
        value: new Uint8Array([step]),
      });
      return { startedAt: timestamp, entry: { step } as never };
    },
    dispatchEvent: () => {},
    enforceHistoryCircuitBreaker: async () => {},
    pruneCheckpointHistory: async () => {},
    swallowPromiseRejection: async (promise: Promise<void>) => {
      await promise;
    },
    validateAttributeValueSizes: (_attributes: Record<string, SearchAttributeValue>) => {},
  };
}

/**
 * A `Uint8Array`'s own `.buffer` can be a larger, shared backing
 * `ArrayBuffer` (e.g. when it's a subview) — passing it straight through as
 * "worker checkpoint bytes" then decodes extra trailing bytes. Copy into an
 * exactly-sized buffer first, matching `checkpoint-io.test.ts`'s own
 * `serializeCheckpointBuffer()` helper.
 */
function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/**
 * `engine.start()` resolves once the run is durably CREATED, not once the
 * inline strategy has finished driving its generator to the first park
 * point — that drive continues asynchronously afterward (observed: a
 * `waitForSignal` run's checkpoint genuinely advances step 0 -> 1 in the
 * background shortly after `start()` returns). Poll until two consecutive
 * reads of the checkpoint key are byte-identical, so this test's own
 * "before" snapshot is captured only once that unrelated background
 * advance has settled — otherwise it would be indistinguishable from the
 * exact overwrite this test exists to catch.
 */
async function waitForCheckpointQuiescence(
  storage: MemoryStorage,
  workflowId: string,
): Promise<Uint8Array> {
  let previous = await storage.get(KEYS.checkpoint(workflowId));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const current = await storage.get(KEYS.checkpoint(workflowId));
    if (
      previous !== null &&
      current !== null &&
      Buffer.from(current).equals(Buffer.from(previous))
    ) {
      return current;
    }
    previous = current;
  }
  throw new Error(`checkpoint for "${workflowId}" never settled`);
}

describe('persistWorkerCheckpoint vs. a start-new replacement — WFT-21 Codex review round 5 P1', () => {
  it("rejects a stale worker checkpoint whose generation has already been replaced, rather than silently reattaching the REPLACEMENT's token and overwriting its checkpoint", async () => {
    const storage = new MemoryStorage();
    const type = 'worker-token-race';
    const definition = workflow({ name: type, description: 'v1' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.waitForSignal<string>('go');
    });

    const engine = new Engine({ storage });
    try {
      engine.register(definition);
      const originalHandle = await engine.start(type, null, { id: 'worker-token-race-id' });
      const internals = getInternals(engine);

      // A worker produced (but has not yet reported) a checkpoint for the
      // ORIGINAL generation — captured here from the genuine initial
      // checkpoint this run's own `start()` committed.
      const originalCheckpointBytes = await storage.get(KEYS.checkpoint(originalHandle.id));
      expect(originalCheckpointBytes).not.toBeNull();
      const staleCheckpoint = deserializeCheckpoint(originalCheckpointBytes!);
      staleCheckpoint.step = 1;
      // `staleCheckpoint.workflowExecutionToken` is left exactly as the
      // host itself stamped it at `start()` — the realistic case: the
      // worker's own bytes genuinely carry the ORIGINAL generation's real
      // token, which is precisely what lets the host detect the mismatch
      // below (comparison only, never persisted as-is).
      expect(staleCheckpoint.workflowExecutionToken).toBeDefined();

      // Cancel, then `start-new` REPLACES this exact workflow ID with a
      // fresh generation — a new `workflowExecutionToken`, a fresh initial
      // checkpoint, all durably committed.
      await engine.cancel(originalHandle.id);
      const replacedHandle = await engine.start(type, null, {
        id: 'worker-token-race-id',
        onTerminalConflict: 'start-new',
      });
      expect(replacedHandle.id).toBe(originalHandle.id);

      // `start()` resolves once the run is durably created, not once the
      // inline strategy has finished driving its FIRST turn (queued via a
      // macrotask — see `waitForCheckpointQuiescence()`'s own doc) — wait
      // for that unrelated background advance to settle first, so it can
      // never be confused with the overwrite this test exists to catch.
      const replacementCheckpointBefore = await waitForCheckpointQuiescence(
        storage,
        replacedHandle.id,
      );
      expect(replacementCheckpointBefore).not.toEqual(originalCheckpointBytes);

      // The stale worker's late checkpoint commit for the OLD generation
      // now arrives. Before the fix, this silently succeeded, stamping the
      // REPLACEMENT's own token onto the stale bytes and overwriting its
      // checkpoint. After the fix, it must be rejected outright, with THIS
      // specific message — a tight match so a downstream throw (e.g. an
      // unrelated timeline/feed error after the write already landed)
      // could never masquerade as the fence itself having worked.
      await expect(
        persistCheckpoint(
          internals,
          originalHandle.id,
          staleWorkerOperation,
          toExactArrayBuffer(serializeCheckpoint(staleCheckpoint)),
          createStaleWorkerPersistCallbacks(originalHandle.id),
        ),
      ).rejects.toThrow('targets a different execution generation');

      // The replacement's own checkpoint is untouched.
      const replacementCheckpointAfter = await storage.get(KEYS.checkpoint(replacedHandle.id));
      expect(replacementCheckpointAfter).toEqual(replacementCheckpointBefore);

      await engine.signal(replacedHandle.id, 'go', 'done');
      await expect(replacedHandle.result()).resolves.toBe('done');
    } finally {
      engine[Symbol.dispose]();
    }
  });
});
