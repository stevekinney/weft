import { KEYS } from '../../storage/interface.ts';
import type { ContextOperationRequest } from '../context.ts';
import type { UpdateRequest } from '../updates.ts';
import { stageAtomicWorkflowCommitSideEffects } from './checkpoint-side-effects.ts';
import type { EngineInternals } from './internals.ts';
import { trackWaiterKey, untrackWaiterKey } from './signals.ts';
import { isCurrentOperation } from './strategy-helpers.ts';
import type { UpdateCallbacks } from './updates.ts';
import { confirmWakeOwnership } from './wake-ownership-guard.ts';

export async function processWaitUpdateOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: Extract<ContextOperationRequest, { type: 'wait-update' }>,
  callbacks: UpdateCallbacks,
): Promise<void> {
  const workflowExecutionToken =
    internals.durableInlineOperations?.get(workflowId)?.workflowExecutionToken;
  const waiterKey = `${workflowId}:${operation.updateName}`;
  const matchingUpdate = await callbacks.findPendingUpdateByName(workflowId, operation.updateName);

  if (matchingUpdate) {
    if (
      !isTrackedCurrentOperation(
        internals,
        workflowId,
        operation.operationId,
        workflowExecutionToken,
      )
    ) {
      return;
    }
    if (
      !(await stagePendingUpdateDeletion(
        internals,
        workflowId,
        matchingUpdate.updateId,
        workflowExecutionToken,
      ))
    )
      return;
    callbacks.dispatchPendingUpdateReceived(workflowId, operation.updateName, matchingUpdate);
    callbacks.completeOperation(
      workflowId,
      {
        payload: matchingUpdate.payload,
        respond: callbacks.createCoordinatedUpdateResponder(
          workflowId,
          operation.updateName,
          matchingUpdate,
        ),
      },
      operation.operationId,
      workflowExecutionToken,
    );
    return;
  }

  const { promise, resolve } = Promise.withResolvers<void>();
  const deliverWaiter = (value: unknown): void => {
    callbacks.completeOperation(workflowId, value, operation.operationId, workflowExecutionToken);
    const advance = internals.inlineStrategy?.waitForWorkflowAdvance(workflowId);
    if (advance === undefined) {
      resolve();
      return;
    }
    void advance.then(resolve, resolve);
  };
  internals.updateWaiters.set(waiterKey, deliverWaiter);
  trackWaiterKey(internals.updateWaitersByWorkflow, workflowId, waiterKey);

  const pendingUpdateAfterRegistration = await callbacks.findPendingUpdateByName(
    workflowId,
    operation.updateName,
  );
  if (pendingUpdateAfterRegistration) {
    if (
      !isTrackedCurrentOperation(
        internals,
        workflowId,
        operation.operationId,
        workflowExecutionToken,
      ) ||
      internals.updateWaiters.get(waiterKey) !== deliverWaiter
    ) {
      return;
    }
    if (
      !(await stagePendingUpdateDeletion(
        internals,
        workflowId,
        pendingUpdateAfterRegistration.updateId,
        workflowExecutionToken,
        () => internals.updateWaiters.get(waiterKey) === deliverWaiter,
      ))
    )
      return;
    internals.updateWaiters.delete(waiterKey);
    untrackWaiterKey(internals.updateWaitersByWorkflow, workflowId, waiterKey);
    callbacks.dispatchPendingUpdateReceived(
      workflowId,
      operation.updateName,
      pendingUpdateAfterRegistration,
    );
    callbacks.completeOperation(
      workflowId,
      {
        payload: pendingUpdateAfterRegistration.payload,
        respond: callbacks.createCoordinatedUpdateResponder(
          workflowId,
          operation.updateName,
          pendingUpdateAfterRegistration,
        ),
      },
      operation.operationId,
      workflowExecutionToken,
    );
    return;
  }

  await promise;
}

function isTrackedCurrentOperation(
  internals: EngineInternals,
  workflowId: string,
  operationId: string,
  workflowExecutionToken: string | undefined,
): boolean {
  return internals.durableInlineOperations === undefined
    ? true
    : isCurrentOperation(internals, workflowId, operationId, workflowExecutionToken);
}

export async function stagePendingUpdateDeletion(
  internals: EngineInternals,
  workflowId: string,
  updateId: string,
  workflowExecutionToken: string | undefined,
  canCommit: () => boolean = () => true,
): Promise<boolean> {
  if (internals.storage === undefined) {
    await internals.updateCoordinator.deleteRequest(workflowId, updateId);
    return true;
  }
  const key = KEYS.update(workflowId, updateId);
  const value = await internals.storage.get(key);
  if (value === null || !canCommit()) return false;
  stageAtomicWorkflowCommitSideEffects(
    internals,
    workflowId,
    {
      // A workflow can call respond() before its next checkpoint; that response
      // deletes the request independently. The generation-bound checkpoint
      // delete must therefore be idempotent rather than require old bytes.
      conditions: [],
      operations: [{ type: 'delete', key }],
    },
    workflowExecutionToken,
    true,
  );
  return true;
}

export async function claimPendingUpdateForWaiter(
  internals: EngineInternals,
  workflowId: string,
  updateRequest: UpdateRequest,
  waiterKey: string,
  waiter: (value: unknown) => void,
  workflowExecutionToken: string | undefined,
  callbacks: Pick<UpdateCallbacks, 'findPendingUpdateByName'>,
): Promise<boolean> {
  const oldestPendingUpdate = await callbacks.findPendingUpdateByName(
    workflowId,
    updateRequest.name,
  );
  if (!oldestPendingUpdate || oldestPendingUpdate.updateId !== updateRequest.updateId) return false;
  // Keep the request durable when this engine no longer owns the workflow.
  if ((await confirmWakeOwnership(internals, workflowId, 'update')) === 'discard') return false;
  if (
    !(await stagePendingUpdateDeletion(
      internals,
      workflowId,
      updateRequest.updateId,
      workflowExecutionToken,
      () => internals.updateWaiters.get(waiterKey) === waiter,
    ))
  ) {
    return false;
  }
  if (internals.updateWaiters.get(waiterKey) !== waiter) return false;
  internals.updateWaiters.delete(waiterKey);
  untrackWaiterKey(internals.updateWaitersByWorkflow, workflowId, waiterKey);
  return true;
}
