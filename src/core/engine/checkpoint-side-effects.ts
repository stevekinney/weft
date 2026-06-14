import type { BatchOperation, ConditionalBatchCondition } from '../../storage/interface.ts';

import type { EngineInternals } from './internals.ts';

export type AtomicWorkflowCommitSideEffects = {
  conditions: ConditionalBatchCondition[];
  operations: BatchOperation[];
};

export function stageAtomicWorkflowCommitSideEffects(
  internals: EngineInternals,
  workflowId: string,
  sideEffects: AtomicWorkflowCommitSideEffects,
): void {
  if (sideEffects.conditions.length === 0 && sideEffects.operations.length === 0) {
    return;
  }

  const pending = internals.pendingAtomicWorkflowCommitSideEffects.get(workflowId);
  if (pending === undefined) {
    internals.pendingAtomicWorkflowCommitSideEffects.set(workflowId, {
      conditions: [...sideEffects.conditions],
      operations: [...sideEffects.operations],
    });
    return;
  }

  pending.conditions.push(...sideEffects.conditions);
  pending.operations.push(...sideEffects.operations);
}

export function takePendingAtomicWorkflowCommitSideEffects(
  internals: EngineInternals,
  workflowId: string,
): AtomicWorkflowCommitSideEffects | undefined {
  const pending = internals.pendingAtomicWorkflowCommitSideEffects.get(workflowId);
  if (pending === undefined) {
    return undefined;
  }

  internals.pendingAtomicWorkflowCommitSideEffects.delete(workflowId);
  if (pending.conditions.length === 0 && pending.operations.length === 0) {
    return undefined;
  }

  return {
    conditions: [...pending.conditions],
    operations: [...pending.operations],
  };
}

export function clearPendingAtomicWorkflowCommitSideEffects(
  internals: EngineInternals,
  workflowId: string,
): void {
  internals.pendingAtomicWorkflowCommitSideEffects.delete(workflowId);
}
