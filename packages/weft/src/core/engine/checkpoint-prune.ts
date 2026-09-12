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

/**
 * Read the live checkpoint's `workflowExecutionToken` (WFT-21) — the stable
 * per-run identity stamped once at a run's initial checkpoint and carried
 * forward unchanged by every later commit for that SAME execution, changing
 * only when a fresh execution replaces this workflow id (`start()`, `fork()`,
 * or an `onTerminalConflict: 'start-new'` replacement). Returns `undefined`
 * uniformly for "no live checkpoint at all" and "checkpoint present but
 * predates this field" — both cases have no identity to compare, and the
 * caller's comparison policy (see {@link deleteCheckpointHistoryEntries})
 * already treats an `undefined` anchor as "nothing to fence."
 */
async function readWorkflowExecutionToken(
  internals: EngineInternals,
  workflowId: string,
): Promise<string | undefined> {
  const bytes = await internals.storage.get(KEYS.checkpoint(workflowId));
  if (bytes === null) return undefined;
  return deserializeCheckpoint(bytes).workflowExecutionToken;
}

/**
 * Delete `toDelete` checkpoint history entries in `MAX_BATCH_OPERATIONS`-sized
 * chunks, guarded against a concurrent run replacement (`onTerminalConflict:
 * 'start-new'` reusing this workflow id).
 *
 * The guard compares `anchorToken` — the live checkpoint's
 * `workflowExecutionToken`, captured by the caller BEFORE it scanned history —
 * against a fresh read of the SAME field taken here, immediately before the
 * destructive phase. This is deliberately an identity comparison, not a
 * byte-for-byte CAS on the whole checkpoint record: the checkpoint's other
 * fields (step, locals, accumulated results) legitimately change on every
 * ordinary commit while a workflow keeps running, and fencing on the raw
 * bytes would make pruning fail on almost any active workflow even though no
 * replacement occurred. `workflowExecutionToken` changes only when the
 * execution itself is replaced, so comparing it — mirroring the exact
 * `hostToken`/`workerToken` comparison policy `persistWorkerCheckpoint()`
 * (`checkpoint-io.ts`) already uses for the same field — catches a real
 * replacement without false-positiving on ordinary progress: whenever
 * `anchorToken` is defined, the current token must match it exactly
 * (including a currently-undefined token, which can only mean a replacement
 * or purge happened); when `anchorToken` is `undefined` (a legacy pre-token
 * generation, or no live checkpoint at all), there is no identity to protect
 * and the guard never blocks — the same legacy tolerance already accepted
 * for this field elsewhere.
 *
 * This is a revalidate-then-commit guard, not an atomic CAS: a replacement
 * landing in the narrow window between this re-read and the destructive
 * batch below would not be caught. Closing that fully would require a
 * dedicated, always-present identity key this operation could condition a
 * `conditionalBatch` on; no such key exists today, and introducing one is
 * out of scope for this fix. `commitFencedEngineWrite`'s own epoch fencing
 * (under `ownership: 'lease'` / `'workflow-lease'`) still applies
 * independently and closes a different gap: a deposed, stale engine process
 * issuing this write at all.
 *
 * Bounded per-key deletes — not `storageDeleteRange()` — are deliberate:
 * this repository's own precedent for a bounded, fencing-sensitive
 * historical cleanup (event-log compaction) folds bounded per-key deletes
 * into one atomic batch for the same reason `storageDeleteRange()` cannot
 * carry an identity guard.
 *
 * Passing `workflowId: null` to `commitFencedEngineWrite` (an engine-scoped
 * write, not a per-workflow-claim write) is deliberate — a terminal workflow
 * is not expected to still be claimed by any engine under
 * `ownership: 'workflow-lease'`, and fencing on its claim epoch would
 * spuriously depose an engine that simply never held (or already released)
 * that claim.
 */
async function deleteCheckpointHistoryEntries(
  internals: EngineInternals,
  workflowId: string,
  toDelete: readonly number[],
  anchorToken: string | undefined,
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
    await commitFencedEngineWrite(internals, null, operations, [], () => {
      return new Error(
        `pruneCheckpoints for workflow "${workflowId}" lost its CAS race against a concurrent write.`,
      );
    });
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
 * rather than stopping partway with some, but not all, overflow entries
 * removed.
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
  await deleteCheckpointHistoryEntries(internals, workflowId, toDelete, anchorToken);

  return { removed: toDelete.length, retained: steps.length - toDelete.length };
}
