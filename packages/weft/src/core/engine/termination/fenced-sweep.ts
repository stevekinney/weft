import { KEYS, storageHas, storageKeys, type BatchOperation } from '../../../storage/interface.ts';
import type { EngineInternals } from '../internals.ts';
import { deleteKeysInGuardedChunks } from './terminal-fence.ts';

/** Options for {@link cleanupWorkflowStorage}. */
export type CleanupStorageOptions = {
  /** Whether to release the workflow's concurrency slot; terminal teardown already did, fenced. */
  releaseConcurrencySlot?: boolean;
  /**
   * Commits one chunk of deletes only while the id still belongs to the committing run.
   * With `conditionalBatch` the sweep enumerates each prefix and deletes those exact keys in
   * guarded chunks, so a replacement that committed leaves nothing deleted and keys it writes
   * after the listing are never in a batch. Without `conditionalBatch` the sweep keeps the
   * unfenced path, whose only protection is the caller's best-effort same-engine check.
   */
  fencedCommit?: ((operations: BatchOperation[]) => Promise<boolean>) | undefined;
  /** Further keys the fenced sweep deletes in its first chunk. */
  extraDeleteKeys?: string[];
};

/** Delete the per-run keys and everything under `prefixes`, stopping at the first chunk the fence rejects. */
export async function sweepFenced(
  internals: EngineInternals,
  workflowId: string,
  prefixes: string[],
  extraDeleteKeys: string[],
  fencedCommit: (operations: BatchOperation[]) => Promise<boolean>,
): Promise<void> {
  const keyed = [
    KEYS.workflowHeaders(workflowId),
    KEYS.signalSequence(workflowId),
    KEYS.workflowHasServices(workflowId),
    ...extraDeleteKeys,
  ];
  // The finalizer payload stays while a teardown is still owed; see the unfenced path.
  if (!(await storageHas(internals.storage, KEYS.teardownOwed(workflowId)))) {
    keyed.push(KEYS.finalizerState(workflowId));
  }
  async function* swept(): AsyncGenerator<string> {
    for (const prefix of prefixes) yield* storageKeys(internals.storage, prefix);
  }
  await deleteKeysInGuardedChunks(
    swept(),
    fencedCommit,
    keyed.map((key) => ({ type: 'delete', key })),
  );
}
