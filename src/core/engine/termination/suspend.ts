import type { BatchOperation } from '../../../storage/interface.ts';
import { KEYS } from '../../../storage/interface.ts';
import { encode } from '../../codec.ts';
import { WorkflowSuspendedEvent } from '../../events.ts';
import { WorkflowSuspendNotSupportedError } from '../errors.ts';
import { dropQueuedInlineWorkflowStart } from '../inline-launch-queue.ts';
import type { EngineInternals } from '../internals.ts';
import { buildWorkflowVisibilityIndexTransition } from '../workflow-indexes.ts';
import { evictSuspendedWorkflowWaiters, type TerminationCallbacks } from './cleanup.ts';

/**
 * Suspend a running workflow without terminating it: a non-terminal cousin of
 * {@link terminateWorkflow}. The workflow's status transitions `running →
 * suspended`, its durable checkpoint is preserved, and it becomes resumable via
 * `engine.resume(id)` / `handle.resume()`. Suspension is client-driven
 * preemption, so — unlike a fault — a suspended workflow is NOT auto-recovered
 * by `engine.recoverAll()`.
 *
 * Contrast with cancel/timeout, which this deliberately does NOT do:
 * - does NOT abort the workflow's `AbortController` — suspend is a pause, not a
 *   cancellation, so user code observing `ctx.signal.aborted` or registered
 *   abort listeners must not fire. The live inline run is *parked*
 *   (`parkWorkflow`: evict execution state without aborting), the same primitive
 *   the engine uses for signal-parking,
 * - does NOT run cancel handlers,
 * - does NOT settle the result promise (`handle.result()` stays pending until a
 *   later `resume()` drives the run to completion, or a `cancel()` terminates it),
 * - does NOT clean up durable output artifacts or in-memory services (the
 *   `services` value is preserved so an in-process `resume()` can reuse it),
 * - does NOT schedule terminal cleanup.
 *
 * The CAS status flip and the in-memory teardown both run inside one serialized
 * per-workflow write section with `allowedStatuses: ['running']`. If the
 * workflow already left `running` (it completed, failed, or a concurrent cancel
 * won the race), the flip is skipped and suspend is a no-op — and because the
 * teardown is gated on the flip succeeding, a workflow that lost the race keeps
 * its execution state intact.
 *
 * The teardown evicts every piece of in-memory execution state that could let a
 * post-suspend operation drive the parked run: the inline context/generator (via
 * `parkWorkflow`), the in-memory checkpoint, the parked-inline marker, and the
 * in-flight operation waiters (signal/update/sleep/review — deleted, NOT
 * resolved, so a signal arriving after suspend buffers durably and is replayed
 * on resume instead of waking a dormant operation loop against the gone
 * generator). The durable checkpoint, durable buffered signals, durable sleep
 * timers, and `workflowServices` are all left intact for resume.
 *
 * A signal that races the in-lock teardown is benign: `continueWorkflow` no-ops
 * for an evicted generator, and `persistCheckpoint` no-ops when the context and
 * in-memory checkpoint are gone — so no step can commit past the suspend point.
 *
 * `'suspended'` is neither `'running'` nor `'pending'`, and both local-ownership
 * predicates (`isInlineWorkflowLocallyOwned`, `hasLocalCheckpointOwnership`) are
 * gated on those two statuses. So once the status flips, the workflow stops
 * registering as locally owned — which is exactly what makes `recoverAll()` skip
 * it AND what lets `engine.resume()` re-drive it from storage instead of taking
 * its local-ownership early return.
 *
 * The execution deadline is absolute wall-clock time: suspension does NOT extend
 * it. The pending `deadline:` timer is deleted durably IN THE SAME COMMIT BATCH
 * as the status flip, and re-armed at the same absolute fire time on resume (or
 * fires immediately if already past). It is a durable delete rather than a
 * `scheduler.cancel()` call because the scheduler is durable-scan-based and
 * resume's re-arm is likewise durable-only (`buildTimerBatchOperations`); folding
 * the delete into the commit makes it atomic with the flip and ordered before any
 * concurrent resume, so an immediate resume cannot have its freshly re-armed
 * deadline deleted by a late fire-and-forget cancel.
 *
 * Worker execution mode is not supported: a worker run cannot be parked without
 * sending it a cancellation. To keep the contract state-dependent (suspend on a
 * non-running workflow is always a no-op), the mode check runs only AFTER the
 * status load confirms the workflow is `running`; a `running` worker workflow
 * throws {@link WorkflowSuspendNotSupportedError}, while a completed or unknown
 * one is a no-op regardless of execution mode.
 */
export async function suspendWorkflow(
  internals: EngineInternals,
  workflowId: string,
  callbacks: TerminationCallbacks,
): Promise<void> {
  const suspended = await callbacks.runSerializedWorkflowStateWrite(workflowId, async () => {
    const state = await callbacks.loadWorkflowState(workflowId);
    if (!state || state.status !== 'running') {
      // Lost the race to terminate/complete, or never running — idempotent.
      return false;
    }

    // State-dependent, not mode-dependent: only a *running* worker workflow is
    // unsupported. A non-running one already returned a no-op above.
    if (internals.inlineStrategy === null) {
      throw new WorkflowSuspendNotSupportedError(
        'suspend is only supported in inline execution mode; a worker run cannot be paused ' +
          'without cancelling it.',
      );
    }

    // Tear down ALL in-memory execution state BEFORE the durable commit. The
    // commit is suspend's only durable mutation; everything here is synchronous
    // in-memory eviction (parkWorkflow/#cleanup is pure Map deletes — no
    // generator drive, no durable-status read). Doing it first closes two races:
    //
    //   1. Signal/update delivery (`deliverBufferedSignals`) is NOT gated behind
    //      this serialized lock and only skips TERMINAL workflows ('suspended' is
    //      non-terminal). If a signal interleaved at the post-commit microtask
    //      boundary, it would find a live waiter / parked marker and wake the
    //      not-yet-evicted generator. Evicting before the commit means that by
    //      the `await` boundary the waiter and park-marker are already gone, so a
    //      concurrent signal buffers durably and replays on resume. Because the
    //      eviction here is fully synchronous, no sub-step exposes a half-torn
    //      state.
    //   2. "Durable suspended + in-memory live" divergence is structurally
    //      impossible: memory teardown precedes the only durable write. The sole
    //      remaining failure mode is the commit throwing after eviction. That is
    //      DURABLY safe but NOT live-process continuous: the durable status stays
    //      'running' with its checkpoint intact (the run is not lost), so
    //      recoverAll() re-drives it on the next Engine.create(); but in the
    //      still-live process the run is now un-driven and this handle's result()
    //      stays pending until that restart. In-process repair is intentionally
    //      NOT attempted — it would have to re-drive from storage that is, by
    //      hypothesis, the thing that just failed the commit, so it would fail
    //      too. This matches the engine's house failure posture: terminateWorkflow
    //      and completeWorkflow likewise evict in-memory state before their durable
    //      commit and rely on restart recovery if that commit throws. A live-
    //      process suspending-gate that buffers signals without evicting the waiter
    //      is the hardening path if cross-storage-fault liveness ever matters
    //      (likely alongside MultiEngine); deliberately out of scope here.
    internals.inlineStrategy.parkWorkflow(workflowId);
    dropQueuedInlineWorkflowStart(internals, workflowId);
    internals.checkpoints.delete(workflowId);
    internals.parkedInlineWorkflows.delete(workflowId);
    evictSuspendedWorkflowWaiters(internals, workflowId, callbacks);

    const updatedAt = internals.options.getNow();
    const updatedState = { ...state, status: 'suspended' as const, updatedAt };

    await callbacks.commitWorkflowStateOperations(state, [
      { type: 'put', key: KEYS.workflow(workflowId), value: encode(updatedState) },
      ...buildWorkflowVisibilityIndexTransition(workflowId, state, updatedState).batchOps,
      // Delete the absolute execution-deadline timer in the same batch as the
      // flip (atomic, lock-ordered before any resume re-arm). Symmetric to
      // resume's durable re-arm via buildTimerBatchOperations.
      ...buildDeadlineTimerDeleteOperations(workflowId, state.executionDeadline),
    ]);

    return true;
  });

  if (!suspended) {
    return;
  }

  const event = new WorkflowSuspendedEvent(workflowId);
  callbacks.dispatchEvent(event);
  callbacks.forwardEventToHandle(workflowId, event);
}

/**
 * Build the durable delete operations for a workflow's execution-deadline timer,
 * mirroring the keys written by {@link buildTimerBatchOperations} for a
 * `deadline:${workflowId}` / `execution-deadline` timer: the sortable deadline
 * key plus its stable `timer-idx:` index. Returns an empty array when the
 * workflow has no execution deadline.
 */
function buildDeadlineTimerDeleteOperations(
  workflowId: string,
  executionDeadline: number | undefined,
): BatchOperation[] {
  if (executionDeadline === undefined) {
    return [];
  }
  const timerId = `deadline:${workflowId}`;
  return [
    { type: 'delete', key: KEYS.deadline(executionDeadline, timerId) },
    { type: 'delete', key: `timer-idx:${timerId}` },
  ];
}
