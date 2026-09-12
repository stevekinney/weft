/**
 * Public per-workflow checkpoint-history pruning (WFT-137).
 *
 * Unlike the automatic keep-last-N in `checkpoint-io.ts` (one overflow
 * deletion per commit, driven by `EngineOptions.checkpointHistory`), this is
 * an on-demand, one-shot prune callable at any time — including on a
 * terminal workflow — through the storage adapter directly. It never touches
 * the live `wf:{id}:ckpt` checkpoint record, only the `wf:{id}:ckpt:{step}`
 * history entries read by `listCheckpoints()` / `getCheckpointAt()`.
 *
 * @module core/engine/checkpoint-prune
 */

import type { BatchOperation, ConditionalBatchCondition } from '../../storage/interface.ts';
import { KEYS, MAX_BATCH_OPERATIONS, storageKeys } from '../../storage/interface.ts';
import type { PruneCheckpointsOptions, PruneCheckpointsResult } from '../types/checkpoint.ts';
import { commitFencedEngineWrite } from './fenced-write.ts';
import type { EngineInternals } from './internals.ts';

function assertValidKeepLast(keepLast: number): void {
  if (!Number.isSafeInteger(keepLast) || keepLast < 0) {
    throw new Error(
      `pruneCheckpoints options.keepLast must be a non-negative integer, got ${keepLast}`,
    );
  }
}

/**
 * Enumerate a workflow's checkpoint history steps in ascending order, via
 * `storageKeys()` (the adapter's key-only shortcut when available) rather
 * than `storage.scan()`, so pruning does not download every checkpoint's
 * full serialized bytes just to read its step suffix.
 */
async function scanCheckpointHistorySteps(
  internals: EngineInternals,
  workflowId: string,
  signal: AbortSignal | undefined,
): Promise<number[]> {
  const prefix = `${KEYS.checkpoint(workflowId)}:`;
  const steps: number[] = [];
  for await (const key of storageKeys(internals.storage, prefix)) {
    signal?.throwIfAborted();
    const step = Number.parseInt(key.slice(prefix.length), 10);
    if (Number.isSafeInteger(step)) {
      steps.push(step);
    }
  }
  return steps;
}

/**
 * Delete `toDelete` checkpoint history entries in `MAX_BATCH_OPERATIONS`-sized
 * chunks, each fenced against a concurrent run replacement (`onTerminalConflict:
 * 'start-new'` reusing this workflow id): every chunk's batch is conditioned on
 * `fenceCheckpointBytes` — the live `wf:{id}:ckpt` record's bytes, captured by
 * the caller BEFORE it scanned history, not re-read here — on any backend that
 * reports `conditionalBatch`. A replacement purges and recreates that record
 * with different bytes at ANY point from before the scan through this delete,
 * so the condition fails closed and the stale delete list — computed against
 * the OLD run's steps, which the new run can revisit from step 1 — never
 * lands on the new run's checkpoints. Re-reading the anchor here instead of
 * reusing the pre-scan capture would reopen exactly that window: a
 * replacement landing during the scan would already be reflected in a
 * fresh read, so it would wrongly become the CAS baseline instead of failing
 * the fence.
 *
 * Bounded per-key deletes inside a fenced batch — not `storageDeleteRange()` —
 * are deliberate: `storageDeleteRange()` is a standalone, unconditioned
 * storage operation with no way to carry the CAS condition above, and this
 * repository's own precedent for a bounded, fencing-sensitive historical
 * cleanup (event-log compaction) folds bounded per-key deletes into one atomic
 * conditioned batch for the same reason.
 *
 * Under `ownership: 'lease'` / `'workflow-lease'`, this also rides the
 * engine's own epoch fence via `commitFencedEngineWrite`; passing
 * `workflowId: null` (an engine-scoped write, not a per-workflow-claim write)
 * is deliberate — a terminal workflow is not expected to still be claimed by
 * any engine, and fencing on its claim epoch would spuriously depose an
 * engine that simply never held (or already released) that claim.
 */
async function deleteCheckpointHistoryEntries(
  internals: EngineInternals,
  workflowId: string,
  toDelete: readonly number[],
  fenceCheckpointBytes: Uint8Array | null,
): Promise<void> {
  const canFence = internals.storage.capabilities().conditionalBatch;
  const baseConditions: ConditionalBatchCondition[] = canFence
    ? [{ key: KEYS.checkpoint(workflowId), expectedValue: fenceCheckpointBytes }]
    : [];

  for (let index = 0; index < toDelete.length; index += MAX_BATCH_OPERATIONS) {
    const chunk = toDelete.slice(index, index + MAX_BATCH_OPERATIONS);
    const operations: BatchOperation[] = chunk.map((step) => ({
      type: 'delete',
      key: KEYS.checkpointHistory(workflowId, step),
    }));
    await commitFencedEngineWrite(internals, null, operations, baseConditions, () => {
      return new Error(
        `pruneCheckpoints for workflow "${workflowId}" lost its CAS race against a concurrent run replacement.`,
      );
    });
  }
}

/**
 * Delete all but the newest `keepLast` checkpoint history entries for one
 * workflow.
 *
 * Safe to call on a terminal workflow. A no-op — `{ removed: 0, retained: 0
 * }`, never a throw — when the workflow has no checkpoint history entries at
 * all, whether because the workflow id is unknown or because
 * `EngineOptions.checkpointHistory` was never enabled for it. Rejects with
 * whatever error the storage adapter rejects with when a delete batch fails,
 * and honors `options.signal` by throwing its abort reason before issuing any
 * delete — once the first delete chunk commits (see
 * {@link deleteCheckpointHistoryEntries}), the prune runs to completion rather
 * than stopping partway with some, but not all, overflow entries removed.
 *
 * The fence anchor (the live `wf:{id}:ckpt` record's bytes) is captured
 * BEFORE the history scan, not after: capturing it later would let a
 * replacement that lands during the scan slip in as the CAS baseline instead
 * of being caught by it, reopening the exact race
 * {@link deleteCheckpointHistoryEntries} exists to close.
 */
export async function pruneCheckpoints(
  internals: EngineInternals,
  workflowId: string,
  options: PruneCheckpointsOptions,
): Promise<PruneCheckpointsResult> {
  const { keepLast, signal } = options;
  assertValidKeepLast(keepLast);
  signal?.throwIfAborted();

  const fenceCheckpointBytes = await internals.storage.get(KEYS.checkpoint(workflowId));
  const steps = await scanCheckpointHistorySteps(internals, workflowId, signal);

  // `scanCheckpointHistorySteps()` returns ascending numeric order already
  // (the zero-padded, fixed-width step suffix sorts that way); the newest
  // entries are the tail.
  const toDelete = steps.slice(0, Math.max(0, steps.length - keepLast));
  if (toDelete.length === 0) {
    return { removed: 0, retained: steps.length };
  }

  signal?.throwIfAborted();
  await deleteCheckpointHistoryEntries(internals, workflowId, toDelete, fenceCheckpointBytes);

  return { removed: toDelete.length, retained: steps.length - toDelete.length };
}
