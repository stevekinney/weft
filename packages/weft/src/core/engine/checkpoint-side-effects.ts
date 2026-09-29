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
  workflowExecutionToken?: string,
  bindToExecutionGeneration = false,
): void {
  if (sideEffects.conditions.length === 0 && sideEffects.operations.length === 0) {
    return;
  }

  if (bindToExecutionGeneration) {
    internals.pendingOperationAtomicWorkflowCommitSideEffects ??= new Map();
    const byToken =
      internals.pendingOperationAtomicWorkflowCommitSideEffects.get(workflowId) ?? new Map();
    const tokenKey = workflowExecutionToken ?? '';
    const pending = byToken.get(tokenKey);
    if (pending === undefined) {
      byToken.set(tokenKey, {
        conditions: [...sideEffects.conditions],
        operations: [...sideEffects.operations],
      });
    } else {
      pending.conditions.push(...sideEffects.conditions);
      pending.operations.push(...sideEffects.operations);
    }
    internals.pendingOperationAtomicWorkflowCommitSideEffects.set(workflowId, byToken);
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
  workflowExecutionToken?: string,
): AtomicWorkflowCommitSideEffects | undefined {
  const pendingEntries = [] as AtomicWorkflowCommitSideEffects[];
  const unbound = internals.pendingAtomicWorkflowCommitSideEffects.get(workflowId);
  if (unbound !== undefined) {
    internals.pendingAtomicWorkflowCommitSideEffects.delete(workflowId);
    pendingEntries.push(unbound);
  }
  const byToken = internals.pendingOperationAtomicWorkflowCommitSideEffects?.get(workflowId);
  if (byToken !== undefined) {
    internals.pendingOperationAtomicWorkflowCommitSideEffects.delete(workflowId);
    const bound = byToken.get(workflowExecutionToken ?? '');
    if (bound !== undefined) pendingEntries.push(bound);
  }
  if (pendingEntries.length === 0) return undefined;
  const pending = pendingEntries.reduce(
    (combined, entry) => ({
      conditions: [...combined.conditions, ...entry.conditions],
      operations: [...combined.operations, ...entry.operations],
    }),
    { conditions: [], operations: [] } as AtomicWorkflowCommitSideEffects,
  );
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
  internals.pendingOperationAtomicWorkflowCommitSideEffects?.delete(workflowId);
}

export function clearAllPendingAtomicWorkflowCommitSideEffects(internals: EngineInternals): void {
  internals.pendingAtomicWorkflowCommitSideEffects.clear();
  internals.pendingOperationAtomicWorkflowCommitSideEffects?.clear();
}

/**
 * Non-destructively report whether a workflow's pending atomic side-effect buffer
 * already stages a `put` to `key`. Unlike {@link takePendingAtomicWorkflowCommitSideEffects},
 * this does NOT consume the buffer, so it is safe to call at a gate that runs before the
 * commit that will flush those same side-effects.
 *
 * The terminal-transition path (#446) needs this: `ctx.setFinalizerState()` stages the
 * `wf-finalizer-state:` put as a pending side-effect that the terminal batch flushes, but
 * a pre-batch `storage.get()` cannot see a staged-but-unflushed write. Peeking the buffer
 * lets the terminal batch stage its teardown marker atomically alongside that put — without
 * it, a `setFinalizerState` with no intervening checkpoint would commit the resource state
 * yet skip the teardown marker, silently leaking the external resource.
 */
export function pendingAtomicWorkflowCommitSideEffectsStagePut(
  internals: EngineInternals,
  workflowId: string,
  key: string,
): boolean {
  const pending = internals.pendingAtomicWorkflowCommitSideEffects.get(workflowId);
  if (pending === undefined) {
    return false;
  }
  return pending.operations.some((operation) => operation.type === 'put' && operation.key === key);
}
