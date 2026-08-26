/**
 * ADR 0002 § "Two additional transitions": `acquire (standalone resume)`. A
 * workflow found `running` OR `suspended` at recovery has no other enabling
 * write here to fold a claim into, so this commits the acquire fragment
 * ALONE — the one named exception to "never a standalone commit". Attempted
 * BEFORE `prepareResumeState`, `onRecoveredWorkflow`, and generator relaunch,
 * so no user code — and no earlier fenced write this function makes, such as
 * the history-policy circuit breaker or a services-unavailable failure —
 * can run without a held claim.
 *
 * Deliberately covers `running` and `suspended` the same way. The ADR
 * describes `suspended` as folding `acquire` into the status flip itself
 * (`reactivateSuspendedWorkflowState`'s commit in `resume.ts`), but the
 * EARLIER fenced writes above need a held claim regardless of final status,
 * so one early standalone acquire is the pragmatic shape for both — a
 * documented deviation from that row, not an oversight.
 *
 * A no-op when folding does not apply (`ownership !== 'workflow-lease'`, no
 * registry constructed yet) or when this engine already tracks a claim for
 * `workflowId` — a parked signal-driven wake (`inline-parking.ts`) or a bulk
 * retry that folded `acquire` into its own reactivation write before calling
 * `resume` (`bulk-operations.ts`) — PROVIDED `wakeOwnershipCheck` confirms
 * the durable holder still matches the cached generation. A stalled, expired
 * engine keeps `currentEpoch(workflowId) !== null` until its next renewal
 * CAS detects the loss; trusting the cache alone would replay the parked
 * generator against a successor. `acquire()` itself is unsafe as the
 * re-check (it can win the CAS against a still-valid claim), so only the
 * durable holder is re-read (no write) and compared.
 *
 * @module core/engine/lifecycle/standalone-claim-acquire
 */

import type { EngineInternals } from '../internals.ts';
import { WorkflowClaimUnavailableError } from '../lease-errors.ts';
import { wakeOwnershipCheck } from '../wake-ownership-check.ts';

export async function acquireStandaloneClaimBeforeResume(
  internals: EngineInternals,
  workflowId: string,
): Promise<void> {
  if (internals.options.ownershipMode !== 'workflow-lease') return;
  const registry = internals.workflowClaimRegistry;
  if (registry === null) return;
  const cachedEpoch = registry.currentEpoch(workflowId);
  if (cachedEpoch !== null) {
    const check = await wakeOwnershipCheck({
      storage: internals.storage,
      workflowId,
      wakeKind: 'signal', // closest existing label: dominant caller is the parked wait-signal wake
      expectedEngineId: registry.engineId,
      expectedEpoch: cachedEpoch,
    });
    if (check.status === 'discarded') {
      throw new WorkflowClaimUnavailableError(workflowId, check.observedEngineId);
    }
    return;
  }
  const result = await registry.acquire(workflowId);
  if (result.status === 'lost-race') {
    throw new WorkflowClaimUnavailableError(workflowId, result.heldBy);
  }
}
