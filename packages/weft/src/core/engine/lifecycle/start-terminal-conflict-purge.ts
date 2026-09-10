import type { BatchOperation, ConditionalBatchCondition } from '../../../storage/interface.ts';
import { KEYS, storageHas } from '../../../storage/interface.ts';
import { coerceStartWorkflowId } from '../../start-workflow-validation.ts';
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
 * What the duplicate-id read decided about a caller-supplied workflow id.
 */
export type StartDuplicateIdDecision = {
  /** A prior terminal run this start will displace, or `null` for a fresh id. */
  terminalRunToPurge: WorkflowState | null;
  /**
   * Compare-and-swap precondition that makes the duplicate-id check atomic with
   * the create commit (WFT-152).
   *
   * The check below reads `KEYS.workflow(workflowId)` and decides whether the id
   * is free, but that read and the create batch are separated by every build step
   * in between. Within ONE engine `pendingStarts` holds the id across that window;
   * two engines sharing a store share no such memory, so both previously committed
   * blind and the second silently overwrote the first — leaving the loser with a
   * run whose terminal transition happens on the other engine and therefore never
   * settles its `result()` waiter. Conditioning the batch on the exact value seen
   * here collapses that window: the loser's batch does not commit, and
   * `buildAndCommitStartBatch` surfaces {@link WorkflowAlreadyExistsError} — the
   * same error the in-engine `pendingStarts` guard already throws for the same
   * collision.
   *
   * `expectedValue` is the RAW observed bytes, deliberately not a re-encoding of
   * the decoded state: re-encoding is not guaranteed to round-trip byte-identically,
   * and a condition built from one would fail against a record nothing had touched.
   * `null` (id absent) and a prior terminal run's bytes (an
   * `onTerminalConflict: 'start-new'` restart) are both valid expected values, so a
   * restart is equally protected against a concurrent engine displacing the same
   * terminal run.
   *
   * No `conditionalBatch` capability gate is needed. Reaching this code means a
   * workflow is registered, and registration drains through
   * `WorkflowCatalog#activateRegistered`, which already hard-requires that
   * capability at `Engine.create()`. A store that cannot honour this condition
   * cannot host an engine that could start a workflow in the first place.
   *
   * KNOWN LIMITATION (PR #959 review). The condition compares a VALUE, so it cannot
   * distinguish "this id was never used" from "a run existed here and was purged".
   * If a racing winner commits, completes, and is purged or swept by retention
   * before this batch commits, `wf:<id>` is absent again, `expectedValue: null`
   * matches, and both starts execute. Closing that needs durable per-id generation
   * or tombstone state a purge cannot restore — a new persisted mechanism, out of
   * scope here. The window is narrow (a winner's whole lifecycle plus a purge inside
   * one loser's read-to-commit gap) and the outcome is a duplicate run rather than
   * the indefinite hang this fence exists to remove.
   */
  duplicateIdCondition: ConditionalBatchCondition;
};

/**
 * The decision for a start whose id was GENERATED rather than caller-supplied. A
 * v4 UUID is effectively unique, so the duplicate-id read is skipped entirely and
 * there is no observed value to condition on — the start keeps the unconditioned
 * single-write hot path.
 */
export const GENERATED_ID_START_DECISION = {
  terminalRunToPurge: null,
  duplicateIdCondition: undefined,
} as const satisfies {
  terminalRunToPurge: WorkflowState | null;
  duplicateIdCondition: ConditionalBatchCondition | undefined;
};

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
 * This read is only a point-in-time observation: another engine sharing the store
 * can commit a create for the same id in the window between it and the create
 * batch. The returned {@link StartDuplicateIdDecision} therefore carries a
 * `duplicateIdCondition` holding the exact bytes seen here, so that batch can be
 * conditioned on them — turning that window into a lost compare-and-swap rather
 * than a blind overwrite (WFT-152).
 */
export async function resolveTerminalConflictForRestart(
  internals: EngineInternals,
  workflowId: string,
  options: StartWorkflowOptions | undefined,
): Promise<StartDuplicateIdDecision> {
  const key = KEYS.workflow(workflowId);
  const existingBytes = await internals.storage.get(key);
  if (existingBytes === null) {
    return {
      terminalRunToPurge: null,
      duplicateIdCondition: { key, expectedValue: null },
    };
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
  return {
    terminalRunToPurge: existingState,
    duplicateIdCondition: { key, expectedValue: existingBytes },
  };
}

/**
 * The `'reattach-only'` fence for `startWorkflow`'s `skipAdmissionIdCheck`
 * parameter (WFT-95 TOCTOU fix). Call immediately after
 * {@link resolveTerminalConflictForRestart} resolves.
 *
 * `dispatchChildWorkflowStart()`'s crash-reattach retry only reaches
 * `startWorkflow` after a separate, non-atomic `loadWorkflowState()` read
 * confirmed a matching persisted child record — but that confirmation and
 * `resolveTerminalConflictForRestart`'s own atomic read are not the same
 * read. Under `ownership: 'workflow-lease'`, another engine can purge the
 * matched record in the window between them. Because that retry always
 * leaves `options.onTerminalConflict` unset, `resolveTerminalConflictForRestart`
 * has exactly two outcomes: the record is still there (it throws
 * {@link WorkflowAlreadyExistsError} and this function is never reached —
 * the expected, unraced reattach) or it is gone (`terminalRunToPurge: null`,
 * the ordinary fresh-create branch). Being called with
 * `skipAdmissionIdCheck === 'reattach-only'` and a `null` `terminalRunToPurge`
 * therefore means the race happened: there is nothing left to reattach to, so
 * this re-runs strict admission rather than let a bypassed `.`/`..` id fall
 * through into a genuinely fresh create. `coerceStartWorkflowId` throws the
 * same `StartWorkflowValidationError` strict admission would have thrown on
 * the caller's very first (non-retry) attempt — a clean, deterministic
 * rejection instead of a silently created reserved-id run.
 *
 * A no-op for every other `skipAdmissionIdCheck` value: `true` (schedule
 * drain, bulk retry) applies unconditionally and never calls this, and
 * `undefined` (every public start surface) already went through strict
 * admission in `prepareStartWorkflow`.
 */
export function enforceReattachOnlyIdFence(
  skipAdmissionIdCheck: boolean | 'reattach-only' | undefined,
  workflowId: string,
  terminalRunToPurge: WorkflowState | null,
): void {
  if (skipAdmissionIdCheck === 'reattach-only' && terminalRunToPurge === null) {
    coerceStartWorkflowId(workflowId, 'options.id');
  }
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
