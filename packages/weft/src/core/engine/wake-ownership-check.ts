/**
 * `wakeOwnershipCheck` — the read-only re-read of `wf-owner-holder:<id>`
 * specified in
 * [ADR 0002 § Ownership transitions](../../../documentation/contributing/architecture-decisions/0002-multiengine-per-workflow-ownership.md#ownership-transitions)
 * (the paragraph immediately after the transitions table).
 *
 * **Why this exists.** Under `ownership: 'workflow-lease'`, every code path
 * that is about to resolve an in-memory waiter or drive a generator for a
 * parked workflow — a fired sleep timer, a re-evaluated `ctx.waitUntil()`
 * condition, a delivered signal, an async-activity completion/failure, a
 * child workflow's termination, or a deferred inline macrotask drive — must
 * first confirm THIS engine still holds the claim generation it parked the
 * workflow under. Skipping that check would let a stale in-memory resolver
 * from a prior generation drive a workflow this engine no longer owns.
 *
 * **Why the FULL generation, not just the engine id.** When an engine
 * releases a workflow and later reacquires the same id, its `engineId` is
 * unchanged while `epoch` names a new generation. An engine-id-only check
 * would let a delayed wake or a stale in-memory resolver from the PRIOR
 * generation drive the NEW one — the exact ABA hazard the epoch exists to
 * close. This check therefore compares `engineId` AND `epoch` together,
 * never `engineId` alone.
 *
 * **What a match does and does not prove.** A match is a cheap pre-check,
 * not the safety mechanism itself — the durable write that follows still
 * carries the epoch as a `conditionalBatch` precondition, and that CAS is
 * the actual backstop. A mismatch means this engine no longer holds the
 * generation it parked under: the caller must discard its in-memory
 * resolver without driving the generator. This module emits
 * `WeftWorkflowWakeDiscardedWarning` on every mismatch; it does not decide
 * what the caller does next (that decision, and the actual discard, belong
 * to the wake call sites this check is wired into — a later stage).
 *
 * **Scope.** This module is the check alone: read the holder record, decide
 * match or discard, warn on discard. It is NOT wired into any of the wake
 * call sites named above — that wiring is a later stage's responsibility.
 *
 * @module core/engine/wake-ownership-check
 */

import { KEYS, type Storage } from '../../storage/interface.ts';
import {
  emitWorkflowWakeDiscardedWarning,
  type EmitWorkflowLeaseWarning,
  type WorkflowWakeKind,
} from './lease-deposition.ts';
import { decodeWorkflowClaimHolder } from './workflow-claim-codec.ts';

/** Parameters for {@link wakeOwnershipCheck}. */
export type WakeOwnershipCheckParams = {
  /** Durable storage to re-read `wf-owner-holder:<workflowId>` from. */
  storage: Storage;
  /** The workflow whose parked wake is about to be resolved or driven. */
  workflowId: string;
  /** Which wake path is asking — folded into the discard warning for operator diagnosis. */
  wakeKind: WorkflowWakeKind;
  /** The `engineId` this engine parked the workflow under. */
  expectedEngineId: string;
  /** The `epoch` this engine parked the workflow under. */
  expectedEpoch: number;
  /** Operator-warning seam; defaults to `process.emitWarning` via `lease-deposition.ts`. */
  warn?: EmitWorkflowLeaseWarning;
};

/** Why a re-read holder record failed to match the expected generation. */
export type WakeOwnershipDiscardReason =
  | 'holder-absent'
  | 'holder-undecodable'
  | 'generation-mismatch';

/** Result of {@link wakeOwnershipCheck}. */
export type WakeOwnershipCheckResult =
  | { status: 'match' }
  | {
      status: 'discarded';
      reason: WakeOwnershipDiscardReason;
      /** The `engineId` actually found on re-read, or `null` when the holder was absent/undecodable. */
      observedEngineId: string | null;
      /** The `epoch` actually found on re-read, or `null` when the holder was absent/undecodable. */
      observedEpoch: number | null;
    };

/**
 * Re-read `wf-owner-holder:<workflowId>` and compare it against the full
 * generation (`engineId` + `epoch`) this engine parked the workflow under.
 *
 * Returns `{ status: 'match' }` when both fields agree — the caller may
 * proceed to resolve its in-memory waiter or drive the generator (the
 * following durable write still carries the epoch as the real backstop).
 * Returns `{ status: 'discarded', reason }` and emits
 * `WeftWorkflowWakeDiscardedWarning` in every other case: the holder key is
 * absent (`'holder-absent'`), the stored bytes do not decode to a valid
 * holder record (`'holder-undecodable'`), or a holder record was found but
 * its `engineId`/`epoch` do not both match what was expected
 * (`'generation-mismatch'`) — including the stale-generation case where
 * `engineId` matches but `epoch` does not, the exact hazard this check
 * exists to close.
 */
export async function wakeOwnershipCheck(
  params: WakeOwnershipCheckParams,
): Promise<WakeOwnershipCheckResult> {
  const { storage, workflowId, wakeKind, expectedEngineId, expectedEpoch, warn } = params;

  const discard = (
    reason: WakeOwnershipDiscardReason,
    observedEngineId: string | null,
    observedEpoch: number | null,
  ): WakeOwnershipCheckResult => {
    emitWorkflowWakeDiscardedWarning(workflowId, wakeKind, warn);
    return { status: 'discarded', reason, observedEngineId, observedEpoch };
  };

  const raw = await storage.get(KEYS.workflowOwnerHolder(workflowId));
  if (raw === null) {
    return discard('holder-absent', null, null);
  }

  const holder = decodeWorkflowClaimHolder(raw);
  if (holder === null) {
    return discard('holder-undecodable', null, null);
  }

  if (holder.engineId !== expectedEngineId || holder.epoch !== expectedEpoch) {
    return discard('generation-mismatch', holder.engineId, holder.epoch);
  }

  return { status: 'match' };
}
