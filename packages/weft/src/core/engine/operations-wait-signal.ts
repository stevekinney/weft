import type { ContextOperationRequest } from '../context.ts';
import { SignalDeliveredEvent } from '../events.ts';
import type { EngineInternals } from './internals.ts';
import type { CoordinationOperationCallbacks } from './operations-coordination.ts';
import {
  captureSignalWaitRun,
  clearSignalWait,
  recordSignalWaitBegan,
  type SignalWaitRun,
} from './signal-wait-tracking.ts';
import {
  consumeSignalWithAtomicWorkflowCommit,
  registerSignalWaiter,
  releaseSignalWaiter,
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
  const run = captureSignalWaitRun(internals, workflowId);
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
        await completeWaitSignalOperation(
          internals,
          callbacks,
          workflowId,
          run,
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
      const resolveAndReport = () => {
        internals.engine.dispatchEvent(new SignalDeliveredEvent(workflowId, operation.signalName));
        resolve();
      };
      registerSignalWaiter(internals, workflowId, waiterKey, resolveAndReport);
      pendingWaiterResolve = resolveAndReport;

      if (abortSignal.aborted) {
        releaseSignalWaiter(internals, workflowId, waiterKey, resolveAndReport);
        return;
      }

      const bufferedPayload = await consumeSignalWithAtomicWorkflowCommit(
        internals,
        workflowId,
        operation.signalName,
        () =>
          internals.signalWaiters.get(waiterKey) === resolveAndReport &&
          isTrackedCurrentOperation(
            internals,
            workflowId,
            operation.operationId,
            workflowExecutionToken,
          ),
        workflowExecutionToken,
      );
      if (bufferedPayload.found) {
        return await completeBufferedWaitSignal(
          internals,
          workflowId,
          run,
          waiterKey,
          resolveAndReport,
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

      // The wait has begun: no signal was buffered. Record it durably before
      // parking on the promise. A delivery that lands meanwhile releases the
      // waiter first, and the record then leaves the name out.
      await recordSignalWaitBegan(
        internals,
        workflowId,
        run,
        operation.signalName,
        () => internals.signalWaiters.get(waiterKey) === resolveAndReport,
      );

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

/**
 * Complete a wait whose signal was consumed. The name leaves the durable
 * `waitingForSignals` list first, so it is gone before the workflow's next
 * checkpoint. That also covers a wait listed before a restart, whose signal
 * the recovered run finds already buffered.
 */
async function completeWaitSignalOperation(
  internals: EngineInternals,
  callbacks: Pick<CoordinationOperationCallbacks, 'completeOperation'>,
  workflowId: string,
  run: SignalWaitRun,
  operation: WaitSignalOperation,
  value: unknown,
  workflowExecutionToken: string | undefined,
): Promise<void> {
  await clearSignalWait(internals, workflowId, run, operation.signalName);
  callbacks.completeOperation(workflowId, value, operation.operationId, workflowExecutionToken);
}

async function completeBufferedWaitSignal(
  internals: EngineInternals,
  workflowId: string,
  run: SignalWaitRun,
  waiterKey: string,
  resolve: () => void,
  operation: WaitSignalOperation,
  value: unknown,
  callbacks: Pick<CoordinationOperationCallbacks, 'completeOperation'>,
  workflowExecutionToken: string | undefined,
): Promise<void> {
  if (!releaseSignalWaiter(internals, workflowId, waiterKey, resolve)) return;
  await completeWaitSignalOperation(
    internals,
    callbacks,
    workflowId,
    run,
    operation,
    value,
    workflowExecutionToken,
  );
}
