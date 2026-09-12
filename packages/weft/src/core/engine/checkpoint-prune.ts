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

import type { BatchOperation } from '../../storage/interface.ts';
import { KEYS, MAX_BATCH_OPERATIONS } from '../../storage/interface.ts';
import type { PruneCheckpointsOptions, PruneCheckpointsResult } from '../types/checkpoint.ts';
import type { EngineInternals } from './internals.ts';

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
 * delete.
 */
export async function pruneCheckpoints(
  internals: EngineInternals,
  workflowId: string,
  options: PruneCheckpointsOptions,
): Promise<PruneCheckpointsResult> {
  const { keepLast, signal } = options;
  if (!Number.isSafeInteger(keepLast) || keepLast < 0) {
    throw new Error(
      `pruneCheckpoints options.keepLast must be a non-negative integer, got ${keepLast}`,
    );
  }
  signal?.throwIfAborted();

  const prefix = `${KEYS.checkpoint(workflowId)}:`;
  const steps: number[] = [];
  for await (const [key] of internals.storage.scan(prefix)) {
    signal?.throwIfAborted();
    const step = Number.parseInt(key.slice(prefix.length), 10);
    if (Number.isSafeInteger(step)) {
      steps.push(step);
    }
  }

  // `scan()` over the zero-padded, fixed-width step suffix yields ascending
  // numeric order already; the newest entries are the tail.
  const toDelete = steps.slice(0, Math.max(0, steps.length - keepLast));
  if (toDelete.length === 0) {
    return { removed: 0, retained: steps.length };
  }

  for (let index = 0; index < toDelete.length; index += MAX_BATCH_OPERATIONS) {
    signal?.throwIfAborted();
    const chunk = toDelete.slice(index, index + MAX_BATCH_OPERATIONS);
    const operations: BatchOperation[] = chunk.map((step) => ({
      type: 'delete',
      key: KEYS.checkpointHistory(workflowId, step),
    }));
    await internals.storage.batch(operations);
  }

  return { removed: toDelete.length, retained: steps.length - toDelete.length };
}
