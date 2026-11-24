import {
  storageValuesEqual,
  type BatchOperation,
  type ConditionalBatchCondition,
} from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import { encode } from '../codec.ts';
import type { WorkflowState } from '../types.ts';
import type { RefusedStorageWrite } from './checkpoint-commit-failed-error.ts';
import { commitFencedEngineWriteAllowingPreconditionFailure } from './fenced-write.ts';
import type { EngineInternals } from './internals.ts';
import {
  adapterCall,
  markStorageAdapterError,
  retryRefusedStorageWrite,
} from './storage-write-retry.ts';
import { decodeWorkflowState, isTerminalWorkflowStatus } from './validation.ts';

/** The record as `stored` holds it, or `undefined` when it cannot be read as a workflow record. */
function decodeStoredRecord(stored: Uint8Array): WorkflowState | undefined {
  try {
    return decodeWorkflowState(stored);
  } catch {
    return undefined;
  }
}

/** The bytes `operations` write under `key`, if any of them is a put of it. */
function bytesWrittenUnder(operations: BatchOperation[], key: string): Uint8Array | undefined {
  const put = operations.find((operation) => operation.type === 'put' && operation.key === key);
  return put?.type === 'put' ? put.value : undefined;
}

/**
 * The error a retry raises when another writer changes the record between its read and its send.
 * It is a transient loss: the next attempt reads the fresh record and decides again, so it is
 * marked as retryable and counts against the same attempt budget.
 */
function changedBeforeSend(workflowId: string): Error {
  const error = new Error(`Workflow "${workflowId}" record changed before its terminal write.`);
  markStorageAdapterError(error);
  return error;
}

/**
 * Retry a terminal `wf:<id>` write (a completion or a failure) whose first attempt storage refused
 * with `firstError`, and throw `onLostRace()` when the record is no longer one this write can end.
 *
 * Each attempt reads `wf:<id>` before it sends anything, and decides from what it finds:
 *
 * - The record holds this batch's own bytes: the earlier attempt landed and only its
 *   acknowledgement was lost. The write is done and nothing is sent again.
 * - The record is what the write was decided from: send the same batch under the first attempt's
 *   conditions plus a compare-and-swap on the bytes just read, so a change made after the read
 *   loses instead of being overwritten (a storage without `conditionalBatch` cannot guard it).
 * - The record is another writer's change to the same run while it is still not terminal, and the
 *   caller gave a `rebuild`: build the batch again over that fresher record, keeping the other
 *   writer's change, and send it under a compare-and-swap on the fresh bytes. Without a `rebuild`
 *   the failure write's own re-decision (`settleLostDecision`) does this.
 * - Anything else (the record is terminal and not this write's, another run's, gone, or unreadable)
 *   is not a record this write can end: nothing is sent, and `onLostRace()` is thrown for the caller
 *   to settle from what is stored.
 *
 * A send that loses its compare-and-swap reads the record once more: a write that landed between
 * the read and the send is done; otherwise another writer changed it first, and the next attempt
 * decides again. Every attempt, send or not, counts against the retry budget, and a budget spent
 * raises `CheckpointCommitFailedError`.
 */
export async function retryTerminalWorkflowStateWrite(
  internals: EngineInternals,
  state: WorkflowState,
  write: Extract<RefusedStorageWrite, 'completion' | 'failure'>,
  firstBatch: BatchOperation[],
  conditions: ConditionalBatchCondition[],
  firstError: unknown,
  onLostRace: () => Error,
  rebuild?: (fresh: WorkflowState) => BatchOperation[],
  sideEffectOperations: BatchOperation[] = [],
): Promise<void> {
  const key = KEYS.workflow(state.id);
  const decision: Decision = {
    batch: firstBatch,
    ownBytes: bytesWrittenUnder(firstBatch, key),
    decidedFrom: encode(state),
  };
  const landed = await retryRefusedStorageWrite(
    internals,
    { workflowId: state.id, write, workflowExecutionToken: state.workflowExecutionToken },
    firstError,
    async () => {
      const stored = await adapterCall(() => internals.storage.get(key));
      const verdict = decide(decision, stored, state, key, rebuild, sideEffectOperations);
      if (verdict !== 'send') return verdict === 'landed';
      const guarded =
        internals.storage.capabilities().conditionalBatch &&
        !conditions.some((condition) => condition.key === key)
          ? [...conditions, { key, expectedValue: stored }]
          : conditions;
      const committed = await commitFencedEngineWriteAllowingPreconditionFailure(
        internals,
        state.id,
        decision.batch,
        guarded,
      );
      if (committed) return true;
      const after = await adapterCall(() => internals.storage.get(key));
      if (decision.ownBytes !== undefined && storageValuesEqual(after, decision.ownBytes)) {
        return true;
      }
      throw changedBeforeSend(state.id);
    },
  );
  if (!landed) throw onLostRace();
}

/** The batch a retry sends, the bytes of this write in it, and the record it was decided from. */
type Decision = {
  batch: BatchOperation[];
  ownBytes: Uint8Array | undefined;
  decidedFrom: Uint8Array;
};

/**
 * What a retry does with the record it just read: `landed` (it holds this write's own bytes),
 * `lost` (it is not a record this write can end), or `send` (send `decision.batch`; a changed record
 * of the same, still open run has rebuilt it over the fresh record first).
 */
function decide(
  decision: Decision,
  stored: Uint8Array | null,
  state: WorkflowState,
  key: string,
  rebuild: ((fresh: WorkflowState) => BatchOperation[]) | undefined,
  sideEffectOperations: BatchOperation[],
): 'landed' | 'lost' | 'send' {
  if (decision.ownBytes !== undefined && storageValuesEqual(stored, decision.ownBytes)) {
    return 'landed';
  }
  const fresh = stored === null ? undefined : decodeStoredRecord(stored);
  if (fresh === undefined) return 'lost';
  if (storageValuesEqual(encode(fresh), decision.decidedFrom)) return 'send';
  const sameRunStillOpen =
    fresh.workflowExecutionToken === state.workflowExecutionToken &&
    !isTerminalWorkflowStatus(fresh.status);
  if (rebuild === undefined || !sameRunStillOpen) return 'lost';
  decision.batch = [...rebuild(fresh), ...sideEffectOperations];
  decision.ownBytes = bytesWrittenUnder(decision.batch, key);
  decision.decidedFrom = encode(fresh);
  return 'send';
}
