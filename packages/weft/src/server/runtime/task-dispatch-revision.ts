/**
 * Dispatch-time revision staleness gate (WFT-20) — split out of
 * `task-dispatch.ts` purely to stay under this repository's 500-line-per-file
 * ceiling; there is no behavioral reason to import this module directly
 * instead of `task-dispatch.ts`, which calls it from `dispatchTaskImpl`.
 *
 * @module server/runtime/task-dispatch-revision
 */

import { decodeWorkflowState } from '../../core/engine/validation.ts';
import { KEYS } from '../../storage/interface.ts';
import type { ServeOptions, TaskDispatch } from '../index.ts';

/**
 * Reject a dispatch whose caller-supplied `workflowRevision` disagrees with
 * `task.workflowId`'s persisted `WorkflowState.revision` — a bounded,
 * structured failure BEFORE any worker reservation or ledger write. A no-op
 * (never reads storage) unless BOTH `workflowId` and `workflowRevision` are
 * supplied; a no-op when no persisted `WorkflowState` exists for `workflowId`
 * yet (nothing to compare against — the caller opted into an extra read, not
 * an extra existence requirement).
 */
export async function assertDispatchTargetsFreshRevision(
  options: ServeOptions,
  task: TaskDispatch,
): Promise<void> {
  if (task.workflowId === undefined || task.workflowRevision === undefined) {
    return;
  }
  const persistedBytes = await options.engine.storage.get(KEYS.workflow(task.workflowId));
  if (persistedBytes === null) {
    return;
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
}
