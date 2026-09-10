/**
 * Dispatch-time revision staleness gate (WFT-20) — split out of
 * `task-dispatch.ts` purely to stay under this repository's 500-line-per-file
 * ceiling; there is no behavioral reason to import this module directly
 * instead of `task-dispatch.ts`, which calls it from `dispatchTaskImpl`.
 *
 * @module server/runtime/task-dispatch-revision
 */

import { decodeWorkflowState } from '../../core/engine/validation.ts';
import { KEYS, type ConditionalBatchCondition } from '../../storage/interface.ts';
import type { ServeOptions, TaskDispatch } from '../index.ts';

/**
 * Reject a dispatch whose caller-supplied `workflowRevision` disagrees with
 * `task.workflowId`'s persisted `WorkflowState.revision` — a bounded,
 * structured failure BEFORE any worker reservation or ledger write. A no-op
 * (never reads storage) unless BOTH `workflowId` and `workflowRevision` are
 * supplied; a no-op when no persisted `WorkflowState` exists for `workflowId`
 * yet (nothing to compare against — the caller opted into an extra read, not
 * an extra existence requirement).
 *
 * Returns the `conditionalBatch` precondition(s) (empty when this check was a
 * no-op) that fence the CALLER's own ledger commit on the exact workflow-state
 * bytes just read here. This check alone is only a pre-commit read: a
 * `start-new` restart could still displace the workflow to a different
 * revision in the gap between this read and the caller's later ledger write.
 * The caller MUST include the returned conditions in the SAME
 * `conditionalBatch` call that commits the ledger record, so that gap closes
 * atomically instead of merely being read-checked up front (WFT-20).
 */
export async function assertDispatchTargetsFreshRevision(
  options: ServeOptions,
  task: TaskDispatch,
): Promise<ConditionalBatchCondition[]> {
  if (task.workflowId === undefined || task.workflowRevision === undefined) {
    return [];
  }
  const workflowKey = KEYS.workflow(task.workflowId);
  const persistedBytes = await options.engine.storage.get(workflowKey);
  if (persistedBytes === null) {
    return [];
  }
  const persistedRevision = decodeWorkflowState(persistedBytes).revision;
  if (persistedRevision !== task.workflowRevision) {
    throw new Error(
      `TaskDispatch for operation "${task.operationId}" targets workflow "${task.workflowId}" ` +
        `at revision "${task.workflowRevision}", but the persisted run is pinned to revision ` +
        `${persistedRevision === undefined ? 'undefined (a legacy, pre-pinning record)' : `"${persistedRevision}"`} ` +
        '— this dispatch is stale.',
    );
  }
  return [{ key: workflowKey, expectedValue: persistedBytes }];
}
