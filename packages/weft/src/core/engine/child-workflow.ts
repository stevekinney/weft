import type { ContextOperationRequest } from '../context.ts';
import type { ComposedWorkflowInterceptor } from '../interceptor.ts';
import {
  assertOnTerminalConflictUnsupported,
  StartWorkflowValidationError,
} from '../start-workflow-validation.ts';
import type {
  ChildWorkflowHandle,
  ChildWorkflowParentClosePolicy,
  StartOptions,
  WorkflowState,
} from '../types.ts';
import { isReservedWorkflowIdLiteral } from '../workflow-identifiers.ts';
import { stageAtomicWorkflowCommitSideEffects } from './checkpoint-side-effects.ts';
import {
  buildChildCancellationOperations,
  registerChildCancellationHandler,
} from './child-workflow-cancellation.ts';
import { WorkflowAlreadyExistsError } from './errors.ts';
import { getGeneratorOwnedWorkflowResultPromise } from './handle-result.ts';
import type { WorkflowHandle } from './handles.ts';
import type { EngineInternals } from './internals.ts';
import { encodedValuesEqual } from './state-utilities.ts';

type ChildWorkflowOperation = Extract<ContextOperationRequest, { type: 'child-workflow' }>;

export type ChildWorkflowOperationCallbacks = {
  runOperationWithResult: (
    workflowId: string,
    operation: ChildWorkflowOperation,
    execute: () => Promise<unknown>,
  ) => Promise<void>;
  /**
   * `skipAdmissionIdCheck` (WFT-95, internal only) is threaded straight through
   * to `startWorkflow`'s parameter of the same name — see its doc comment. It
   * is NEVER part of the public `StartOptions` a caller passes; only
   * `dispatchChildWorkflowStart`'s crash-reattach retry sets it, and only
   * after confirming a matching persisted child record already exists for
   * `childWorkflowId`. This retry always passes the literal `'reattach-only'`,
   * not `true`: the confirming read here is separate from
   * `startWorkflow`'s own atomic re-check, so `'reattach-only'` fences the
   * bypass to that re-check actually finding a match to reattach to (see
   * `startWorkflow`'s doc comment for the full TOCTOU race this closes).
   */
  start: (
    type: string,
    input: unknown,
    options?: StartOptions,
    skipAdmissionIdCheck?: boolean | 'reattach-only',
  ) => Promise<WorkflowHandle>;
  loadWorkflowState: (workflowId: string) => Promise<WorkflowState | null>;
  getHandle: (workflowId: string) => WorkflowHandle;
  getComposedWorkflowInterceptor: () => ComposedWorkflowInterceptor | null;
};

export async function processChildWorkflowOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: ChildWorkflowOperation,
  callbacks: ChildWorkflowOperationCallbacks,
): Promise<void> {
  return callbacks.runOperationWithResult(workflowId, operation, () =>
    executeChildWorkflow(
      internals,
      workflowId,
      operation,
      assertChildWorkflowNestingDepth(internals, workflowId),
      callbacks,
    ),
  );
}

export function assertChildWorkflowNestingDepth(
  internals: EngineInternals,
  workflowId: string,
): number {
  const currentDepth = getWorkflowNestingDepth(internals, workflowId);
  if (currentDepth + 1 > internals.options.maxNestingDepth) {
    throw new Error(
      `Child workflow nesting depth exceeded: ${currentDepth + 1} exceeds maximum of ${internals.options.maxNestingDepth}. ` +
        'Configure maxNestingDepth in engine options to increase the limit.',
    );
  }

  return currentDepth;
}

export function getWorkflowNestingDepth(internals: EngineInternals, workflowId: string): number {
  const currentContext = internals.inlineStrategy?.getContext(workflowId);
  return currentContext?.nestingDepth ?? internals.workflowNestingDepths.get(workflowId) ?? 0;
}

type PendingChildExecutionContext = {
  pendingNestingDepth: number;
  pendingParentHeaders: Map<string, string> | undefined;
  pendingExecutionStateOwnerId: string | null;
  pendingParentWorkflowId: string;
  pendingParentWorkflowExecutionToken: string | undefined;
};

function applyPendingChildExecutionContext(
  internals: EngineInternals,
  context: PendingChildExecutionContext,
): void {
  internals.pendingNestingDepth = context.pendingNestingDepth;
  internals.pendingParentHeaders = context.pendingParentHeaders;
  internals.pendingExecutionStateOwnerId = context.pendingExecutionStateOwnerId;
  internals.pendingParentWorkflowId = context.pendingParentWorkflowId;
  internals.pendingParentWorkflowExecutionToken = context.pendingParentWorkflowExecutionToken;
}

function clearPendingChildExecutionContext(
  internals: EngineInternals,
  context: PendingChildExecutionContext,
): void {
  if (internals.pendingNestingDepth === context.pendingNestingDepth) {
    internals.pendingNestingDepth = undefined;
  }
  if (internals.pendingParentHeaders === context.pendingParentHeaders) {
    internals.pendingParentHeaders = undefined;
  }
  if (internals.pendingExecutionStateOwnerId === context.pendingExecutionStateOwnerId) {
    internals.pendingExecutionStateOwnerId = undefined;
  }
  if (internals.pendingParentWorkflowId === context.pendingParentWorkflowId) {
    internals.pendingParentWorkflowId = undefined;
  }
  if (
    internals.pendingParentWorkflowExecutionToken === context.pendingParentWorkflowExecutionToken
  ) {
    internals.pendingParentWorkflowExecutionToken = undefined;
  }
}

function existingChildMatchesRequest(
  existingState: WorkflowState,
  operation: ChildWorkflowOperation,
  executionStateOwnerId: string | undefined,
  parentWorkflowId: string,
  parentWorkflowExecutionToken: string | undefined,
): boolean {
  // Records written before direct-run lineage was persisted still reattach by
  // the established type/input/execution-owner replay identity.
  const lineageMatches =
    (existingState.parentWorkflowId === undefined &&
      existingState.parentWorkflowExecutionToken === undefined) ||
    (existingState.parentWorkflowId === parentWorkflowId &&
      existingState.parentWorkflowExecutionToken === parentWorkflowExecutionToken);
  return (
    existingState.type === operation.workflowType &&
    encodedValuesEqual(existingState.input, operation.input) &&
    existingState.executionStateOwnerId === executionStateOwnerId &&
    lineageMatches
  );
}

async function resolveCollisionChildHandle(
  childWorkflowId: string,
  operation: ChildWorkflowOperation,
  executionStateOwnerId: string | undefined,
  parentWorkflowId: string,
  parentWorkflowExecutionToken: string | undefined,
  collisionError: WorkflowAlreadyExistsError,
  callbacks: Pick<ChildWorkflowOperationCallbacks, 'getHandle' | 'loadWorkflowState'>,
): Promise<WorkflowHandle> {
  const existingState = await callbacks.loadWorkflowState(childWorkflowId);

  if (!existingState) {
    throw collisionError;
  }

  if (
    !existingChildMatchesRequest(
      existingState,
      operation,
      executionStateOwnerId,
      parentWorkflowId,
      parentWorkflowExecutionToken,
    )
  ) {
    throw new Error(
      `Child workflow id collision for "${childWorkflowId}" does not match the requested child workflow`,
      { cause: collisionError },
    );
  }

  return callbacks.getHandle(childWorkflowId);
}

/**
 * Handle a `StartWorkflowValidationError` thrown for `childWorkflowId` being
 * exactly `.` or `..` (WFT-95). Before strict admission existed, that was a
 * legal id, so a parent workflow created before the upgrade may have a
 * pre-existing child persisted under it; crash recovery replays this same
 * `ctx.startChild()` operation and must reattach to it rather than re-reject
 * it. A genuinely fresh `ctx.startChild({ id: '.' })` has no persisted child
 * to reattach to, so it must still be rejected — this is what distinguishes
 * the two: check storage for a matching persisted record BEFORE deciding to
 * bypass strict admission on retry, rather than bypassing unconditionally.
 */
async function reattachLegacyReservedChildOrRethrow(
  childWorkflowId: string,
  operation: ChildWorkflowOperation,
  context: PendingChildExecutionContext,
  callbacks: Pick<ChildWorkflowOperationCallbacks, 'getHandle' | 'loadWorkflowState' | 'start'>,
  originalError: StartWorkflowValidationError,
): Promise<WorkflowHandle> {
  const existingState = await callbacks.loadWorkflowState(childWorkflowId);
  if (
    !existingState ||
    !existingChildMatchesRequest(
      existingState,
      operation,
      context.pendingExecutionStateOwnerId ?? undefined,
      context.pendingParentWorkflowId,
      context.pendingParentWorkflowExecutionToken,
    )
  ) {
    // No matching persisted child: this is a genuinely fresh admission, so the
    // strict `.`/`..` rejection stands.
    throw originalError;
  }

  try {
    // A matching persisted record was just confirmed, so this retry (with
    // strict id admission bypassed) is expected to hit the engine's ordinary
    // duplicate-id conflict below, not actually create a new run.
    //
    // There IS an `await` (the `loadWorkflowState` above) between
    // `dispatchChildWorkflowStart`'s single `applyPendingChildExecutionContext`
    // call and this retry — unlike every other `startWorkflow` caller, whose
    // `prepareStartWorkflow` capture of `internals.pendingParent*` is documented
    // to run synchronously right after it is set, with no intervening await. So
    // by the time this call's own `prepareStartWorkflow` reads
    // `internals.pendingParent*`, a same-tick concurrent `ctx.startChild()` may
    // already have consumed (and cleared) or overwritten it. That is harmless
    // here specifically: this retry is only reached after confirming a matching
    // persisted child already exists, so `resolveTerminalConflictForRestart`
    // deterministically throws `WorkflowAlreadyExistsError` before the captured
    // parent-linkage fields are ever used to build a NEW `WorkflowState` — they
    // are read and discarded, never applied. If the matched record were instead
    // purged by another engine in this same window, this call would proceed to
    // actually start a fresh run under stale lineage; that is the same
    // pre-existing "point-in-time observation" limitation
    // `resolveTerminalConflictForRestart` already documents for every
    // caller-id start, not something new to this path.
    return await callbacks.start(
      operation.workflowType,
      operation.input,
      { id: childWorkflowId },
      'reattach-only',
    );
  } catch (retryError) {
    if (!(retryError instanceof WorkflowAlreadyExistsError)) {
      throw retryError;
    }
    return resolveCollisionChildHandle(
      childWorkflowId,
      operation,
      context.pendingExecutionStateOwnerId ?? undefined,
      context.pendingParentWorkflowId,
      context.pendingParentWorkflowExecutionToken,
      retryError,
      callbacks,
    );
  }
}

async function dispatchChildWorkflowStart(
  internals: EngineInternals,
  childWorkflowId: string,
  operation: ChildWorkflowOperation,
  context: PendingChildExecutionContext,
  callbacks: Pick<ChildWorkflowOperationCallbacks, 'getHandle' | 'loadWorkflowState' | 'start'>,
): Promise<WorkflowHandle> {
  // Child-start re-attaches to an existing child run by id during replay (including a
  // terminal one), so `onTerminalConflict: 'start-new'` would make replay
  // nondeterministic; it stays unsupported here. The primary defense is its absence from
  // `ChildWorkflowOptions`; this is the runtime backstop for an untyped/`as`-cast caller,
  // run before pending child context is applied so a rejection leaves no stale state.
  assertOnTerminalConflictUnsupported(operation.options, 'ctx.startChild');
  applyPendingChildExecutionContext(internals, context);
  try {
    return await callbacks.start(operation.workflowType, operation.input, {
      id: childWorkflowId,
    });
  } catch (error) {
    if (error instanceof WorkflowAlreadyExistsError) {
      return resolveCollisionChildHandle(
        childWorkflowId,
        operation,
        context.pendingExecutionStateOwnerId ?? undefined,
        context.pendingParentWorkflowId,
        context.pendingParentWorkflowExecutionToken,
        error,
        callbacks,
      );
    }
    if (
      error instanceof StartWorkflowValidationError &&
      isReservedWorkflowIdLiteral(childWorkflowId)
    ) {
      return reattachLegacyReservedChildOrRethrow(
        childWorkflowId,
        operation,
        context,
        callbacks,
        error,
      );
    }
    throw error;
  } finally {
    clearPendingChildExecutionContext(internals, context);
  }
}

export async function executeChildWorkflow(
  internals: EngineInternals,
  workflowId: string,
  operation: ChildWorkflowOperation,
  currentDepth: number,
  callbacks: Pick<
    ChildWorkflowOperationCallbacks,
    'getComposedWorkflowInterceptor' | 'getHandle' | 'loadWorkflowState' | 'start'
  >,
): Promise<unknown> {
  const rawId = operation.options?.['id'];
  const childWorkflowId = typeof rawId === 'string' ? rawId : crypto.randomUUID();
  const parentHeaders = internals.workflowHeaders.get(workflowId) ?? new Map<string, string>();
  const parentState = await callbacks.loadWorkflowState(workflowId);
  const parentClosePolicy = resolveChildWorkflowParentClosePolicy(operation);
  const executionStateOwnerId =
    parentClosePolicy === 'abandon' ? null : (parentState?.executionStateOwnerId ?? workflowId);
  const executeChild = async (): Promise<unknown> => {
    const context: PendingChildExecutionContext = {
      pendingNestingDepth: currentDepth + 1,
      pendingParentHeaders: internals.workflowHeaders.get(workflowId),
      pendingExecutionStateOwnerId: executionStateOwnerId,
      pendingParentWorkflowId: workflowId,
      pendingParentWorkflowExecutionToken: parentState?.workflowExecutionToken,
    };
    const childHandle = await dispatchChildWorkflowStart(
      internals,
      childWorkflowId,
      operation,
      context,
      callbacks,
    );
    if (parentClosePolicy === 'abandon') {
      return createChildWorkflowHandleReference(childHandle.id);
    }
    if (parentClosePolicy === 'request-cancel') {
      stageAtomicWorkflowCommitSideEffects(internals, workflowId, {
        conditions: [],
        operations: buildChildCancellationOperations(internals, workflowId, childHandle.id),
      });
      registerChildCancellationHandler(internals, workflowId, childHandle.id, callbacks);
      return createChildWorkflowHandleReference(childHandle.id);
    }
    // NOT `childHandle.result()`. That returns an observational waiter, which
    // the cross-engine poll settles from durable state with no ownership check
    // — correct for a caller watching from outside, wrong here. This waiter is
    // generator-owned: settling it advances THIS parent's generator. If the
    // parent's claim is lost while it awaits the child, an observational
    // waiter would advance the deposed parent while the successor advances its
    // replayed one (ADR 0002). Marking it generator-owned fences the settle on
    // the parent's claim generation.
    return getGeneratorOwnedWorkflowResultPromise(internals, childHandle.id, workflowId);
  };

  const composedInterceptor = callbacks.getComposedWorkflowInterceptor();
  if (!composedInterceptor) {
    return executeChild();
  }

  return composedInterceptor.childWorkflow(
    {
      workflowId,
      childWorkflowId,
      workflowType: operation.workflowType,
      input: operation.input,
      headers: new Map<string, string>(),
      parentHeaders,
    },
    executeChild,
  );
}

function resolveChildWorkflowParentClosePolicy(
  operation: ChildWorkflowOperation,
): ChildWorkflowParentClosePolicy {
  return operation.options?.parentClosePolicy ?? 'await';
}

function createChildWorkflowHandleReference<TResult = unknown>(
  workflowId: string,
): ChildWorkflowHandle<TResult> {
  return { id: workflowId };
}
