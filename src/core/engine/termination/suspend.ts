import { KEYS } from '../../../storage/interface.ts';
import { encode } from '../../codec.ts';
import { WorkflowSuspendedEvent } from '../../events.ts';
import { buildTerminalWorkflowIndexOperations } from '../attributes-tags.ts';
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
 * it. The pending `deadline:` timer is cancelled here and re-armed at the same
 * absolute fire time on resume (or fires immediately if already past).
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

    const updatedAt = internals.options.getNow();
    const updatedState = { ...state, status: 'suspended' as const, updatedAt };

    await callbacks.commitWorkflowStateOperations(state, [
      // 'suspended' is non-terminal, so the terminal-index builder is a no-op
      // here; included for symmetry with the other state-transition chokepoints.
      ...buildTerminalWorkflowIndexOperations(state, updatedState),
      { type: 'put', key: KEYS.workflow(workflowId), value: encode(updatedState) },
      ...buildWorkflowVisibilityIndexTransition(workflowId, state, updatedState).batchOps,
    ]);

    // Stop driving the live run WITHOUT aborting it: parkWorkflow evicts the
    // run's context/generator/turn from the inline strategy so a late activity
    // completion cannot advance it past the suspend point, while leaving its
    // AbortController unfired. Inside the same serialized section as the flip.
    internals.inlineStrategy.parkWorkflow(workflowId);
    dropQueuedInlineWorkflowStart(internals, workflowId);

    // Evict in-memory execution state so a subsequent resume reloads from the
    // durable checkpoint, and sever the wake paths for in-flight operations so a
    // post-suspend signal/update buffers durably instead of driving the gone
    // generator. Preserve the durable checkpoint (storage) and `services`.
    internals.checkpoints.delete(workflowId);
    internals.parkedInlineWorkflows.delete(workflowId);
    evictSuspendedWorkflowWaiters(internals, workflowId, callbacks);

    return true;
  });

  if (!suspended) {
    return;
  }

  // The execution deadline is absolute wall-clock and does NOT pause while
  // suspended: cancel the pending timer here; resume re-arms it at the same
  // absolute fire time (or times out immediately if already past).
  void callbacks.swallowPromiseRejection(
    internals.scheduler.cancel(`deadline:${workflowId}`, workflowId),
  );

  const event = new WorkflowSuspendedEvent(workflowId);
  callbacks.dispatchEvent(event);
  callbacks.forwardEventToHandle(workflowId, event);
}
