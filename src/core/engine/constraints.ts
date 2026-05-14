import type { ConstraintCheckState } from '../constraint.ts';
import { ConstraintViolatedEvent } from '../events.ts';
import type { OperationOutcome } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import type { CapturedRejectionReason } from './strategy-helpers.ts';

export type ConstraintCallbacks = {
  cancelWorkflowInStrategy: (workflowId: string) => void;
  dispatchEvent: (event: Event) => boolean;
  failWorkflow: (workflowId: string, error: Error) => Promise<void>;
  feedOperationResult: (
    workflowId: string,
    outcome: OperationOutcome,
    originalError?: CapturedRejectionReason,
  ) => void;
};

/**
 * Evaluate all registered constraints for a workflow at the current checkpoint.
 *
 * Returns `true` if any constraint was violated and a 'fail' or 'compensate'
 * reaction was triggered (meaning the operation should not proceed). Returns
 * `false` if all constraints passed or only 'warn' violations occurred.
 *
 * **Note**: Constraints are only evaluated when the inline execution strategy
 * is active. Worker execution mode cannot reach this code path with
 * constraints present — `register()` throws at registration time if
 * constraints are supplied while `inlineStrategy` is `null`, so the
 * `!context` guard here only fires for benign cases (e.g. the workflow has
 * already terminated or the context was cleared mid-evaluation).
 */
// oxlint-disable-next-line complexity -- ID:core-engine-evaluate-constraints-complexity
export async function evaluateConstraints(
  internals: EngineInternals,
  workflowId: string,
  callbacks: ConstraintCallbacks,
): Promise<boolean> {
  const context = internals.inlineStrategy?.getContext(workflowId);
  if (!context) return false;

  const registration = internals.registrations.get(context.workflowType);
  const constraints = registration?.constraints;
  if (!constraints || constraints.length === 0) return false;

  // Build the minimal snapshot passed to check(). Only id, type, and a
  // fixed status of 'running' are available — constraints are evaluated
  // mid-execution, before the workflow has a result or final status.
  // To inspect external state, capture it in the enclosing scope instead.
  const stateSnapshot: ConstraintCheckState = {
    id: workflowId,
    type: context.workflowType,
    status: 'running',
  };

  for (const definition of constraints) {
    let violated: boolean;
    try {
      const result = definition.check(stateSnapshot);
      violated = !(result instanceof Promise ? await result : result);
    } catch (error) {
      // A throwing check is treated as a violation so the workflow doesn't
      // silently continue in an unknown state. Log the original error to aid
      // debugging — without this, users would see only the constraint
      // violation message with no indication their check() is broken.
      console.warn(`[weft] Constraint "${definition.name}" check() threw an error:`, error);
      violated = true;
    }

    if (!violated) continue;

    callbacks.dispatchEvent(
      new ConstraintViolatedEvent(
        workflowId,
        definition.name,
        definition.scope,
        definition.onViolation,
      ),
    );

    if (definition.onViolation === 'warn') {
      console.warn(
        `[weft] Constraint "${definition.name}" (scope: ${definition.scope}) violated on workflow "${workflowId}" — continuing (onViolation: 'warn')`,
      );
      continue;
    }

    // Stop at first actionable violation — remaining constraints are not evaluated.
    const violationError = new Error(
      `Constraint violated: ${definition.name} (scope: ${definition.scope})`,
    );

    if (definition.onViolation === 'fail') {
      // 'fail': bypass saga — directly mark the workflow failed without
      // throwing into the generator. Any active ctx.saga() will NOT run
      // its compensators. Use 'compensate' if you want compensation to run.
      // Cancel the workflow in the strategy first to release the generator,
      // context, and abort controller — same as terminateWorkflow does.
      callbacks.cancelWorkflowInStrategy(workflowId);
      await callbacks.failWorkflow(workflowId, violationError);
    } else {
      // 'compensate': throw into the generator. If an active ctx.saga() is
      // wrapping the current step it will catch the error, run its registered
      // compensators in reverse, and then re-throw, completing the workflow failure.
      callbacks.feedOperationResult(
        workflowId,
        {
          status: 'failed',
          error: violationError.message,
          errorName: violationError.name,
          failureCategory: 'application',
        },
        { value: violationError },
      );
    }
    return true;
  }

  return false;
}
