import type { BatchOperation } from '../../../storage/interface.ts';
import { KEYS, storageHas } from '../../../storage/interface.ts';
import type { StartWorkflowOptions, WorkflowState } from '../../types.ts';
import {
  clearPurgedWorkflowInMemoryState,
  collectWorkflowPurgeDeleteOperations,
  type CleanupWaiters,
} from '../bulk-operations-purge.ts';
import { WorkflowAlreadyExistsError, WorkflowTeardownPendingError } from '../errors.ts';
import type { EngineInternals } from '../internals.ts';
import { cleanupWaiters } from '../termination/cleanup.ts';
import { decodeWorkflowState, isTerminalWorkflowStatus } from '../validation.ts';
import { type LifecycleCallbacks } from './shared.ts';

/**
 * Decide what a caller-supplied workflow id that already has a persisted record
 * means, WITHOUT performing any destructive action. Only invoked when the caller
 * supplied the id — a generated v4 UUID is effectively unique, so skipping this
 * read keeps generated-id starts on the single-write hot path.
 *
 * - default (`'error'`): throw {@link WorkflowAlreadyExistsError} (the existing
 *   contract — a duplicate id is always a conflict).
 * - `'start-new'` on a **terminal** run: return that run's {@link WorkflowState}
 *   so the caller can purge it *after* all deterministic new-run validation has
 *   succeeded. This keeps the destructive purge as the last possible step before
 *   the atomic create commit, so a restart that is rejected by any later
 *   validation (payload size, execution-timeout overflow, a start interceptor
 *   throwing) leaves the prior terminal run intact.
 * - `'start-new'` on a **non-terminal** run: throw
 *   {@link WorkflowAlreadyExistsError} — `'start-new'` never displaces a live run.
 * - `'start-new'` on a **terminal** run that still owes a finalizer (#446): throw
 *   {@link WorkflowTeardownPendingError} (transient). The displacing purge would
 *   delete the finalizer payload before the resource is torn down, leaking it, so
 *   the restart is refused until teardown settles (which clears the marker).
 *
 * Returns `null` when there is no existing record (the create proceeds normally).
 */
export async function resolveTerminalConflictForRestart(
  internals: EngineInternals,
  workflowId: string,
  options: StartWorkflowOptions | undefined,
): Promise<WorkflowState | null> {
  const existingBytes = await internals.storage.get(KEYS.workflow(workflowId));
  if (existingBytes === null) {
    return null;
  }
  if (options?.onTerminalConflict !== 'start-new') {
    throw new WorkflowAlreadyExistsError(workflowId);
  }
  const existingState = decodeWorkflowState(existingBytes);
  if (!isTerminalWorkflowStatus(existingState.status)) {
    throw new WorkflowAlreadyExistsError(workflowId);
  }
  if (await storageHas(internals.storage, KEYS.teardownOwed(workflowId))) {
    throw new WorkflowTeardownPendingError(workflowId);
  }
  return existingState;
}

/**
 * Prepare a prior terminal run for displacement by a `'start-new'` restart WITHOUT
 * committing the destructive delete. Returns the storage delete operations (for the
 * caller to fold into the atomic create batch so purge-and-recreate land as one
 * unit) and clears the OLD run's in-memory caches up front — before the new run
 * writes its own caches under the reused id, so the clear cannot wipe fresh
 * entries. `clearPurgedWorkflowInMemoryState` runs `cleanupWaiters` to settle the
 * old run's pending signal/update/sleep waiters; it only needs
 * `swallowPromiseRejection`, which `LifecycleCallbacks` already exposes.
 */
export async function prepareTerminalRunPurge(
  internals: EngineInternals,
  state: WorkflowState,
  callbacks: LifecycleCallbacks,
): Promise<BatchOperation[]> {
  const cleanupWaitersForStart: CleanupWaiters = (id) =>
    cleanupWaiters(internals, id, {
      swallowPromiseRejection: callbacks.swallowPromiseRejection,
    });
  const deleteOperations = await collectWorkflowPurgeDeleteOperations(internals, state);
  clearPurgedWorkflowInMemoryState(internals, state.id, cleanupWaitersForStart);
  return deleteOperations;
}
