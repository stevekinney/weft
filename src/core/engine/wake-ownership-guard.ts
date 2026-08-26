/**
 * `confirmWakeOwnership` — the single call-site helper every claim-requiring
 * wake path (sleep, wait-condition, async-activity, inline-macrotask-drive)
 * uses to run `wakeOwnershipCheck` before resolving an in-memory waiter or
 * driving a generator for a parked workflow, per
 * [ADR 0002 § Ownership transitions](../../../documentation/contributing/architecture-decisions/0002-multiengine-per-workflow-ownership.md#ownership-transitions).
 *
 * **Why a wrapper instead of calling `wakeOwnershipCheck` directly at each
 * site.** `wakeOwnershipCheck` requires a non-null `expectedEngineId` /
 * `expectedEpoch` pair — it has no opinion on how a caller obtains those. Every
 * wake site needs the exact same three-way decision tree first:
 *
 * - `internals.workflowClaimRegistry` is `null` (ownership is `'none'` or
 *   `'lease'`): this check is a no-op. Proceed — byte-identical to every
 *   pre-ADR-0002 deployment. This is the property every wake site must
 *   preserve above all else.
 * - The registry is present but tracks no epoch for this workflow id
 *   (`currentEpoch(workflowId)` is `null` — e.g. a `renew()` loss already
 *   dropped this engine's local claim entry): there is nothing to compare
 *   against, so this is itself a discard. `wakeOwnershipCheck` cannot be
 *   called with a null epoch, so this module emits
 *   `WeftWorkflowWakeDiscardedWarning` itself rather than skipping the
 *   operator diagnostic.
 * - The registry tracks an epoch: re-read the durable holder record and
 *   compare the full generation via `wakeOwnershipCheck`.
 *
 * **A thrown storage read is `'proceed'`, not `'discard'`.** This helper is a
 * cheap pre-check; the epoch-conditioned durable write that follows every
 * proceed path is the real backstop (`EngineDeposedError` if it has actually
 * lost the claim). A storage blip during the pre-check must not permanently
 * strand a wake — a fired sleep timer or a signalled `waitUntil` deadline is
 * not retried — so a thrown read is treated the same as a match and the
 * caller proceeds to its normal (already-fenced) write path.
 *
 * @module core/engine/wake-ownership-guard
 */

import type { EngineInternals } from './internals.ts';
import { emitWorkflowWakeDiscardedWarning, type WorkflowWakeKind } from './lease-deposition.ts';
import { wakeOwnershipCheck } from './wake-ownership-check.ts';

/** Outcome of {@link confirmWakeOwnership}: whether the caller may proceed with this wake. */
export type WakeOwnershipDecision = 'proceed' | 'discard';

/**
 * Decide whether a claim-requiring wake path may resolve its in-memory
 * waiter / drive its generator for `workflowId`. See the module doc for the
 * three-way decision tree and the thrown-read policy.
 */
export async function confirmWakeOwnership(
  internals: EngineInternals,
  workflowId: string,
  wakeKind: WorkflowWakeKind,
): Promise<WakeOwnershipDecision> {
  const registry = internals.workflowClaimRegistry;
  if (registry === null) {
    return 'proceed';
  }

  const expectedEpoch = registry.currentEpoch(workflowId);
  if (expectedEpoch === null) {
    emitWorkflowWakeDiscardedWarning(workflowId, wakeKind);
    return 'discard';
  }

  try {
    const result = await wakeOwnershipCheck({
      storage: internals.storage,
      workflowId,
      wakeKind,
      expectedEngineId: registry.engineId,
      expectedEpoch,
    });
    return result.status === 'match' ? 'proceed' : 'discard';
  } catch {
    // A thrown storage read is a transient blip, not a confirmed loss of
    // ownership. See the module doc's "thrown storage read" section.
    return 'proceed';
  }
}
