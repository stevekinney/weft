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

/**
 * Result of {@link acquireStandaloneClaimBeforeResume}. `freshlyAcquired:
 * true` means this call itself performed a fresh `registry.acquire()`
 * (whether because no claim was cached yet, or because the `'holder-absent'`
 * fallback below ran), and carries the exact `epoch` that acquire minted —
 * `freshlyAcquired: false` means no acquisition happened at all (folding
 * disabled, no registry, or the cached claim matched). Callers use this to
 * know whether, and under which exact generation, THEY are now responsible
 * for releasing a claim this call just installed if the resume they were
 * preparing turns out not to be resumable after all — see `resume.ts`'s
 * `resumeWorkflowFromStorage` (WFT-134).
 */
export type StandaloneClaimAcquireResult =
  { freshlyAcquired: true; epoch: number } | { freshlyAcquired: false };

export async function acquireStandaloneClaimBeforeResume(
  internals: EngineInternals,
  workflowId: string,
): Promise<StandaloneClaimAcquireResult> {
  if (internals.options.ownershipMode !== 'workflow-lease') return { freshlyAcquired: false };
  const registry = internals.workflowClaimRegistry;
  if (registry === null) return { freshlyAcquired: false };
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
      return { freshlyAcquired: false };
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
    //
    // That fall-through is exactly as safe as the "no claim cached yet"
    // path below with respect to the workflow's OWN resumability: neither
    // this claim-registry read nor `registry.acquire()` itself checks
    // `WorkflowState.status` at all — a fresh acquire can win the CAS for a
    // workflow that went terminal (a different engine's cancel/timeout, or
    // an `onTerminalConflict: 'start-new'` replacement) in the gap between
    // `resumeWorkflowFromStorage()`'s initial state read and this call. That
    // is a real, separate race (not the same-engine-suspend race this
    // fall-through exists for) with its own fix: the caller releases this
    // freshly-acquired claim if its later, status-aware validation rejects
    // the resume (see the return-value doc above).
    if (check.reason !== 'holder-absent') {
      throw new WorkflowClaimUnavailableError(workflowId, check.observedEngineId);
    }
  }
  const result = await registry.acquire(workflowId);
  if (result.status === 'lost-race') {
    throw new WorkflowClaimUnavailableError(workflowId, result.heldBy);
  }
  return { freshlyAcquired: true, epoch: result.epoch };
}

/**
 * Best-effort durable release of a claim {@link acquireStandaloneClaimBeforeResume}
 * freshly acquired for THIS resume attempt, called when a later, status-aware
 * check (`performSerializedResume`'s status/generation re-validation in
 * `resume.ts`) rejects the resume after all (WFT-134). Without this, a claim
 * acquired for a workflow that turned out to be non-resumable — already
 * terminal, or replaced by an `onTerminalConflict: 'start-new'` run — stays
 * installed: the renewal task keeps refreshing it indefinitely, and a
 * legitimate `start-new` (or the replacement run's own fold-acquire) loses
 * its CAS against a claim nothing is actually driving.
 *
 * `acquiredEpoch` MUST be the exact epoch {@link acquireStandaloneClaimBeforeResume}
 * returned to this same caller — passed straight through to
 * `WorkflowClaimRegistry.release()`'s own `expectedEpoch` guard (WFT-134
 * review round 2). Between this resume's acquire and its rejection, a
 * DIFFERENT `start-new` or resume can legitimately replace the registry's
 * entry for `workflowId`; releasing "whatever is current" instead of this
 * exact generation would drop that replacement's live claim and strand it
 * without local epoch bytes. `release()` no-ops (`'not-held'`) when the
 * registry has moved past `acquiredEpoch`, so this call is always safe to
 * make regardless of what has happened to the entry since.
 *
 * A full durable `release()`, not a local-only `forgetLocalClaim()`: the
 * acquire this undoes durably wrote BOTH `wf-owner-epoch:<id>` and
 * `wf-owner-holder:<id>`, and it is specifically the durable holder record
 * that would otherwise block a legitimate replacement's own acquire — merely
 * clearing this engine's local cache would leave that durable block in place.
 * Swallows a lost-race/thrown release the same way every other best-effort
 * claim release in this codebase does (see `complete.ts`'s
 * `releaseWorkflowClaimAfterTerminalSettlement`): a failed release here just
 * leaves the claim for TTL/grace expiry, never worse than not attempting it.
 * `release()` itself already forgets its LOCAL entry on a thrown durable
 * error (identity/epoch-guarded), so this call needs no matching cleanup of
 * its own to stop the renewal task from renewing a claim nothing drives.
 */
export async function releaseFreshlyAcquiredResumeClaim(
  internals: EngineInternals,
  workflowId: string,
  acquiredEpoch: number,
): Promise<void> {
  const registry = internals.workflowClaimRegistry;
  if (registry === null) return;
  try {
    await registry.release(workflowId, acquiredEpoch);
  } catch {
    // Best-effort — see this function's doc.
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
