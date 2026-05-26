import type { ContextOperationRequest } from '../context.ts';
import type { ComposedWorkflowInterceptor } from '../interceptor.ts';
import type { StartOptions, WorkflowState } from '../types.ts';
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
  pendingExecutionStateOwnerId: string;
};

function applyPendingChildExecutionContext(
  internals: EngineInternals,
  context: PendingChildExecutionContext,
): void {
  internals.pendingNestingDepth = context.pendingNestingDepth;
  internals.pendingParentHeaders = context.pendingParentHeaders;
  internals.pendingExecutionStateOwnerId = context.pendingExecutionStateOwnerId;
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
}

function existingChildMatchesRequest(
  existingState: WorkflowState,
  operation: ChildWorkflowOperation,
  executionStateOwnerId: string,
): boolean {
  return (
    existingState.type === operation.workflowType &&
    encodedValuesEqual(existingState.input, operation.input) &&
    existingState.executionStateOwnerId === executionStateOwnerId
  );
}

async function resolveCollisionChildHandle(
  childWorkflowId: string,
  operation: ChildWorkflowOperation,
  executionStateOwnerId: string,
  collisionError: WorkflowAlreadyExistsError,
  callbacks: Pick<ChildWorkflowOperationCallbacks, 'getHandle' | 'loadWorkflowState'>,
): Promise<WorkflowHandle> {
  const existingState = await callbacks.loadWorkflowState(childWorkflowId);

  if (!existingState) {
    throw collisionError;
  }

  if (!existingChildMatchesRequest(existingState, operation, executionStateOwnerId)) {
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
      context.pendingExecutionStateOwnerId,
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
  const executionStateOwnerId = parentState?.executionStateOwnerId ?? workflowId;
  const executeChild = async (): Promise<unknown> => {
    const context: PendingChildExecutionContext = {
      pendingNestingDepth: currentDepth + 1,
      pendingParentHeaders: internals.workflowHeaders.get(workflowId),
      pendingExecutionStateOwnerId: executionStateOwnerId,
    };
    const childHandle = await dispatchChildWorkflowStart(
      internals,
      childWorkflowId,
      operation,
      context,
      callbacks,
    );
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
