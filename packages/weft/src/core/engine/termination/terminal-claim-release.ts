/**
 * Releasing this engine's `workflow-lease` claim once a terminal write has committed,
 * shared by `completeWorkflow`, `failWorkflow`, and `terminateWorkflow` in `complete.ts`.
 *
 * @module core/engine/termination/terminal-claim-release
 */
import type { EngineInternals } from '../internals.ts';

/**
 * Release this engine's `workflow-lease` claim (if any) once a terminal
 * transition has durably committed. Without this, `completeWorkflow`,
 * `failWorkflow`, and `terminateWorkflow` (cancel/timeout) leave a terminated
 * workflow's claim registry entry in place — the recurring renewal pass
 * (`workflow-claim-renewal-task.ts`) keeps renewing it, and the held set only
 * shrinks via retention, purge, or engine disposal, unboundedly inflating
 * active claims and renewal writes on a long-lived engine with lengthy or
 * disabled retention.
 *
 * Must run AFTER the terminal commit resolved (never before): a `'self'`-
 * fenced write (completeWorkflow/failWorkflow) still needs this engine's
 * claim to land, and even an `'external-terminal'`-fenced write
 * (terminateWorkflow) needs the ordering fixed relative to the state
 * transition it accompanies. Best-effort, matching
 * `WorkflowClaimRegistry.releaseAll()`'s own posture: a lost CAS or a storage
 * error here just leaves the claim for TTL/grace expiry — strictly no worse
 * than today's behavior, and never worth failing an already-committed
 * terminal transition over. A harmless no-op when this engine holds no claim
 * for `workflowId` (an `'external-terminal'` writer that never actually
 * owned the workflow, or `ownership: 'none'`/`'lease'`, where
 * `workflowClaimRegistry` is `null`).
 *
 * Called BEFORE this engine's own in-process result-waiter settlement
 * (`notifyCompletionWaiters`'s `resolver.resolve()`, or this file's own
 * `resolver.reject()` calls), not after: resolving/rejecting a `Promise` a
 * second time is a documented no-op, so releasing first and then settling is
 * safe even if a concurrent cross-engine result poll
 * (`handle-result.ts`'s `deferToLocalTerminalDeliveryIfPending`) observes "no
 * local epoch" and settles the SAME shared waiter itself first — both paths
 * derive the identical result from the same durably-committed terminal
 * state. Releasing AFTER, by contrast, would let an external caller that
 * merely awaited `handle.result()` observe completion before the claim
 * release it might depend on (e.g. a subsequent reclaim-scan assertion in a
 * test) has actually happened, since `resolve()`/`reject()` only schedules
 * the awaiting `.then()` as a later microtask — it proves nothing about
 * synchronous code still running after it in this same function.
 *
 * `capturedEpoch` MUST be read synchronously (no intervening `await`)
 * immediately after the terminal write commits — never re-read fresh at the
 * top of this function. Every call site already awaits at least one thing
 * (`releaseWorkflowConcurrencySlot`, or this file's own cleanup/notify calls)
 * between the commit and this call; `onTerminalConflict: 'start-new'` can
 * replace the workflow and install a NEW registry entry for the same id
 * during that exact gap. Releasing unconditionally would then delete the
 * REPLACEMENT's holder and stop its renewal instead of the generation that
 * actually completed — the release is therefore conditioned on the registry
 * still tracking the exact epoch this call captured, mirroring
 * `confirmStillRunningOrReleaseFreshClaim`'s same generation-safety pattern
 * in `workflow-claim-reclaim-target.ts`.
 */
export function captureCurrentClaimEpoch(
  internals: EngineInternals,
  workflowId: string,
): number | null {
  return internals.workflowClaimRegistry?.currentEpoch(workflowId) ?? null;
}

export async function releaseWorkflowClaimAfterTerminalSettlement(
  internals: EngineInternals,
  workflowId: string,
  capturedEpoch: number | null,
): Promise<void> {
  const registry = internals.workflowClaimRegistry;
  if (registry === null || capturedEpoch === null) return;
  if (registry.currentEpoch(workflowId) !== capturedEpoch) return;
  try {
    // `expectedEpoch` closes the same window this function's own pre-check
    // narrows but cannot fully close on its own (WFT-134 review round 2,
    // issue B): a replacement can still land between the check above and
    // this call. `release()` re-verifies internally after its own
    // in-flight-renewal await, so passing the captured epoch here is strictly
    // more conservative than the bare call — it can only additionally no-op,
    // never additionally release.
    await registry.release(workflowId, capturedEpoch);
  } catch {
    // Best-effort — see this function's doc.
  }
}
