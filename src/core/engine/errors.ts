import type { WorkflowStatus } from '../types/identity.ts';
import { WeftError } from '../weft-error.ts';

/**
 * Thrown by {@link Engine.start} when a workflow with the requested ID already
 * exists in storage. Inspect the `workflowId` property to identify the
 * conflict. To allow deduplication semantics instead of an error, pass
 * `idempotencyKey` in {@link StartOptions}.
 *
 * @example
 * ```ts
 * import { workflow, Engine, WorkflowAlreadyExistsError } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.register(workflow({ name: 'ping' }).execute(async function* () { return 'pong'; }));
 *
 * await engine.start('ping', null, { id: 'my-ping' });
 * try {
 *   await engine.start('ping', null, { id: 'my-ping' });
 * } catch (err) {
 *   if (err instanceof WorkflowAlreadyExistsError) {
 *     console.error('already running:', err.workflowId);
 *   }
 * }
 * ```
 */
export class WorkflowAlreadyExistsError extends WeftError<'WorkflowAlreadyExistsError'> {
  readonly workflowId: string;

  constructor(workflowId: string) {
    super('WorkflowAlreadyExistsError', `Workflow with id "${workflowId}" already exists`);
    this.workflowId = workflowId;
  }
}

/**
 * Thrown by {@link Engine.deleteAll} when the supplied filter would match
 * non-terminal workflows. Narrow the filter to completed, failed, cancelled,
 * or timed-out workflows before deleting in bulk.
 *
 * @example
 * ```ts
 * import { BulkDeleteRequiresTerminalWorkflowsError } from '@lostgradient/weft';
 *
 * function shouldShowTerminalOnlyMessage(error: unknown): boolean {
 *   return error instanceof BulkDeleteRequiresTerminalWorkflowsError;
 * }
 * ```
 */
export class BulkDeleteRequiresTerminalWorkflowsError extends WeftError<'BulkDeleteRequiresTerminalWorkflowsError'> {
  constructor() {
    super('BulkDeleteRequiresTerminalWorkflowsError', 'Bulk delete matches non-terminal workflows');
  }
}

/**
 * Thrown by committed bulk operations when the supplied confirmation token no
 * longer matches the current dry-run scope. Run a fresh preview and commit
 * with the returned token.
 *
 * @example
 * ```ts
 * import { BulkOperationConfirmationError } from '@lostgradient/weft';
 *
 * function needsFreshBulkPreview(error: unknown): boolean {
 *   return error instanceof BulkOperationConfirmationError;
 * }
 * ```
 */
export class BulkOperationConfirmationError extends WeftError<'BulkOperationConfirmationError'> {
  constructor() {
    super(
      'BulkOperationConfirmationError',
      'Bulk confirmation token does not match the current dry-run scope',
    );
  }
}

export type MissingWorkflowSample = {
  readonly type: string;
  readonly workflowId: string;
};

const MISSING_WORKFLOW_SAMPLE_LIMIT = 20;
const MISSING_TYPE_MESSAGE_LIMIT = 10;

function summarizeMissingWorkflowTypes(missingTypes: readonly string[]): string {
  const visibleTypes = missingTypes.slice(0, MISSING_TYPE_MESSAGE_LIMIT);
  const hiddenTypeCount = missingTypes.length - visibleTypes.length;
  return hiddenTypeCount > 0
    ? `${visibleTypes.join(', ')} (+${hiddenTypeCount} more)`
    : visibleTypes.join(', ');
}

/**
 * Thrown by {@link Engine.create} and {@link Engine.recoverAll} when storage
 * contains running workflows whose workflow type has not been registered on
 * the engine. The structured sample list is capped so logs remain bounded,
 * while `missingTypes` and `registeredTypes` carry the full sorted type lists.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowTypeNotRegisteredForRecoveryError } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * try {
 *   await engine.recoverAll();
 * } catch (error) {
 *   if (error instanceof WorkflowTypeNotRegisteredForRecoveryError) {
 *     console.error('missing workflow types:', error.missingTypes);
 *   }
 * }
 * ```
 */
export class WorkflowTypeNotRegisteredForRecoveryError extends WeftError<'WorkflowTypeNotRegisteredForRecoveryError'> {
  readonly registeredTypes: readonly string[];
  readonly missingTypes: readonly string[];
  readonly missingWorkflowSamples: ReadonlyArray<MissingWorkflowSample>;
  readonly missingWorkflowCount: number;
  readonly samplesTruncated: boolean;

  constructor(parameters: {
    registeredTypes: Iterable<string>;
    missingWorkflows: ReadonlyArray<MissingWorkflowSample>;
  }) {
    const missingWorkflowCount = parameters.missingWorkflows.length;
    const missingTypes = [
      ...new Set(parameters.missingWorkflows.map((workflow) => workflow.type)),
    ].toSorted();
    const registeredTypes = [...parameters.registeredTypes].toSorted();
    const summarizedTypes = summarizeMissingWorkflowTypes(missingTypes);
    super(
      'WorkflowTypeNotRegisteredForRecoveryError',
      `Cannot recover ${missingWorkflowCount} running workflow(s): workflow type(s) not registered: ${summarizedTypes}. ` +
        'Register the missing workflow types before calling `recoverAll()`, or pass ' +
        '`{ acknowledgeUnknownWorkflowTypes: true }` (dangerous — see migration docs).',
    );
    this.registeredTypes = registeredTypes;
    this.missingTypes = missingTypes;
    this.missingWorkflowSamples = parameters.missingWorkflows
      .slice(0, MISSING_WORKFLOW_SAMPLE_LIMIT)
      .map((workflow) => ({ ...workflow }));
    this.missingWorkflowCount = missingWorkflowCount;
    this.samplesTruncated = missingWorkflowCount > MISSING_WORKFLOW_SAMPLE_LIMIT;
  }
}

/**
 * Thrown by {@link Engine.create} when a definition map key does not match the
 * definition's runtime `name`. The factory uses map keys for type inference,
 * so mismatches are rejected before registration to keep the inferred type and
 * runtime registry aligned.
 *
 * @example
 * ```ts
 * import { activity, Engine, EngineCreateNameMismatchError } from '@lostgradient/weft';
 *
 * const farewell = activity({ name: 'farewell', execute: async () => 'bye' });
 * try {
 *   await Engine.create({ activities: { greet: farewell } });
 * } catch (error) {
 *   if (error instanceof EngineCreateNameMismatchError) {
 *     console.error(error.expectedName, error.actualName);
 *   }
 * }
 * ```
 */
export class EngineCreateNameMismatchError extends WeftError<'EngineCreateNameMismatchError'> {
  readonly definitionKind: 'workflow' | 'activity';
  readonly expectedName: string;
  readonly actualName: string;

  constructor(definitionKind: 'workflow' | 'activity', expectedName: string, actualName: string) {
    super(
      'EngineCreateNameMismatchError',
      `Engine.create() ${definitionKind} definition key "${expectedName}" does not match definition name "${actualName}"`,
    );
    this.definitionKind = definitionKind;
    this.expectedName = expectedName;
    this.actualName = actualName;
  }
}

/**
 * Thrown to settle a pending `handle.result()` promise when the engine is
 * disposed while the workflow is still in flight. Disposing the engine tears
 * down the machinery that would eventually resolve the result, so awaiting
 * callers receive this rejection instead of a promise that never settles.
 *
 * @example
 * ```ts
 * import { EngineDisposedError } from '@lostgradient/weft';
 *
 * function isShutdownDuringResult(error: unknown): boolean {
 *   return error instanceof EngineDisposedError;
 * }
 * ```
 */
export class EngineDisposedError extends WeftError<'EngineDisposedError'> {
  constructor() {
    super('EngineDisposedError', 'Engine was disposed before the workflow completed');
  }
}

/**
 * Thrown by engine APIs that need a workflow to be present in storage but
 * cannot find one with the given ID. Inspect `workflowId` to identify the
 * missing record.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowNotFoundError } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * try {
 *   await engine.cancel('does-not-exist');
 * } catch (err) {
 *   if (err instanceof WorkflowNotFoundError) {
 *     console.error('cannot cancel — no such workflow:', err.workflowId);
 *   }
 * }
 * ```
 */
export class WorkflowNotFoundError extends WeftError<'WorkflowNotFoundError'> {
  readonly workflowId: string;

  constructor(workflowId: string) {
    super('WorkflowNotFoundError', `Workflow "${workflowId}" not found`);
    this.workflowId = workflowId;
  }
}

/**
 * Thrown by {@link Engine.start} and other registry-driven entry points when
 * the caller asks for a workflow type that was never registered. Distinct
 * from `WorkflowNotFoundError`, which signals an unknown workflow ID at
 * runtime.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowNotRegisteredError } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * try {
 *   await engine.start('checkout', { orderId: 'order-1' });
 * } catch (err) {
 *   if (err instanceof WorkflowNotRegisteredError) {
 *     console.error('register the workflow first:', err.workflowType);
 *   }
 * }
 * ```
 */
export class WorkflowNotRegisteredError extends WeftError<'WorkflowNotRegisteredError'> {
  readonly workflowType: string;

  constructor(workflowType: string) {
    super('WorkflowNotRegisteredError', `No workflow registered with name "${workflowType}"`);
    this.workflowType = workflowType;
  }
}

/**
 * Thrown by {@link Engine.suspend} when invoked on an engine running in worker
 * execution mode. Suspension parks the live run without aborting it, which the
 * inline strategy supports directly; a worker run cannot be paused without
 * sending it a cancellation, so the engine refuses rather than silently
 * aborting. Suspend/resume in worker mode is a scoped follow-up.
 *
 * @example
 * ```ts
 * import { Engine, WorkflowSuspendNotSupportedError } from '@lostgradient/weft';
 *
 * async function trySuspend(engine: Engine, id: string) {
 *   try {
 *     await engine.suspend(id);
 *   } catch (err) {
 *     if (err instanceof WorkflowSuspendNotSupportedError) {
 *       // worker-mode engine: cancel instead, or run inline
 *     }
 *   }
 * }
 * void trySuspend;
 * ```
 */
export class WorkflowSuspendNotSupportedError extends WeftError<'WorkflowSuspendNotSupportedError'> {
  constructor(message: string) {
    super('WorkflowSuspendNotSupportedError', message);
  }
}

/**
 * Thrown when the engine cannot resolve an activity name to a registered
 * function during dispatch. The per-workflow {@link ActivityRegistry} (built
 * from `workflow(...).activities({...})`) is consulted first; if the workflow
 * type is unknown or the activity name is missing there, the engine falls back
 * to the global registry. When neither resolves, this error is raised with the
 * (bounded) workflow type and activity name so logs and operator surfaces can
 * pin the misconfiguration without leaking high-cardinality detail.
 *
 * Replaces the prior unstructured `Error("No activity registered with name X")`
 * thrown deep in `resolveActivityFunction`.
 *
 * @example
 * ```ts
 * import { workflow, ActivityResolutionError } from '@lostgradient/weft';
 *
 * function isMissingActivity(error: unknown): boolean {
 *   return error instanceof ActivityResolutionError;
 * }
 * ```
 */
export class ActivityResolutionError extends WeftError<'ActivityResolutionError'> {
  readonly workflowType: string;
  readonly activityName: string;

  constructor(workflowType: string, activityName: string) {
    super(
      'ActivityResolutionError',
      `No activity registered with name "${activityName}" for workflow type "${workflowType}". ` +
        'Register the activity via `workflow({ name }).activities({ ... })` on the workflow that runs it, ' +
        'or via `engine.register(activityDefinition)` to make it available to every workflow on that engine instance.',
    );
    this.workflowType = workflowType;
    this.activityName = activityName;
  }
}

/**
 * Thrown by {@link Engine.startOrSignal} when the target workflow already exists
 * and is in a terminal state (completed, failed, cancelled, or timed out). A
 * terminal run cannot accept a signal and must not be silently replaced, so
 * `startOrSignal` surfaces this conflict instead of starting a fresh run under
 * the same id or dropping the signal.
 *
 * Inspect `workflowId` to identify the conflicting run and `status` to see why
 * it was rejected. To deliberately start a new run, choose a different id (or
 * idempotency key); to deliver to a fresh run, terminal-state reuse is not a
 * supported policy.
 *
 * @example
 * ```ts
 * import { StartOrSignalConflictError } from '@lostgradient/weft';
 *
 * function isTerminalStartOrSignalConflict(error: unknown): boolean {
 *   return error instanceof StartOrSignalConflictError;
 * }
 * ```
 */
export class StartOrSignalConflictError extends WeftError<'StartOrSignalConflictError'> {
  readonly workflowId: string;
  readonly status: WorkflowStatus;

  constructor(workflowId: string, status: WorkflowStatus) {
    super(
      'StartOrSignalConflictError',
      `Workflow "${workflowId}" is already in terminal state "${status}" and cannot accept a ` +
        'startOrSignal: a terminal run cannot be signalled and is not replaced. Use a different ' +
        'id or idempotency key to start a new run.',
    );
    this.workflowId = workflowId;
    this.status = status;
  }
}

/**
 * Thrown by {@link Engine.start} / {@link Engine.startOrSignal} when an
 * `idempotencyKey` resolves to a workflow that no longer exists — its run was
 * purged or bulk-deleted while the durable `start-idem:` mapping (intentionally
 * not swept on cleanup) lived on. The key is "spent": it can neither return the
 * gone run nor safely start a fresh one under the same key (a concurrent caller
 * may still hold the mapping). Use a different idempotency key to start anew.
 *
 * @example
 * ```ts
 * import { IdempotencyKeyPurgedError } from '@lostgradient/weft';
 *
 * function isPurgedIdempotencyKey(error: unknown): boolean {
 *   return error instanceof IdempotencyKeyPurgedError;
 * }
 * ```
 */
export class IdempotencyKeyPurgedError extends WeftError<'IdempotencyKeyPurgedError'> {
  readonly workflowId: string;

  constructor(workflowId: string) {
    super(
      'IdempotencyKeyPurgedError',
      `The idempotency key maps to workflow "${workflowId}", which no longer exists (it was ` +
        'purged or deleted). Use a different idempotency key to start a new run.',
    );
    this.workflowId = workflowId;
  }
}

export { PersistedDataIncompatibleError } from '../persisted-data-incompatible-error.ts';
