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
import { KEYS, MAX_BATCH_OPERATIONS, storageKeys } from '../../storage/interface.ts';
import { deserializeCheckpoint } from '../checkpoint.ts';
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

/** Read the live checkpoint's stable per-run identity, when present. */
async function readWorkflowExecutionToken(
  internals: EngineInternals,
  workflowId: string,
): Promise<string | undefined> {
  const bytes = await internals.storage.get(KEYS.checkpoint(workflowId));
  if (bytes === null) return undefined;
  return deserializeCheckpoint(bytes).workflowExecutionToken;
}

/**
 * Delete bounded chunks, conditioning each atomic batch on the permanent
 * workflow generation bytes captured before scanning. Purge and start-new
 * replacement bump that key atomically; ordinary checkpoint progress does not.
 * An absent generation is fenced as absent. The execution-token re-read also
 * rejects replacement observed before the destructive phase.
 *
 * Passing workflowId: null preserves engine lease fencing without requiring a
 * workflow claim, since terminal workflows may have released their claims.
 * Storage without conditionalBatch support rejects before deleting history.
 */
async function deleteCheckpointHistoryEntries(
  internals: EngineInternals,
  workflowId: string,
  toDelete: readonly number[],
  anchorToken: string | undefined,
  anchorGeneration: Uint8Array | null,
): Promise<void> {
  if (anchorToken !== undefined) {
    const currentToken = await readWorkflowExecutionToken(internals, workflowId);
    if (currentToken !== anchorToken) {
      throw new Error(
        `pruneCheckpoints for workflow "${workflowId}" lost its race against a concurrent run replacement.`,
      );
    }
  }

  for (let index = 0; index < toDelete.length; index += MAX_BATCH_OPERATIONS) {
    const chunk = toDelete.slice(index, index + MAX_BATCH_OPERATIONS);
    const operations: BatchOperation[] = chunk.map((step) => ({
      type: 'delete',
      key: KEYS.checkpointHistory(workflowId, step),
    }));
    await commitFencedEngineWrite(
      internals,
      null,
      operations,
      [{ key: KEYS.workflowGeneration(workflowId), expectedValue: anchorGeneration }],
      () => {
        return new Error(
          `pruneCheckpoints for workflow "${workflowId}" lost its CAS race against a concurrent write.`,
        );
      },
    );
  }
}

/**
 * Delete all but the newest `keepLast` checkpoint history entries for one
 * workflow.
 *
 * Safe to call on a terminal — or still-running — workflow. A no-op —
 * `{ removed: 0, retained: 0 }`, never a throw — when the workflow has no
 * checkpoint history entries at all, whether because the workflow id is
 * unknown or because `EngineOptions.checkpointHistory` was never enabled for
 * it. Rejects with whatever error the storage adapter rejects with when a
 * delete batch fails, and honors `options.signal` by throwing its abort
 * reason before issuing any delete — once the first delete chunk commits
 * (see {@link deleteCheckpointHistoryEntries}), the prune runs to completion
 * without further abort checks. A storage error or generation change can
 * still reject a later chunk after earlier chunks have committed.
 *
 * `retained` counts scanned entries excluded from this call's deletion plan;
 * concurrent writes or pruning can change the actual history count.
 *
 * `removed` counts entries THIS CALL planned to delete, not entries this
 * call proved were still present beforehand — storage `delete` is
 * idempotent and does not report whether a key existed. Two callers
 * concurrently pruning the SAME still-current run with overlapping
 * `toDelete` lists can therefore each report the full count they planned,
 * even though an overlapping key is only ever physically deleted once,
 * since neither call's guard (see {@link deleteCheckpointHistoryEntries})
 * detects another prune call — only a run replacement. This is a
 * documented, permanent characteristic of `removed`, not a defect awaiting
 * a fix: closing it would need a storage primitive that reports which keys
 * actually existed at delete time, which no adapter provides today.
 * Callers that need an exact `removed` count under concurrent pruning must
 * serialize their own `pruneCheckpoints` calls per workflow id.
 */
export async function pruneCheckpoints(
  internals: EngineInternals,
  workflowId: string,
  options: PruneCheckpointsOptions,
): Promise<PruneCheckpointsResult> {
  const { keepLast, signal } = options;
  assertValidKeepLast(keepLast);
  signal?.throwIfAborted();

  const anchorGeneration = await internals.storage.get(KEYS.workflowGeneration(workflowId));
  const anchorToken = await readWorkflowExecutionToken(internals, workflowId);
  const steps = await scanCheckpointHistorySteps(internals, workflowId, signal);

  // `scanCheckpointHistorySteps()` returns ascending numeric order already
  // (the zero-padded, fixed-width step suffix sorts that way); the newest
  // entries are the tail.
  const toDelete = steps.slice(0, Math.max(0, steps.length - keepLast));
  if (toDelete.length === 0) {
    return { removed: 0, retained: steps.length };
  }

  signal?.throwIfAborted();
  await deleteCheckpointHistoryEntries(
    internals,
    workflowId,
    toDelete,
    anchorToken,
    anchorGeneration,
  );

  return { removed: toDelete.length, retained: steps.length - toDelete.length };
}
