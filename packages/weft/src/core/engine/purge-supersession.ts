import type { BatchOperation, ConditionalBatchCondition } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import type { WorkflowState } from '../types.ts';
import { commitFencedEngineWriteAllowingPreconditionFailure } from './fenced-write.ts';
import type { EngineInternals } from './internals.ts';
import { trackPurgeWrite } from './purge-write-tracking.ts';
import { decodeWorkflowState, isTerminalWorkflowStatus } from './validation.ts';

/**
 * Commit the purge batch. `false` means the workflow record moved after it was
 * read (a replacement committed, or another purge removed it), which is a skip;
 * a lost precondition on anything else is a genuine lost race and throws.
 */
export async function commitPurgeOrExplainLoss(
  internals: EngineInternals,
  workflowId: string,
  operations: BatchOperation[],
  conditions: ConditionalBatchCondition[],
  observedWorkflowBytes: Uint8Array | null,
): Promise<boolean> {
  const committed = await commitFencedEngineWriteAllowingPreconditionFailure(
    internals,
    null,
    operations,
    conditions,
    (write) => trackPurgeWrite(internals, write),
  );
  if (committed) return true;
  const currentWorkflowBytes = await internals.storage.get(KEYS.workflow(workflowId));
  if (!bytesEqual(currentWorkflowBytes, observedWorkflowBytes)) return false;
  throw new Error(`Purge commit for workflow "${workflowId}" lost its precondition.`);
}

/**
 * Whether the `wf:<id>` bytes read at purge time are still the terminal run that
 * was scanned. An absent record means another purge already removed the scanned
 * run. A present one must carry the scanned execution token and still be
 * terminal, because `retryFailedAll` reactivates a failed run in place under
 * the same token.
 */
export function isScannedRun(workflowBytes: Uint8Array | null, state: WorkflowState): boolean {
  if (workflowBytes === null) return false;
  const current = decodeWorkflowState(workflowBytes);
  return (
    current.workflowExecutionToken === state.workflowExecutionToken &&
    isTerminalWorkflowStatus(current.status)
  );
}

function bytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}
