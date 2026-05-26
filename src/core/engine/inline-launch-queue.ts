import { WorkflowStartedEvent } from '../events.ts';
import type { QueuedInlineWorkflowExecutionStart } from './engine-internal-types.ts';
import type { EngineInternals } from './internals.ts';
import { startWorkflowExecution } from './lifecycle.ts';
import { loadWorkflowState } from './storage-io.ts';

export type InlineLaunchQueueCallbacks = {
  processPendingUpdatesAfterInlineAdvance: (workflowId: string) => Promise<void>;
  swallowPromiseRejection: (promise: Promise<unknown> | undefined) => Promise<void>;
};

/** Queue a new inline workflow start and schedule a flush if one is not already scheduled. */
export function queueInlineWorkflowExecutionStart(
  internals: EngineInternals,
  start: QueuedInlineWorkflowExecutionStart,
  callbacks: InlineLaunchQueueCallbacks,
): void {
  internals.queuedInlineWorkflowStartIds.add(start.workflowId);
  internals.queuedOrLaunchingInlineWorkflowStartIds.add(start.workflowId);
  internals.queuedInlineWorkflowStarts.push(start);
  if (internals.queuedInlineWorkflowStartFlushScheduled) {
    return;
  }

  internals.queuedInlineWorkflowStartFlushScheduled = true;
  if (internals.queuedInlineWorkflowStartChannel !== null) {
    internals.queuedInlineWorkflowStartChannel.port2.postMessage(undefined);
    return;
  }

  setTimeout(() => {
    internals.queuedInlineWorkflowStartFlushScheduled = false;
    void callbacks.swallowPromiseRejection(flushQueuedInlineWorkflowStarts(internals, callbacks));
  }, 0);
}

export async function flushQueuedInlineWorkflowStarts(
  internals: EngineInternals,
  callbacks: InlineLaunchQueueCallbacks,
): Promise<void> {
  if (internals.abortController.signal.aborted) {
    internals.queuedInlineWorkflowStarts = [];
    return;
  }

  if (internals.queuedInlineWorkflowStarts.length === 0) {
    return;
  }

  const pendingStarts = internals.queuedInlineWorkflowStarts;
  internals.queuedInlineWorkflowStarts = [];

  for (const start of pendingStarts) {
    await startQueuedInlineWorkflowExecution(internals, start, callbacks);
  }
}

/** Used by scheduler-driven direct backfill flushes. Clears the scheduled flag first. */
export async function flushQueuedInlineWorkflowStartsDirectly(
  internals: EngineInternals,
  callbacks: InlineLaunchQueueCallbacks,
): Promise<void> {
  internals.queuedInlineWorkflowStartFlushScheduled = false;
  await flushQueuedInlineWorkflowStarts(internals, callbacks);
}

async function startQueuedInlineWorkflowExecution(
  internals: EngineInternals,
  start: QueuedInlineWorkflowExecutionStart,
  callbacks: Pick<InlineLaunchQueueCallbacks, 'processPendingUpdatesAfterInlineAdvance'>,
): Promise<void> {
  try {
    const state = await loadWorkflowState(internals, start.workflowId);
    if (!state || state.status !== 'running') {
      return;
    }

    internals.queuedInlineWorkflowStartIds.delete(start.workflowId);
    internals.engine.dispatchEvent(
      new WorkflowStartedEvent(start.workflowId, start.workflowType, start.input),
    );
    startWorkflowExecution(
      internals,
      start.workflowId,
      start.workflowType,
      start.input,
      start.checkpoint,
      start.nestingDepth,
      start.executionDeadline,
      start.executionStateOwnerId,
    );

    await callbacks.processPendingUpdatesAfterInlineAdvance(start.workflowId);
  } finally {
    internals.queuedInlineWorkflowStartIds.delete(start.workflowId);
    internals.queuedOrLaunchingInlineWorkflowStartIds.delete(start.workflowId);
  }
}

export function dropQueuedInlineWorkflowStart(
  internals: EngineInternals,
  workflowId: string,
): boolean {
  if (internals.queuedInlineWorkflowStarts.length === 0) {
    return false;
  }

  const initialLength = internals.queuedInlineWorkflowStarts.length;
  internals.queuedInlineWorkflowStarts = internals.queuedInlineWorkflowStarts.filter(
    (start) => start.workflowId !== workflowId,
  );
  if (internals.queuedInlineWorkflowStarts.length !== initialLength) {
    internals.queuedInlineWorkflowStartIds.delete(workflowId);
    internals.queuedOrLaunchingInlineWorkflowStartIds.delete(workflowId);
  }
  return internals.queuedInlineWorkflowStarts.length !== initialLength;
}

export function disposeQueuedInlineWorkflowStarts(internals: EngineInternals): void {
  internals.queuedInlineWorkflowStartFlushScheduled = false;
  internals.queuedInlineWorkflowStarts = [];
  internals.queuedInlineWorkflowStartIds.clear();
  internals.queuedOrLaunchingInlineWorkflowStartIds.clear();

  const channel = internals.queuedInlineWorkflowStartChannel;
  if (channel !== null) {
    channel.port1.close();
    channel.port2.close();
    internals.queuedInlineWorkflowStartChannel = null;
  }
}

export function hasQueuedInlineWorkflowStart(
  internals: EngineInternals,
  workflowId: string,
): boolean {
  return internals.queuedInlineWorkflowStartIds.has(workflowId);
}

export function hasQueuedOrLaunchingInlineWorkflowStart(
  internals: EngineInternals,
  workflowId: string,
): boolean {
  return internals.queuedOrLaunchingInlineWorkflowStartIds.has(workflowId);
}

function workflowStatusCanRetainLocalOwnership(workflowStatus: string): boolean {
  return workflowStatus === 'running' || workflowStatus === 'pending';
}

export function isInlineWorkflowLocallyOwned(
  internals: EngineInternals,
  workflowId: string,
  workflowStatus: string,
): boolean {
  if (!workflowStatusCanRetainLocalOwnership(workflowStatus)) {
    return false;
  }

  if (hasQueuedOrLaunchingInlineWorkflowStart(internals, workflowId)) {
    return true;
  }

  if (internals.inlineStrategy === null) {
    return false;
  }

  return (
    internals.inlineStrategy.getContext(workflowId) !== undefined ||
    internals.inlineStrategy.waitForWorkflowTurn(workflowId) !== undefined ||
    internals.parkedInlineWorkflows.has(workflowId)
  );
}

export function hasLocalCheckpointOwnership(
  internals: EngineInternals,
  workflowId: string,
  workflowStatus: string,
): boolean {
  return (
    internals.checkpoints.has(workflowId) && workflowStatusCanRetainLocalOwnership(workflowStatus)
  );
}
