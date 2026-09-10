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
 * **`'holder-absent'` falls through to a fresh `acquire()` instead of hard-
 * failing (WFT-134).** `suspendWorkflow`'s external terminal rotation
 * durably deletes `wf-owner-holder:<id>` as part of its suspend commit, which
 * can outpace this engine's own local cache correction
 * (`WorkflowClaimRegistry.forgetLocalClaim`). A same-engine `resume()`
 * landing in that gap must not be treated as a real conflict — it is
 * exactly the "no other holder to lose to" case a fresh `acquire()` handles
 * safely. `'holder-undecodable'` and `'generation-mismatch'` remain hard
 * failures: both mean a holder record IS present and either corrupt or
 * naming a different generation, a real conflict this function must not
 * paper over.
 *
 * @module core/engine/lifecycle/standalone-claim-acquire
 */

import { KEYS, storageHas } from '../../../storage/interface.ts';
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
    if (check.status === 'match') {
      return;
    }
    // WFT-134: `'holder-absent'` specifically — NOT `'holder-undecodable'` or
    // `'generation-mismatch'`, both of which stay hard failures below, since
    // they mean a real foreign holder or corrupt record is present — is the
    // signature of `suspendWorkflow`'s external terminal rotation
    // (`buildWorkflowClaimExternalTerminalRotationTransition`), which
    // durably deletes `wf-owner-holder:<id>` as part of the suspend commit
    // while leaving THIS cache possibly still populated (a stale entry that
    // `WorkflowClaimRegistry.forgetLocalClaim` may not have cleared yet, or a
    // different engine's cache that never held the id at all). Treat an
    // absent holder as "nothing to fast-path against" and fall through to a
    // fresh `registry.acquire()`, the same path a never-before-seen claim
    // takes below — rather than hard-failing a legitimate same-engine
    // resume immediately after its own suspend.
    if (check.reason !== 'holder-absent') {
      throw new WorkflowClaimUnavailableError(workflowId, check.observedEngineId);
    }
  }
  const result = await registry.acquire(workflowId);
  if (result.status === 'lost-race') {
    throw new WorkflowClaimUnavailableError(workflowId, result.heldBy);
  }
}

/**
 * Standalone-acquire `workflowId`'s claim (see {@link acquireStandaloneClaimBeforeResume},
 * a no-op once already held) and hydrate its terminal-cleanup tracking from
 * the durable marker — the two preconditions a `'self'`-fenced `failWorkflow()`
 * write needs. Used by `operations-time.ts`'s `startDelayedWorkflow` on every
 * failure exit (dynamic-source resolve, invalid execution-timeout) BEFORE
 * failing: a delayed-start's pending→running write is the only other place
 * this claim would otherwise get acquired (folded atomically, per ADR 0002),
 * so a failure committed ahead of that write needs this standalone path
 * instead, exactly like a recovered `running`/`suspended` workflow does.
 */
export async function ensureDelayedStartClaimAndCleanupBeforeFailure(
  internals: EngineInternals,
  workflowId: string,
): Promise<void> {
  await acquireStandaloneClaimBeforeResume(internals, workflowId);
  if (await storageHas(internals.storage, KEYS.terminalCleanupNeeded(workflowId))) {
    internals.workflowsNeedingTerminalCleanup.add(workflowId);
  }
}
