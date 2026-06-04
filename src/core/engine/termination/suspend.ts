import { KEYS } from '../../../storage/interface.ts';
import { encode } from '../../codec.ts';
import { WorkflowSuspendedEvent } from '../../events.ts';
import { buildTerminalWorkflowIndexOperations } from '../attributes-tags.ts';
import { WorkflowSuspendNotSupportedError } from '../errors.ts';
import { dropQueuedInlineWorkflowStart } from '../inline-launch-queue.ts';
import type { EngineInternals } from '../internals.ts';
import { buildWorkflowVisibilityIndexTransition } from '../workflow-indexes.ts';
import type { TerminationCallbacks } from './cleanup.ts';

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
 *   later `resume()` drives the run to completion),
 * - does NOT clean up durable output artifacts or in-memory services (the
 *   `services` value is preserved so an in-process `resume()` can reuse it),
 * - does NOT schedule terminal cleanup.
 *
 * The CAS status flip and the in-memory teardown both run inside one serialized
 * per-workflow write section with `allowedStatuses: ['running']`. If the
 * workflow already left `running` (it completed, failed, or a concurrent cancel
 * won the race), the flip is skipped and suspend is a no-op — and because the
 * teardown is gated on the flip succeeding, a workflow that lost the race keeps
 * its execution state intact. Holding the lock across the flip and the park
 * closes the checkpoint-commit race: no in-flight checkpoint can commit a step
 * past the suspend point between the flip and the park.
 *
 * `'suspended'` is neither `'running'` nor `'pending'`, and both local-ownership
 * predicates (`isInlineWorkflowLocallyOwned`, `hasLocalCheckpointOwnership`) are
 * gated on those two statuses. So once the status flips, the workflow stops
 * registering as locally owned — which is exactly what makes `recoverAll()` skip
 * it AND what lets `engine.resume()` re-drive it from storage instead of taking
 * its local-ownership early return. The in-memory checkpoint and parked-inline
 * entry are evicted here so resume reloads cleanly from the durable checkpoint;
 * the durable checkpoint in storage and the `workflowServices` entry are left
 * intact.
 *
 * Worker execution mode is not yet supported: a worker run cannot be parked
 * without sending it a cancellation, so suspend throws
 * {@link WorkflowExecutionModeError} rather than silently aborting it.
 */
export async function suspendWorkflow(
  internals: EngineInternals,
  workflowId: string,
  callbacks: TerminationCallbacks,
): Promise<void> {
  if (internals.inlineStrategy === null) {
    throw new WorkflowSuspendNotSupportedError(
      'suspend is only supported in inline execution mode; a worker run cannot be paused ' +
        'without cancelling it.',
    );
  }
  const inlineStrategy = internals.inlineStrategy;

  const suspended = await callbacks.runSerializedWorkflowStateWrite(workflowId, async () => {
    const state = await callbacks.loadWorkflowState(workflowId);
    if (!state || state.status !== 'running') {
      // Lost the race to terminate/complete, or never running — idempotent.
      return false;
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
    // run's context/turn from the inline strategy so a late activity completion
    // cannot advance it past the suspend point, while leaving its
    // AbortController unfired. Inside the same serialized section as the flip.
    inlineStrategy.parkWorkflow(workflowId);
    dropQueuedInlineWorkflowStart(internals, workflowId);

    // Evict in-memory execution state so a subsequent resume reloads from the
    // durable checkpoint. Preserve the durable checkpoint (in storage) and the
    // non-serialized `services` value (needed for an in-process resume). The
    // result resolver is intentionally left in place: result() stays pending.
    internals.checkpoints.delete(workflowId);
    internals.parkedInlineWorkflows.delete(workflowId);

    return true;
  });

  if (!suspended) {
    return;
  }

  // The execution deadline clock does not run while suspended: cancel the
  // pending deadline timer. Resume re-arms it from the persisted
  // `executionDeadline` if one is present.
  void callbacks.swallowPromiseRejection(
    internals.scheduler.cancel(`deadline:${workflowId}`, workflowId),
  );

  const event = new WorkflowSuspendedEvent(workflowId);
  callbacks.dispatchEvent(event);
  callbacks.forwardEventToHandle(workflowId, event);
}
