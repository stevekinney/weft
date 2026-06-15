import { KEYS } from '../../storage/interface.ts';
import { encode } from '../codec.ts';
import { assertPayloadWithinLimit } from '../payload-size.ts';
import { stageAtomicWorkflowCommitSideEffects } from './checkpoint-side-effects.ts';
import type { EngineInternals } from './internals.ts';

/**
 * Engine-side handler for `ctx.setFinalizerState(value)` (issue #446). Durably
 * records the payload the engine will pass to the workflow's definition-level
 * `finalizer` activity when it drives cancel/timeout teardown.
 *
 * The value is staged as a pending atomic side-effect — a `put` of
 * {@link KEYS.finalizerState} — so it commits with the next checkpoint or the
 * terminal `updateWorkflowState` batch (`includePendingAtomicSideEffects` is set
 * for terminal transitions). That makes the write atomic with the very
 * transition that triggers teardown: a cancel arriving before the next
 * checkpoint still flushes the staged op in the terminal batch, so the finalizer
 * always sees the resource id. The staged op inherits the lease-epoch fence
 * (#470) for free, since checkpoint and terminal commits route through
 * `commitFencedWorkflowStateOperations`.
 *
 * Oversized payloads are rejected before staging (the same hostile-input guard
 * activity results use). A call made once the workflow is already terminalizing
 * — e.g. from an `onCancel` handler, which runs after the terminal batch has
 * already taken the pending side-effects — is a no-op: the staged op has no
 * future commit to ride and is cleared on terminal cleanup. A development
 * warning is emitted so the footgun is visible, but no error is thrown.
 */
export function recordFinalizerState(
  internals: EngineInternals,
  workflowId: string,
  value: unknown,
): void {
  // Terminalizing check FIRST — before payload validation or encoding. A late
  // call (e.g. from an `onCancel` handler, which runs after the terminal batch
  // already took the pending side-effects) is a structural no-op: it has no
  // future commit to ride. Validating the payload before this guard would let an
  // oversized late call THROW out of the cancellation-teardown path that this
  // method documents as ignored — changing teardown behavior. So the guard wins.
  if (internals.terminalizingWorkflows.has(workflowId)) {
    if (internals.options.development) {
      console.warn(
        `[weft] ctx.setFinalizerState() called for workflow "${workflowId}" after it began terminalizing; ` +
          `the value is ignored. Record finalizer state while the workflow is still running.`,
      );
    }
    return;
  }

  assertPayloadWithinLimit(value, internals.options.payloadSizePolicy.maxBytes, 'finalizer state');

  stageAtomicWorkflowCommitSideEffects(internals, workflowId, {
    conditions: [],
    operations: [{ type: 'put', key: KEYS.finalizerState(workflowId), value: encode(value) }],
  });
}
