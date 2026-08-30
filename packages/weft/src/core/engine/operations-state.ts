import {
  atomicStateDataKey,
  commitAtomicStateDelete,
  commitAtomicStateValue,
  readAtomicStateSnapshot,
} from '../atomic-state.ts';
import type { ContextOperationRequest } from '../context.ts';
import type { EngineInternals } from './internals.ts';
import type { OperationWithCallerStack } from './operations-router.ts';

type StateReadOperation = Extract<ContextOperationRequest, { type: 'state-read' }>;
type StateCommitOperation = Extract<ContextOperationRequest, { type: 'state-commit' }>;

export type StateOperationCallbacks = {
  runOperationWithResult: (
    workflowId: string,
    operation: OperationWithCallerStack,
    execute: () => Promise<unknown>,
  ) => Promise<void>;
  ensureTerminalCleanupTracked: (workflowId: string) => Promise<void>;
};

export async function processStateReadOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: StateReadOperation,
  callbacks: StateOperationCallbacks,
): Promise<void> {
  return callbacks.runOperationWithResult(workflowId, operation, async () => {
    const dataKey = atomicStateDataKey(operation.scope, operation.key);
    return readAtomicStateSnapshot(internals.storage, dataKey, operation);
  });
}

export async function processStateCommitOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: StateCommitOperation,
  callbacks: StateOperationCallbacks,
): Promise<void> {
  return callbacks.runOperationWithResult(workflowId, operation, async () => {
    const dataKey = atomicStateDataKey(operation.scope, operation.key);
    if (operation.mode === 'delete') {
      const result = await commitAtomicStateDelete(
        internals.storage,
        dataKey,
        operation.expectedVersion,
      );
      if (result.applied && operation.scope.type === 'execution') {
        await callbacks.ensureTerminalCleanupTracked(operation.scope.ownerWorkflowId);
      }
      return result;
    }

    const result = await commitAtomicStateValue(
      internals.storage,
      dataKey,
      operation.expectedVersion,
      operation.value,
    );
    if (result.applied && operation.scope.type === 'execution') {
      await callbacks.ensureTerminalCleanupTracked(operation.scope.ownerWorkflowId);
    }
    return result;
  });
}
