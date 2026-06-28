import { serializeCheckpoint } from '../../checkpoint.ts';
import { WorkflowStartedEvent } from '../../events.ts';
import { StartWorkflowValidationError } from '../../start-workflow-validation.ts';
import type { Checkpoint, StartOptions, WorkflowState } from '../../types.ts';
import type { EngineInternals } from '../internals.ts';
import { type LifecycleCallbacks, type RegistrationEntry } from './shared.ts';

export function runWorkflowStartInterceptor(
  _internals: EngineInternals,
  workflowId: string,
  workflowType: string,
  input: unknown,
  parentHeaders: Map<string, string> | undefined,
  callbacks: LifecycleCallbacks,
): Map<string, string> | undefined {
  const composedInterceptor = callbacks.getComposedWorkflowInterceptor();
  if (!composedInterceptor) {
    return undefined;
  }

  const headers = new Map<string, string>();
  if (parentHeaders) {
    for (const [key, value] of parentHeaders) {
      headers.set(key, value);
    }
  }

  let capturedHeaders: Map<string, string> | undefined;
  composedInterceptor.workflowStart(
    {
      workflowId,
      workflowType,
      input,
      headers,
    },
    (interception) => {
      capturedHeaders = new Map(interception.headers);
    },
  );

  return capturedHeaders;
}

export function startWorkflowExecution(
  internals: EngineInternals,
  workflowId: string,
  workflowExecutionToken: string | undefined,
  workflowType: string,
  input: unknown,
  checkpoint: Checkpoint,
  nestingDepth: number,
  executionDeadline: number | undefined,
  executionStateOwnerId: string,
  _callbacks?: LifecycleCallbacks,
): void {
  // Skip the map entry for the common non-nested case — readers fall back
  // to 0. Saves per-workflow V8 Map overhead (~80 bytes) on the hot path.
  if (nestingDepth !== 0) {
    internals.workflowNestingDepths.set(workflowId, nestingDepth);
  }
  // Cache the workflow type for synchronous activity-registry lookup on the
  // dispatch hot path. Cleared on terminal cleanup (see termination/cleanup.ts).
  internals.workflowTypeByWorkflowId.set(workflowId, workflowType);
  internals.strategy.startWorkflow({
    workflowId,
    ...(workflowExecutionToken !== undefined && { workflowExecutionToken }),
    workflowType,
    input,
    checkpoint: serializeCheckpoint(checkpoint),
    nestingDepth,
    executionStateOwnerId,
    startedAt: checkpoint.createdAt,
    sleepReferenceTime: checkpoint.createdAt,
    ...(executionDeadline !== undefined && { deadline: executionDeadline }),
    ...(internals.workflowHeaders.has(workflowId) && {
      headers: [...internals.workflowHeaders.get(workflowId)!],
    }),
  });
}

export function beginWorkflowExecution(
  internals: EngineInternals,
  workflowId: string,
  workflowExecutionToken: string | undefined,
  workflowType: string,
  input: unknown,
  checkpoint: Checkpoint,
  executionDeadline: number | undefined,
  executionStateOwnerId: string,
  _registration: RegistrationEntry,
  callbacks: LifecycleCallbacks,
  onStarted?: () => void,
): void {
  const nestingDepth = internals.pendingNestingDepth ?? 0;
  internals.pendingNestingDepth = undefined;

  if (internals.inlineStrategy !== null) {
    callbacks.queueInlineWorkflowExecutionStart({
      workflowId,
      ...(workflowExecutionToken !== undefined && { workflowExecutionToken }),
      workflowType,
      input,
      checkpoint,
      nestingDepth,
      executionDeadline,
      executionStateOwnerId,
      // Conditional spread, not shorthand: under exactOptionalPropertyTypes an
      // explicit `onStarted: undefined` is not assignable to the optional
      // property, so only include the key when a liveness callback was provided.
      ...(onStarted !== undefined && { onStarted }),
    });
    return;
  }

  callbacks.dispatchEvent(new WorkflowStartedEvent(workflowId, workflowType, input));
  startWorkflowExecution(
    internals,
    workflowId,
    workflowExecutionToken,
    workflowType,
    input,
    checkpoint,
    nestingDepth,
    executionDeadline,
    executionStateOwnerId,
    callbacks,
  );
  // Worker/non-inline path executes synchronously above, so liveness is already
  // satisfied by the time this returns.
  onStarted?.();
}

/**
 * `defer: false` is an inline-only liveness gate: it awaits the moment the
 * generator is first driven. A worker-mode start queues to the Worker transport
 * (no inline liveness to await), and a delayed start has not begun executing at
 * all — so both reject rather than silently behaving like `defer: true`.
 */
export function assertDeferSupported(
  internals: EngineInternals,
  options: StartOptions | undefined,
  isDelayedStart: boolean,
): void {
  if (options?.defer !== false) {
    return;
  }
  if (internals.inlineStrategy === null) {
    throw new StartWorkflowValidationError(
      'options.defer: false is only supported in inline execution mode; a ' +
        'worker-mode start cannot be awaited for inline liveness. Use ' +
        'workflowExecutionMode: "inline" or remove defer.',
    );
  }
  if (isDelayedStart) {
    throw new StartWorkflowValidationError(
      'options.defer: false is incompatible with a delayed start ' +
        '(startAt/startAfter): a scheduled run has not begun executing, so there ' +
        'is no liveness to await. Remove defer or the delayed-start option.',
    );
  }
}

type BeginExecutionParams = {
  type: string;
  input: unknown;
  checkpoint: Checkpoint;
  state: WorkflowState;
  registration: RegistrationEntry;
  options: StartOptions | undefined;
  isDelayed: boolean;
};

/**
 * Drive the initial execution for a freshly-started workflow and, when
 * `defer: false`, await the run actually beginning before resolving. A delayed
 * start does not begin executing now, so it neither begins execution here nor
 * awaits liveness. The liveness promise is settled by the inline-launch queue
 * once the generator is driven (or by dispose if the queued start is discarded),
 * so a `defer: false` caller can rely on the run being live without a macrotask
 * round-trip the moment `engine.start()` resolves.
 */
export async function beginExecutionAwaitingLiveness(
  internals: EngineInternals,
  params: BeginExecutionParams,
  workflowId: string,
  callbacks: LifecycleCallbacks,
): Promise<void> {
  // A delayed start does not begin executing now, so there is no liveness to
  // await. Return before creating the liveness promise so it can never be
  // orphaned even if the upstream defer/delayed-start validation is weakened.
  if (params.isDelayed) {
    return;
  }

  const liveness = params.options?.defer === false ? Promise.withResolvers<void>() : undefined;
  // If beginWorkflowExecution throws before onStarted can fire, the error
  // propagates straight out of this function — and since the throw is before the
  // `await liveness.promise` below, the defer:false caller surfaces it via this
  // function's own rejected promise. We deliberately do NOT reject `liveness`
  // here: nothing awaits it on the throw path, so rejecting it would leave an
  // orphaned rejected promise (an unhandled rejection).
  beginWorkflowExecution(
    internals,
    workflowId,
    params.state.workflowExecutionToken,
    params.type,
    params.input,
    params.checkpoint,
    params.state.executionDeadline,
    params.state.executionStateOwnerId ?? workflowId,
    params.registration,
    callbacks,
    liveness ? () => liveness.resolve() : undefined,
  );
  if (liveness) {
    await liveness.promise;
  }
}
