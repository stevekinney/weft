import type { ContextOperationRequest } from '../context.ts';
import type { ComposedWorkflowInterceptor } from '../interceptor.ts';
import { assertOnTerminalConflictUnsupported } from '../start-workflow-validation.ts';
import type {
  ChildWorkflowHandle,
  ChildWorkflowParentClosePolicy,
  StartOptions,
  WorkflowState,
} from '../types.ts';
import { stageAtomicWorkflowCommitSideEffects } from './checkpoint-side-effects.ts';
import {
  buildChildCancellationOperations,
  registerChildCancellationHandler,
} from './child-workflow-cancellation.ts';
import { WorkflowAlreadyExistsError } from './errors.ts';
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
  start: (type: string, input: unknown, options?: StartOptions) => Promise<WorkflowHandle>;
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
    if (!(error instanceof WorkflowAlreadyExistsError)) {
      throw error;
    }
    return resolveCollisionChildHandle(
      childWorkflowId,
      operation,
      context.pendingExecutionStateOwnerId ?? undefined,
      context.pendingParentWorkflowId,
      context.pendingParentWorkflowExecutionToken,
      error,
      callbacks,
    );
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
    return childHandle.result();
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
