import type { BatchOperation } from '../../storage/interface.ts';
import { encodeStorageKeyComponent } from '../../storage/interface.ts';
import {
  deleteCompletedReviewsForWorkflow,
  listReviewKeysForWorkflow,
} from './completed-review-storage.ts';
import type { EngineInternals } from './internals.ts';
import { deleteKeysInGuardedChunks } from './termination/terminal-fence.ts';

/** Remove all pending review entries from storage for a given workflow. */
export async function cleanupReviews(
  internals: EngineInternals,
  workflowId: string,
  fencedCommit?: (operations: BatchOperation[]) => Promise<boolean>,
): Promise<void> {
  // A terminal commit's teardown lists the review keys and deletes exactly those in guarded
  // chunks, so a same-id replacement's review entries are never deleted.
  if (fencedCommit !== undefined && internals.storage.capabilities().conditionalBatch) {
    await deleteKeysInGuardedChunks(
      listReviewKeysForWorkflow(internals.storage, workflowId),
      fencedCommit,
    );
    return;
  }

  const pendingPrefix = `review:${encodeStorageKeyComponent(workflowId)}:`;
  const deleteOperations: BatchOperation[] = [];

  if (internals.storage.deletePrefix) {
    await internals.storage.deletePrefix(pendingPrefix);
  } else {
    for await (const [key] of internals.storage.scan(pendingPrefix)) {
      deleteOperations.push({ type: 'delete', key });
    }
  }

  if (deleteOperations.length > 0) {
    await internals.storage.batch(deleteOperations);
  }

  await deleteCompletedReviewsForWorkflow(internals.storage, workflowId);
}
