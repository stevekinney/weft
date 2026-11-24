import {
  storageValuesEqual,
  type BatchOperation,
  type ConditionalBatchCondition,
} from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import { commitFencedEngineWriteAllowingPreconditionFailure } from './fenced-write.ts';
import type { EngineInternals } from './internals.ts';
import { adapterCall, retryRefusedStorageWrite } from './storage-write-retry.ts';

/** What the retry of a checkpoint batch needs of the commit that was refused. */
export type RefusedCheckpointCommit = {
  /** The same operations the first attempt sent, side effects included. */
  readonly operations: BatchOperation[];
  /** The checkpoint bytes the batch writes under `wf:<id>:ckpt`. */
  readonly serialized: Uint8Array;
  readonly checkpoint: { readonly workflowExecutionToken?: string | undefined };
};

/**
 * Retry a checkpoint batch whose first attempt storage refused with `firstError`, and report
 * whether it committed. The batch is the same one, with the same operations and conditions: it
 * already holds the commit's staged side effects (they left the engine when the batch was built),
 * so recomputing it would drop them.
 *
 * An attempt that commits, or that loses its compare-and-swap while `wf:<id>:ckpt` already holds
 * this batch's own bytes, counts as committed: the earlier attempt landed and only its
 * acknowledgement was lost, so the caller finishes the commit's bookkeeping instead of reporting
 * a conflict with itself. A loss against any other bytes returns `false`, a genuine loss.
 */
export function retryCheckpointBatch(
  internals: EngineInternals,
  workflowId: string,
  commit: RefusedCheckpointCommit,
  conditions: ConditionalBatchCondition[],
  firstError: unknown,
): Promise<boolean> {
  return retryRefusedStorageWrite(
    internals,
    {
      workflowId,
      write: 'checkpoint',
      workflowExecutionToken: commit.checkpoint.workflowExecutionToken,
    },
    firstError,
    async () => {
      const committed = await commitFencedEngineWriteAllowingPreconditionFailure(
        internals,
        workflowId,
        commit.operations,
        conditions,
      );
      if (committed) return true;
      const stored = await adapterCall(() => internals.storage.get(KEYS.checkpoint(workflowId)));
      return storageValuesEqual(stored, commit.serialized);
    },
  );
}
