import type { ContextOperationRequest } from '../context.ts';
import type { EngineInternals } from './internals.ts';
import type { CoordinationOperationCallbacks } from './operations-coordination.ts';
import {
  consumeSignalWithAtomicWorkflowCommit,
  registerSignalWaiter,
  releaseSignalWaiter,
  untrackWaiterKey,
} from './signals.ts';
import { isCurrentOperation } from './strategy-helpers.ts';

type WaitSignalOperation = Extract<ContextOperationRequest, { type: 'wait-signal' }>;

function failWaitSignalOperation(
  internals: EngineInternals,
  workflowId: string,
  waiterKey: string,
  operation: WaitSignalOperation,
  pendingWaiterResolve: (() => void) | undefined,
  error: unknown,
  failOperation: CoordinationOperationCallbacks['failOperation'],
  workflowExecutionToken?: string,
): void {
  if (
    !isTrackedCurrentOperation(internals, workflowId, operation.operationId, workflowExecutionToken)
  )
    return;
  // A successor may replace this waiter while the post-registration scan is
  // in flight. Its workflow must not receive the old scan's failure.
  if (
    pendingWaiterResolve !== undefined &&
    !releaseSignalWaiter(internals, workflowId, waiterKey, pendingWaiterResolve)
  ) {
    return;
  }
  failOperation(workflowId, operation, error, workflowExecutionToken);
}

export async function processWaitSignalOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: WaitSignalOperation,
  callbacks: Pick<CoordinationOperationCallbacks, 'completeOperation' | 'failOperation'>,
): Promise<void> {
  const abortSignal = internals.abortController.signal;
  const workflowExecutionToken =
    internals.durableInlineOperations?.get(workflowId)?.workflowExecutionToken;
  const waiterKey = `${workflowId}:${operation.signalName}`;
  // The waiter this loop registered and no signal has consumed yet. If a
  // buffered-signal scan then throws, the waiter must be released here, or it
  // outlives the failed operation and keeps the workflow looking waited-on.
  let pendingWaiterResolve: (() => void) | undefined;

  try {
    while (!abortSignal.aborted) {
      const existingPayload = await consumeSignalWithAtomicWorkflowCommit(
        internals,
        workflowId,
        operation.signalName,
        () =>
          isTrackedCurrentOperation(
            internals,
            workflowId,
            operation.operationId,
            workflowExecutionToken,
          ),
        workflowExecutionToken,
      );
      if (existingPayload.found) {
        completeWaitSignalOperation(
          callbacks,
          workflowId,
          operation,
          existingPayload.payload,
          workflowExecutionToken,
        );
        return;
      }

      if (
        !isTrackedCurrentOperation(
          internals,
          workflowId,
          operation.operationId,
          workflowExecutionToken,
        )
      )
        return;

      const { promise, resolve } = Promise.withResolvers<void>();
      registerSignalWaiter(internals, workflowId, waiterKey, resolve);
      pendingWaiterResolve = resolve;

      if (abortSignal.aborted) {
        releaseSignalWaiter(internals, workflowId, waiterKey, resolve);
        return;
      }

      const bufferedPayload = await consumeSignalWithAtomicWorkflowCommit(
        internals,
        workflowId,
        operation.signalName,
        () =>
          internals.signalWaiters.get(waiterKey) === resolve &&
          isTrackedCurrentOperation(
            internals,
            workflowId,
            operation.operationId,
            workflowExecutionToken,
          ),
        workflowExecutionToken,
      );
      if (bufferedPayload.found) {
        return completeBufferedWaitSignal(
          internals,
          workflowId,
          waiterKey,
          resolve,
          operation,
          bufferedPayload.payload,
          callbacks,
          workflowExecutionToken,
        );
      }

      if (
        !isTrackedCurrentOperation(
          internals,
          workflowId,
          operation.operationId,
          workflowExecutionToken,
        )
      )
        return;

      // Delivery removes the waiter before resolving its promise. A missing
      // entry here can mean the signal arrived during the buffered scan, so
      // wait for that resolution and consume the durable signal on the loop.
      await promise;
      // Delivery removed the waiter before resolving it.
      pendingWaiterResolve = undefined;
    }
  } catch (error) {
    failWaitSignalOperation(
      internals,
      workflowId,
      waiterKey,
      operation,
      pendingWaiterResolve,
      error,
      callbacks.failOperation,
      workflowExecutionToken,
    );
  }
}

function isTrackedCurrentOperation(
  internals: EngineInternals,
  workflowId: string,
  operationId: string,
  token: string | undefined,
): boolean {
  return (
    internals.durableInlineOperations === undefined ||
    isCurrentOperation(internals, workflowId, operationId, token)
  );
}

function completeWaitSignalOperation(
  callbacks: Pick<CoordinationOperationCallbacks, 'completeOperation'>,
  workflowId: string,
  operation: WaitSignalOperation,
  value: unknown,
  workflowExecutionToken: string | undefined,
): void {
  callbacks.completeOperation(workflowId, value, operation.operationId, workflowExecutionToken);
}

function completeBufferedWaitSignal(
  internals: EngineInternals,
  workflowId: string,
  waiterKey: string,
  resolve: () => void,
  operation: WaitSignalOperation,
  value: unknown,
  callbacks: Pick<CoordinationOperationCallbacks, 'completeOperation'>,
  workflowExecutionToken: string | undefined,
): void {
  if (internals.signalWaiters.get(waiterKey) !== resolve) return;
  internals.signalWaiters.delete(waiterKey);
  untrackWaiterKey(internals.signalWaitersByWorkflow, workflowId, waiterKey);
  completeWaitSignalOperation(callbacks, workflowId, operation, value, workflowExecutionToken);
}
