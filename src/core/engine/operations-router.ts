import type { ContextOperationRequest } from '../context.ts';
import { classifyErrorAsFailureCategory } from '../failure-categories.ts';
import type { OperationOutcome } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import type { CapturedRejectionReason } from './strategy-helpers.ts';

export type OperationWithCallerStack = {
  callerStack?: string;
};

export type OperationRouterCallbacks = {
  processActivityOperation: (
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'activity' }>,
  ) => Promise<void>;
  processSleepOperation: (
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'sleep' }>,
  ) => Promise<void>;
  processWaitSignalOperation: (
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'wait-signal' }>,
  ) => Promise<void>;
  processWaitUpdateOperation: (
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'wait-update' }>,
  ) => Promise<void>;
  processWaitConditionOperation: (
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'wait-condition' }>,
  ) => Promise<void>;
  processGetVersionOperation: (
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'get-version' }>,
  ) => Promise<void>;
  processParallelOperation: (
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'parallel' }>,
  ) => Promise<void>;
  processRaceOperation: (
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'race' }>,
  ) => Promise<void>;
  processMemoOperation: (
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'memo' }>,
  ) => Promise<void>;
  processChildWorkflowOperation: (
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'child-workflow' }>,
  ) => Promise<void>;
  processOffloadOperation: (
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'offload' }>,
  ) => Promise<void>;
  processLoadOperation: (
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'load' }>,
  ) => Promise<void>;
  processArchiveOperation: (
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'archive' }>,
  ) => Promise<void>;
  processStateReadOperation: (
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'state-read' }>,
  ) => Promise<void>;
  processStateCommitOperation: (
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'state-commit' }>,
  ) => Promise<void>;
  processRunAllOperation: (
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'run-all' }>,
  ) => Promise<void>;
  processSpeculateOperation: (
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'speculate' }>,
  ) => Promise<void>;
  processStreamOperation: (
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'stream' }>,
  ) => Promise<void>;
  processWaitReviewOperation: (
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'wait-review' }>,
  ) => Promise<void>;
  finalizePendingTimelineEntry: (
    workflowId: string,
    status: 'completed' | 'failed',
    value: unknown,
  ) => void;
  feedOperationResult: (
    workflowId: string,
    result: OperationOutcome,
    originalReason?: CapturedRejectionReason,
  ) => void;
};

/**
 * Translate an operation request from a strategy into a {@link ContextOperationRequest}.
 *
 * The inline strategy already produces `ContextOperationRequest` (with `type`).
 * The worker protocol produces `OperationRequest` (with `kind`). This function
 * normalizes both shapes so `processOperation` can switch on `type`.
 */
export function translateOperationRequest(
  _internals: EngineInternals,
  operationRequest: unknown,
): ContextOperationRequest {
  const operation = operationRequest as Record<string, unknown>;

  if (operation == null || typeof operation !== 'object') {
    throw new Error('Invalid operation request received from execution strategy');
  }

  // Already in ContextOperationRequest shape (inline strategy)
  if ('type' in operation && typeof operation['type'] === 'string') {
    // Inline execution strategy yields ContextOperationRequest directly
    return operation as ContextOperationRequest;
  }

  // Worker OperationRequest uses `kind` — translate to `type`
  if ('kind' in operation && typeof operation['kind'] === 'string') {
    const kind = operation['kind'];

    // Map OperationRequest.kind values to ContextOperationRequest.type values
    const kindToType: Record<string, string> = {
      activity: 'activity',
      timer: 'sleep',
      'signal-wait': 'wait-signal',
      'child-workflow': 'child-workflow',
    };

    const type = kindToType[kind] ?? kind;

    // Worker protocol omits `fn` — it is resolved from the activity registry later
    return {
      ...operation,
      type,
      operationId: (operation['id'] as string) ?? crypto.randomUUID(),
      activityName: (operation['activityName'] as string) ?? '',
      input: operation['input'],
    } as ContextOperationRequest;
  }

  throw new Error('Unsupported operation request shape received from execution strategy');
}

export async function processOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: ContextOperationRequest,
  callbacks: OperationRouterCallbacks,
): Promise<void> {
  const operationProcessor = resolveOperationProcessor(operation, callbacks);
  if (operationProcessor) {
    return operationProcessor(workflowId, operation as never);
  }

  const unsupportedType = String((operation as Record<string, unknown>)['type']);
  failOperation(
    internals,
    workflowId,
    operation,
    new Error(`Unsupported operation type: ${unsupportedType}`),
    callbacks,
  );
}

type OperationProcessorMap = {
  [Type in ContextOperationRequest['type']]: (
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: Type }>,
  ) => Promise<void>;
};

function operationProcessors(callbacks: OperationRouterCallbacks): OperationProcessorMap {
  return {
    activity: callbacks.processActivityOperation,
    sleep: callbacks.processSleepOperation,
    'wait-signal': callbacks.processWaitSignalOperation,
    'wait-update': callbacks.processWaitUpdateOperation,
    'wait-condition': callbacks.processWaitConditionOperation,
    'get-version': callbacks.processGetVersionOperation,
    parallel: callbacks.processParallelOperation,
    race: callbacks.processRaceOperation,
    memo: callbacks.processMemoOperation,
    'child-workflow': callbacks.processChildWorkflowOperation,
    offload: callbacks.processOffloadOperation,
    load: callbacks.processLoadOperation,
    archive: callbacks.processArchiveOperation,
    'state-read': callbacks.processStateReadOperation,
    'state-commit': callbacks.processStateCommitOperation,
    'run-all': callbacks.processRunAllOperation,
    speculate: callbacks.processSpeculateOperation,
    stream: callbacks.processStreamOperation,
    'wait-review': callbacks.processWaitReviewOperation,
  };
}

function resolveOperationProcessor(
  operation: ContextOperationRequest,
  callbacks: OperationRouterCallbacks,
): OperationProcessorMap[ContextOperationRequest['type']] | undefined {
  return operationProcessors(callbacks)[operation.type];
}

export function completeOperation(
  _internals: EngineInternals,
  workflowId: string,
  value: unknown,
  callbacks: Pick<OperationRouterCallbacks, 'finalizePendingTimelineEntry' | 'feedOperationResult'>,
): void {
  callbacks.finalizePendingTimelineEntry(workflowId, 'completed', value);
  callbacks.feedOperationResult(workflowId, { status: 'completed', value });
}

export function failOperation(
  _internals: EngineInternals,
  workflowId: string,
  operation: OperationWithCallerStack,
  error: unknown,
  callbacks: Pick<OperationRouterCallbacks, 'finalizePendingTimelineEntry' | 'feedOperationResult'>,
): void {
  if (error instanceof Error && operation.callerStack) {
    error.stack = `${error.stack}\n    --- workflow call site ---\n${operation.callerStack}`;
  }

  // The string-form is only for timeline/storage metadata. The original
  // `error` value (which may be a non-Error like a string or undefined)
  // is forwarded through a wrapper so the workflow throw boundary
  // rethrows it as-is, matching Promise.all's rethrow contract even
  // when the original reason is `undefined`.
  const errorMessage = error instanceof Error ? error.message : String(error);
  callbacks.finalizePendingTimelineEntry(workflowId, 'failed', errorMessage);
  callbacks.feedOperationResult(
    workflowId,
    {
      status: 'failed',
      error: errorMessage,
      ...(error instanceof Error ? { errorName: error.name } : {}),
      failureCategory: classifyErrorAsFailureCategory(error, {
        defaultErrorCategory: 'application',
      }),
    },
    { value: error },
  );
}

export async function runOperationWithResult(
  internals: EngineInternals,
  workflowId: string,
  operation: OperationWithCallerStack,
  execute: () => Promise<unknown>,
  callbacks: OperationRouterCallbacks,
): Promise<void> {
  try {
    const value = await execute();
    completeOperation(internals, workflowId, value, callbacks);
  } catch (error) {
    failOperation(internals, workflowId, operation, error, callbacks);
  }
}

export async function runOperationWithoutResult(
  internals: EngineInternals,
  workflowId: string,
  operation: OperationWithCallerStack,
  execute: () => Promise<void>,
  callbacks: OperationRouterCallbacks,
): Promise<void> {
  try {
    await execute();
  } catch (error) {
    failOperation(internals, workflowId, operation, error, callbacks);
  }
}
