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
    const violated = await isConstraintViolated(definition, stateSnapshot);

    if (!violated) continue;

    dispatchConstraintViolation(callbacks, workflowId, definition);

    if (definition.onViolation === 'warn') {
      warnConstraintViolation(workflowId, definition);
      continue;
    }

    // Stop at first actionable violation — remaining constraints are not evaluated.
    const violationError = new Error(
      `Constraint violated: ${definition.name} (scope: ${definition.scope})`,
    );

    if (definition.onViolation === 'fail') {
      await failConstraintViolation(callbacks, workflowId, violationError);
    } else {
      compensateConstraintViolation(callbacks, workflowId, violationError);
    }
    return true;
  }

  return false;
}

type ConstraintDefinition = NonNullable<RegistrationEntry['constraints']>[number];
type RegistrationEntry =
  EngineInternals['registrations'] extends Map<string, infer Entry> ? Entry : never;

async function isConstraintViolated(
  definition: ConstraintDefinition,
  stateSnapshot: ConstraintCheckState,
): Promise<boolean> {
  try {
    const result = definition.check(stateSnapshot);
    return !(result instanceof Promise ? await result : result);
  } catch (error) {
    console.warn(`[weft] Constraint "${definition.name}" check() threw an error:`, error);
    return true;
  }
}

function dispatchConstraintViolation(
  callbacks: ConstraintCallbacks,
  workflowId: string,
  definition: ConstraintDefinition,
): void {
  callbacks.dispatchEvent(
    new ConstraintViolatedEvent(
      workflowId,
      definition.name,
      definition.scope,
      definition.onViolation,
    ),
  );
}

function warnConstraintViolation(workflowId: string, definition: ConstraintDefinition): void {
  console.warn(
    `[weft] Constraint "${definition.name}" (scope: ${definition.scope}) violated on workflow "${workflowId}" — continuing (onViolation: 'warn')`,
  );
}

async function failConstraintViolation(
  callbacks: ConstraintCallbacks,
  workflowId: string,
  violationError: Error,
): Promise<void> {
  callbacks.cancelWorkflowInStrategy(workflowId);
  await callbacks.failWorkflow(workflowId, violationError);
}

function compensateConstraintViolation(
  callbacks: ConstraintCallbacks,
  workflowId: string,
  violationError: Error,
): void {
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
