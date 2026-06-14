import { KEYS, decodeStorageKeyComponent, type BatchOperation } from '../../storage/interface.ts';

import { registerCancelHandler } from './cancel-handlers.ts';
import type { WorkflowHandle } from './handles.ts';
import type { EngineInternals } from './internals.ts';
import { EMPTY_STORAGE_VALUE } from './lifecycle/shared.ts';

type ChildCancellationCallbacks = {
  getHandle: (workflowId: string) => WorkflowHandle;
};

export function buildChildCancellationOperations(
  internals: EngineInternals,
  workflowId: string,
  childWorkflowId: string,
): BatchOperation[] {
  const operations: BatchOperation[] = [
    {
      type: 'put',
      key: KEYS.childCancellation(workflowId, childWorkflowId),
      value: EMPTY_STORAGE_VALUE,
    },
  ];

  const needsCleanupMarker = !internals.workflowsNeedingTerminalCleanup.has(workflowId);
  internals.workflowsNeedingTerminalCleanup.add(workflowId);
  if (needsCleanupMarker) {
    operations.push({
      type: 'put',
      key: KEYS.terminalCleanupNeeded(workflowId),
      value: EMPTY_STORAGE_VALUE,
    });
  }

  return operations;
}

export function registerChildCancellationHandler(
  internals: EngineInternals,
  workflowId: string,
  childWorkflowId: string,
  callbacks: ChildCancellationCallbacks,
): void {
  registerCancelHandler(internals, workflowId, () => callbacks.getHandle(childWorkflowId).cancel());
}

export async function rehydrateChildCancellationHandlers(
  internals: EngineInternals,
  workflowId: string,
  callbacks: ChildCancellationCallbacks,
): Promise<void> {
  for await (const [key] of internals.storage.scan(KEYS.childCancellationPrefix(workflowId))) {
    const childWorkflowId = decodeChildCancellationKey(workflowId, key);
    if (childWorkflowId === null) continue;
    registerChildCancellationHandler(internals, workflowId, childWorkflowId, callbacks);
  }
}

function decodeChildCancellationKey(workflowId: string, key: string): string | null {
  const prefix = KEYS.childCancellationPrefix(workflowId);
  if (!key.startsWith(prefix)) return null;

  const encodedChildWorkflowId = key.slice(prefix.length);
  if (encodedChildWorkflowId.length === 0 || encodedChildWorkflowId.includes(':')) return null;

  return decodeStorageKeyComponent(encodedChildWorkflowId);
}
