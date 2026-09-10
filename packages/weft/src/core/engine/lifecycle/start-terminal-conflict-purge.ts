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
import { buildWorkflowGenerationBumpOperation } from '../workflow-generation-fence.ts';
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
   * RESOLVED (PR #959 review; closed by WFT-153). This condition alone compares
   * only a VALUE, so on its own it cannot distinguish "this id was never used"
   * from "a run existed here and was purged" — a racing winner that commits,
   * completes, and is purged (or swept by retention) before this batch commits
   * would make `wf:<id>` absent again, matching `expectedValue: null`. That gap
   * is now closed by {@link duplicateIdGenerationCondition} below, an ADDITIONAL
   * condition on a durable per-id generation counter a purge bumps but never
   * resets — see its own doc for the mechanism.
   */
  duplicateIdCondition: ConditionalBatchCondition;
  /**
   * ADDITIONAL compare-and-swap precondition on the observed `wf-gen:<id>`
   * bytes, closing the residual ABA hole {@link duplicateIdCondition} cannot
   * detect (WFT-153, following WFT-152). `duplicateIdCondition` compares a
   * VALUE, so it cannot tell "this id was never used" from "a run existed
   * here and was purged" — if a racing winner completes and is purged before
   * this batch commits, `wf:<id>` looks absent again and `duplicateIdCondition`
   * alone would match. `wf-gen:<id>` is bumped in the SAME atomic batch that
   * deletes `wf:<id>` on purge (`workflow-generation-fence.ts`) and is never
   * otherwise touched, so a purge landing in the read-to-commit gap changes
   * this key even though `wf:<id>` reads the same — the stale loser's
   * condition on the pre-purge generation bytes fails where the value-only
   * comparison could not detect it. See `storage/generation-keys.ts`.
   */
  duplicateIdGenerationCondition: ConditionalBatchCondition;
  /**
   * The exact `wf-gen:<id>` bytes {@link duplicateIdGenerationCondition} was
   * built from, threaded through to {@link prepareTerminalRunPurge} so a
   * `'start-new'` restart's own displacing purge bumps the generation from
   * this SAME observed value rather than a second, independent read. This is
   * what makes the restart's own CAS trivially self-consistent — it can never
   * fence itself out on its own legitimate restart, because the value it
   * bumps from is exactly the value its own precondition checks.
   */
  observedGenerationBytes: Uint8Array | null;
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
  duplicateIdGenerationCondition: undefined,
  // `null`, not `undefined`: always fed straight into `prepareTerminalRunPurge`'s
  // `Uint8Array | null` parameter (unreachable for a generated id, since
  // `terminalRunToPurge` is always `null` here — but typed to match without a
  // caller-side `?? null`).
  observedGenerationBytes: null,
} as const satisfies {
  terminalRunToPurge: WorkflowState | null;
  duplicateIdCondition: ConditionalBatchCondition | undefined;
  duplicateIdGenerationCondition: ConditionalBatchCondition | undefined;
  observedGenerationBytes: Uint8Array | null;
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
 * than a blind overwrite (WFT-152). It also reads `wf-gen:<id>` in the SAME pass
 * and carries `duplicateIdGenerationCondition`/`observedGenerationBytes` (WFT-153),
 * closing the residual ABA window a value-only condition cannot detect — see that
 * field's own doc.
 */
export async function resolveTerminalConflictForRestart(
  internals: EngineInternals,
  workflowId: string,
  options: StartWorkflowOptions | undefined,
): Promise<StartDuplicateIdDecision> {
  const key = KEYS.workflow(workflowId);
  const generationKey = KEYS.workflowGeneration(workflowId);
  const [existingBytes, observedGenerationBytes] = await Promise.all([
    internals.storage.get(key),
    internals.storage.get(generationKey),
  ]);
  const duplicateIdGenerationCondition: ConditionalBatchCondition = {
    key: generationKey,
    expectedValue: observedGenerationBytes,
  };
  if (existingBytes === null) {
    return {
      terminalRunToPurge: null,
      duplicateIdCondition: { key, expectedValue: null },
      duplicateIdGenerationCondition,
      observedGenerationBytes,
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
    duplicateIdGenerationCondition,
    observedGenerationBytes,
  };
}

/**
 * The `'reattach-only'`/`'bulk-retry-only'` fence for `startWorkflow`'s
 * `skipAdmissionIdCheck` parameter (WFT-95 TOCTOU fix). Call immediately
 * after {@link resolveTerminalConflictForRestart} resolves.
 *
 * Both call sites reach `startWorkflow` after a separate, non-atomic read
 * confirmed an already-persisted record they mean to replay or replace — but
 * that confirmation and `resolveTerminalConflictForRestart`'s own atomic read
 * are not the same read:
 *
 * - `dispatchChildWorkflowStart()`'s crash-reattach retry confirms a matching
 *   persisted child via `loadWorkflowState()`, then leaves
 *   `options.onTerminalConflict` unset — so `resolveTerminalConflictForRestart`
 *   either finds the record still there (throws {@link WorkflowAlreadyExistsError},
 *   this function is never reached: the expected, unraced reattach) or gone
 *   (`terminalRunToPurge: null`, the ordinary fresh-create branch).
 * - `retryFailedWorkflow()`'s checkpoint-absent fallback (`bulk-operations-retry.ts`)
 *   confirms a `failed` record via its own `loadWorkflowState()`, then always
 *   sets `options.onTerminalConflict: 'start-new'` — so
 *   `resolveTerminalConflictForRestart` either finds the SAME terminal record
 *   still there (returns its bytes as `terminalRunToPurge`, the expected,
 *   unraced purge-and-replace) or finds it gone (`terminalRunToPurge: null`,
 *   the same ordinary fresh-create branch).
 *
 * Under `ownership: 'workflow-lease'`, another engine can purge the matched
 * record in the window between either call site's own confirmation read and
 * `resolveTerminalConflictForRestart`'s. Being called with a `'reattach-only'`
 * or `'bulk-retry-only'` `skipAdmissionIdCheck` and a `null` `terminalRunToPurge`
 * therefore means the race happened: there is nothing left to reattach to or
 * replace, so this re-runs strict admission rather than let a bypassed
 * `.`/`..` id fall through into a genuinely fresh create. `coerceStartWorkflowId`
 * throws the same `StartWorkflowValidationError` strict admission would have
 * thrown on the caller's very first (non-retry) attempt — a clean,
 * deterministic rejection instead of a silently created reserved-id run.
 *
 * A no-op for every other `skipAdmissionIdCheck` value: `true` (schedule
 * drain) applies unconditionally and never calls this, and `undefined`
 * (every public start surface) already went through strict admission in
 * `prepareStartWorkflow`.
 */
export function enforceReplayOnlyIdFence(
  skipAdmissionIdCheck: boolean | 'reattach-only' | 'bulk-retry-only' | undefined,
  workflowId: string,
  terminalRunToPurge: WorkflowState | null,
): void {
  if (
    (skipAdmissionIdCheck === 'reattach-only' || skipAdmissionIdCheck === 'bulk-retry-only') &&
    terminalRunToPurge === null
  ) {
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
 *
 * Also appends the `wf-gen:<id>` bump PUT operation (WFT-153), built from
 * `observedGenerationBytes` — the SAME bytes `resolveTerminalConflictForRestart`
 * already read for `duplicateIdGenerationCondition` — rather than a second,
 * independent read. Reusing that one observed value for both the outer CAS
 * condition and the bump amount is what makes this restart's own commit
 * trivially self-consistent: it can never fence itself out on its own
 * legitimate restart, because the value it bumps from is exactly the value its
 * own precondition checks (see `duplicateIdGenerationCondition`'s doc).
 */
export async function prepareTerminalRunPurge(
  internals: EngineInternals,
  state: WorkflowState,
  callbacks: LifecycleCallbacks,
  observedGenerationBytes: Uint8Array | null,
): Promise<BatchOperation[]> {
  const cleanupWaitersForStart: CleanupWaiters = (id) =>
    cleanupWaiters(internals, id, {
      swallowPromiseRejection: callbacks.swallowPromiseRejection,
    });
  const deleteOperations = await collectWorkflowPurgeDeleteOperations(internals, state);
  deleteOperations.push(buildWorkflowGenerationBumpOperation(state.id, observedGenerationBytes));
  clearPurgedWorkflowInMemoryState(internals, state.id, cleanupWaitersForStart);
  return deleteOperations;
}
