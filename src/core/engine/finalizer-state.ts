import { KEYS } from '../../storage/interface.ts';
import { encode } from '../codec.ts';
import { assertPayloadWithinLimit } from '../payload-size.ts';
import { stageAtomicWorkflowCommitSideEffects } from './checkpoint-side-effects.ts';
import type { EngineInternals } from './internals.ts';

/**
 * Engine-side handler for `ctx.setFinalizerState(value)` (issue #446). Durably
 * records the payload associated with the workflow's definition-level
 * `finalizer` activity.
 *
 * This handler only records the value; the engine passes the decoded payload as
 * the finalizer's input when it drives cancel/timeout teardown (#446 Phase 2).
 *
 * The value is staged as a pending atomic side-effect — a `put` of
 * {@link KEYS.finalizerState} — that commits with whichever durable write lands
 * first: the next checkpoint/suspend commit, or, if no checkpoint runs before the
 * workflow terminates, the terminal `updateWorkflowState` batch
 * (`includePendingAtomicSideEffects` is set for terminal transitions). Either way
 * the resource id is durable before teardown is driven: a cancel arriving before
 * the next checkpoint still flushes the staged op in the terminal batch, so the
 * finalizer always sees the resource id. The staged op inherits the lease-epoch
 * fence (#470) for free, since checkpoint and terminal commits route through
 * `commitSelfWorkflowStateOperations` (completion) or
 * `commitExternalTerminalWorkflowStateOperations` (cancel/timeout/suspend —
 * ADR 0002), both in `storage-io.ts`.
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
