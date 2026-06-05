import type { BatchOperation } from '../../../storage/interface.ts';
import { KEYS } from '../../../storage/interface.ts';
import { decode, encode } from '../../codec.ts';
import {
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowTimedOutEvent,
} from '../../events.ts';
import { buildTimerBatchOperations, normalizeStorageTimestamp } from '../../scheduler.ts';
import { buildIndexOperations } from '../../search-attributes.ts';
import { WorkflowTimeoutError } from '../../timeouts.ts';
import type {
  FailureCategory,
  SearchAttributeValue,
  TerminationReason,
  WorkflowState,
  WorkflowTimelineEntry,
} from '../../types.ts';
import {
  buildRetainedTerminalSearchAttributes,
  buildTerminalWorkflowIndexOperations,
  cleanupAttributeIndex,
  updateWorkflowState,
  writeRetainedTerminalSearchAttributes,
} from '../attributes-tags.ts';
import { TERMINAL_CLEANUP_DELAY_MS } from '../bulk-operations.ts';
import { takeCancelHandlers, type CancelHandler } from '../cancel-handlers.ts';
import { getWorkflowExecutionStartedAt } from '../handles.ts';
import { dropQueuedInlineWorkflowStart } from '../inline-launch-queue.ts';
import type { EngineInternals } from '../internals.ts';
import { EMPTY_STORAGE_VALUE } from '../lifecycle.ts';
import { createTerminalCleanupTimerId, summarizeTimelineValue } from '../state-utilities.ts';
import { buildWorkflowVisibilityIndexTransition } from '../workflow-indexes.ts';
import {
  cleanupTerminalWorkflowImmediately,
  cleanupTerminalWorkflowSynchronously,
  finalizeScheduledWorkflowTerminal,
  FORCIBLY_TERMINABLE_STATUSES,
  type TerminationCallbacks,
} from './cleanup.ts';

async function runCancelHandlers(
  handlers: CancelHandler[],
  callbacks: Pick<TerminationCallbacks, 'handleCleanupError'>,
  workflowId: string,
): Promise<void> {
  for (const handler of handlers) {
    try {
      await handler();
    } catch (error) {
      callbacks.handleCleanupError('cancel-handler', error, workflowId);
    }
  }
}

async function runCancellationHandlersForStatus(
  internals: EngineInternals,
  workflowId: string,
  status: 'cancelled' | 'timed-out',
  callbacks: Pick<TerminationCallbacks, 'handleCleanupError'>,
): Promise<void> {
  if (status !== 'cancelled') return;
  const cancelHandlers = takeCancelHandlers(internals, workflowId);
  await runCancelHandlers(cancelHandlers, callbacks, workflowId);
}

export async function cancelWorkflow(
  internals: EngineInternals,
  workflowId: string,
  callbacks: TerminationCallbacks,
): Promise<void> {
  await terminateWorkflow(internals, workflowId, 'cancelled', callbacks);
}

export async function timeoutWorkflow(
  internals: EngineInternals,
  workflowId: string,
  callbacks: TerminationCallbacks,
): Promise<void> {
  await terminateWorkflow(internals, workflowId, 'timed-out', callbacks);
}

export async function terminateWorkflow(
  internals: EngineInternals,
  workflowId: string,
  status: 'cancelled' | 'timed-out',
  callbacks: TerminationCallbacks,
  reason?: TerminationReason,
): Promise<void> {
  internals.terminalizingWorkflows.add(workflowId);
  dropQueuedInlineWorkflowStart(internals, workflowId);
  internals.strategy.cancelWorkflow(workflowId);

  try {
    const attributeBytes = await internals.storage.get(KEYS.attribute(workflowId));
    const attributes = attributeBytes
      ? (decode(attributeBytes) as Record<string, SearchAttributeValue>)
      : {};
    const retainedAttributes = buildRetainedTerminalSearchAttributes(attributes);
    const terminationMessage = status === 'timed-out' ? 'Workflow timed out' : 'Workflow cancelled';
    const terminationResult = await updateWorkflowState(
      internals,
      workflowId,
      { status, ...(reason !== undefined ? { terminationReason: reason } : {}) },
      {
        // Total over non-terminal states (see FORCIBLY_TERMINABLE_STATUSES):
        // cancelling a suspended workflow terminates it and rejects its pending
        // result waiter rather than no-op'ing. The abort in strategy.cancelWorkflow
        // above is a no-op for a suspended run (controller evicted at suspend), so
        // cancel runs the registered handlers without driving the gone generator.
        allowedStatuses: FORCIBLY_TERMINABLE_STATUSES,
        buildAdditionalOperations: (_previousState, updatedAt) => {
          finalizePendingTimelineEntry(
            internals,
            workflowId,
            status,
            terminationMessage,
            updatedAt,
          );
          const pendingTimelineOperation = buildPendingTimelineOperation(internals, workflowId);
          return pendingTimelineOperation ? [pendingTimelineOperation] : [];
        },
      },
    );
    if (!terminationResult) {
      return;
    }
    // Run teardown handlers only after the state transition succeeds — this
    // prevents handlers from firing when the workflow was already terminal.
    await runCancellationHandlersForStatus(internals, workflowId, status, callbacks);

    const { previousState, updatedAt } = terminationResult;
    const elapsed = updatedAt - getWorkflowExecutionStartedAt(previousState);
    await cleanupAttributeIndex(internals, workflowId, attributes);
    await writeRetainedTerminalSearchAttributes(internals, workflowId, retainedAttributes);
    void callbacks.swallowPromiseRejection(
      internals.scheduler.cancel(`deadline:${workflowId}`, workflowId),
    );
    if (previousState.status === 'pending') {
      void callbacks.swallowPromiseRejection(
        internals.scheduler.cancel(`delayed-start:${workflowId}`, workflowId),
      );
    }

    const resolver = internals.resultResolvers.get(workflowId);
    const terminalError = buildTerminalError(workflowId, status, elapsed);

    try {
      await cleanupTerminalWorkflowSynchronously(internals, workflowId, true, callbacks);

      const event = buildTerminalEvent(workflowId, status, elapsed, reason);
      callbacks.dispatchEvent(event);
      callbacks.forwardEventToHandle(workflowId, event);

      if (resolver) resolver.reject(terminalError);
      // Scheduled queue handoff is best-effort cleanup and must not block
      // terminal delivery or handle settlement.
      void finalizeScheduledWorkflowTerminal(internals, workflowId, callbacks);
    } catch (cleanupError) {
      if (resolver) resolver.reject(terminalError);
      throw cleanupError;
    } finally {
      internals.resultResolvers.delete(workflowId);
    }
  } finally {
    internals.terminalizingWorkflows.delete(workflowId);
  }
}

/** The error a terminated workflow's result promise rejects with. */
function buildTerminalError(
  workflowId: string,
  status: 'cancelled' | 'timed-out',
  elapsed: number,
): Error {
  return status === 'timed-out'
    ? new WorkflowTimeoutError(workflowId, 'execution', elapsed)
    : new Error('Workflow cancelled');
}

/** The terminal lifecycle event dispatched for a terminated workflow. */
function buildTerminalEvent(
  workflowId: string,
  status: 'cancelled' | 'timed-out',
  elapsed: number,
  reason: TerminationReason | undefined,
): WorkflowTimedOutEvent | WorkflowCancelledEvent {
  return status === 'timed-out'
    ? new WorkflowTimedOutEvent(workflowId, 'execution', elapsed, reason)
    : new WorkflowCancelledEvent(workflowId);
}

function buildCompletedWorkflowState(
  state: WorkflowState,
  result: unknown,
  now: number,
  terminalCleanupToken: string | undefined,
): WorkflowState {
  return {
    ...state,
    status: 'completed' as const,
    result,
    updatedAt: now,
    ...(terminalCleanupToken !== undefined ? { terminalCleanupToken } : {}),
  };
}

function appendSearchAttributeOperations(
  operations: BatchOperation[],
  workflowId: string,
  currentAttributes: Record<string, SearchAttributeValue> | undefined,
): void {
  if (currentAttributes === undefined || Object.keys(currentAttributes).length === 0) return;
  const retainedAttributes = buildRetainedTerminalSearchAttributes(currentAttributes);
  operations.push(...buildIndexOperations(workflowId, currentAttributes, retainedAttributes));
  if (Object.keys(retainedAttributes).length > 0) {
    operations.push({
      type: 'put',
      key: KEYS.attribute(workflowId),
      value: encode(retainedAttributes),
    });
  } else {
    operations.push({ type: 'delete', key: KEYS.attribute(workflowId) });
  }
}

function buildBaseCompletionOperations(
  internals: EngineInternals,
  workflowId: string,
  previousState: WorkflowState,
  updatedState: WorkflowState,
): BatchOperation[] {
  const visibilityIndexOperations = buildWorkflowVisibilityIndexTransition(
    workflowId,
    previousState,
    updatedState,
  ).batchOps;
  const operations: BatchOperation[] = [
    ...buildTerminalWorkflowIndexOperations(previousState, updatedState),
    { type: 'put', key: KEYS.workflow(workflowId), value: encode(updatedState) },
    ...visibilityIndexOperations,
  ];
  const pendingTimelineOperation = buildPendingTimelineOperation(internals, workflowId);
  if (pendingTimelineOperation) {
    operations.push(pendingTimelineOperation);
  }
  return operations;
}

function notifyCompletionWaiters(
  internals: EngineInternals,
  workflowId: string,
  result: unknown,
  duration: number,
  callbacks: TerminationCallbacks,
): void {
  // Cancel deadline timer - fire-and-forget since the workflow is already
  // terminal and a stale timer firing will see the terminal state and no-op.
  void callbacks.swallowPromiseRejection(
    internals.scheduler.cancel(`deadline:${workflowId}`, workflowId),
  );

  // Drop in-memory state immediately so the hot path releases engine memory
  // before result delivery. Durable scratch cleanup is handled by the
  // persisted terminal-cleanup timer written in the same state batch above.
  const resolver = internals.resultResolvers.get(workflowId);
  try {
    cleanupTerminalWorkflowImmediately(internals, workflowId, callbacks);

    const event = new WorkflowCompletedEvent(workflowId, result, duration);
    callbacks.dispatchEvent(event);
    callbacks.forwardEventToHandle(workflowId, event);

    callbacks.broadcast({ type: 'workflow:completed', workflowId });

    if (resolver) resolver.resolve(result);
    // Scheduled queue handoff is best-effort cleanup and must not block
    // terminal delivery or handle settlement.
    void finalizeScheduledWorkflowTerminal(internals, workflowId, callbacks);
  } catch (completionError) {
    if (resolver) resolver.resolve(result);
    throw completionError;
  } finally {
    internals.resultResolvers.delete(workflowId);
  }
}

export async function completeWorkflow(
  internals: EngineInternals,
  workflowId: string,
  result: unknown,
  callbacks: TerminationCallbacks,
): Promise<void> {
  const completionMetadata = await callbacks.runSerializedWorkflowStateWrite(
    workflowId,
    async () => {
      const state = await callbacks.loadWorkflowState(workflowId);
      if (!state || state.status !== 'running') {
        return null;
      }

      const now = normalizeStorageTimestamp(
        internals.options.getNow(),
        'Workflow completion timestamp',
      );
      const duration = now - getWorkflowExecutionStartedAt(state);
      const terminalCleanupToken = internals.workflowsNeedingTerminalCleanup.has(workflowId)
        ? crypto.randomUUID()
        : undefined;

      // Batch the completion state write with attribute index cleanup into a
      // single storage transaction to reduce round-trips on the hot path.
      const updatedState = buildCompletedWorkflowState(state, result, now, terminalCleanupToken);
      const completionOperations = buildBaseCompletionOperations(
        internals,
        workflowId,
        state,
        updatedState,
      );

      // Prefer the in-memory checkpoint's search attributes when available so
      // the completion hot path avoids an extra storage read in the common
      // case. Recovered workflows still fall back to storage if the checkpoint
      // is unexpectedly absent.
      let currentAttributes = internals.checkpoints.get(workflowId)?.searchAttributes;
      if (currentAttributes === undefined) {
        const attributeBytes = await internals.storage.get(KEYS.attribute(workflowId));
        if (attributeBytes) {
          currentAttributes = decode(attributeBytes) as Record<string, SearchAttributeValue>;
        }
      }
      appendSearchAttributeOperations(completionOperations, workflowId, currentAttributes);

      if (terminalCleanupToken !== undefined) {
        completionOperations.push(
          ...buildTerminalCleanupTimerOperations(
            internals,
            workflowId,
            false,
            now,
            terminalCleanupToken,
          ),
        );
      }

      await callbacks.commitWorkflowStateOperations(state, completionOperations);
      return { duration };
    },
  );
  if (!completionMetadata) return;

  notifyCompletionWaiters(internals, workflowId, result, completionMetadata.duration, callbacks);
}

export async function failWorkflow(
  internals: EngineInternals,
  workflowId: string,
  error: Error,
  callbacks: TerminationCallbacks,
  failureCategory: FailureCategory = 'system',
): Promise<void> {
  const attributeBytes = await internals.storage.get(KEYS.attribute(workflowId));
  const attributes = attributeBytes
    ? (decode(attributeBytes) as Record<string, SearchAttributeValue>)
    : {};
  const retainedAttributes = buildRetainedTerminalSearchAttributes(attributes, {
    failureCategory,
  });

  const stateUpdate: Partial<WorkflowState> = {
    status: 'failed',
    error: error.message,
    failureCategory,
  };
  if (error.stack !== undefined) {
    stateUpdate.errorStack = error.stack;
  }
  const failureResult = await updateWorkflowState(internals, workflowId, stateUpdate, {
    // See FORCIBLY_TERMINABLE_STATUSES — 'suspended' included so a cross-process
    // resume whose services are unavailable can fail the run (the fail path runs
    // before the suspended→running flip) instead of stranding it 'suspended'.
    allowedStatuses: FORCIBLY_TERMINABLE_STATUSES,
    buildAdditionalOperations: (_previousState, updatedAt) => {
      finalizePendingTimelineEntry(internals, workflowId, 'failed', error.message, updatedAt);
      const pendingTimelineOperation = buildPendingTimelineOperation(internals, workflowId);
      return pendingTimelineOperation ? [pendingTimelineOperation] : [];
    },
  });
  if (!failureResult) {
    return;
  }

  // Clean up user-set attribute indexes; fire-and-forget the deadline
  // timer cancel since the workflow is terminal.
  await cleanupAttributeIndex(internals, workflowId, attributes);
  void callbacks.swallowPromiseRejection(
    internals.scheduler.cancel(`deadline:${workflowId}`, workflowId),
  );

  // Re-write engine-managed terminal attributes so they remain queryable
  // after the user-defined search attributes have been removed.
  await writeRetainedTerminalSearchAttributes(internals, workflowId, retainedAttributes);

  const resolver = internals.resultResolvers.get(workflowId);
  try {
    await cleanupTerminalWorkflowSynchronously(internals, workflowId, false, callbacks);

    const event = new WorkflowFailedEvent(workflowId, error);
    callbacks.dispatchEvent(event);
    callbacks.forwardEventToHandle(workflowId, event);

    if (resolver) resolver.reject(error);
    // Scheduled queue handoff is best-effort cleanup and must not block
    // terminal delivery or handle settlement.
    void finalizeScheduledWorkflowTerminal(internals, workflowId, callbacks);
  } catch (cleanupError) {
    if (resolver) resolver.reject(error);
    throw cleanupError;
  } finally {
    internals.resultResolvers.delete(workflowId);
  }
}

export function buildTerminalCleanupTimerOperations(
  _internals: EngineInternals,
  workflowId: string,
  includeOutputArtifacts: boolean,
  terminalizedAt: number,
  terminalCleanupToken: string,
): BatchOperation[] {
  return buildTimerBatchOperations({
    id: createTerminalCleanupTimerId(includeOutputArtifacts, terminalCleanupToken),
    workflowId,
    fireAt: terminalizedAt + TERMINAL_CLEANUP_DELAY_MS,
    kind: 'terminal-cleanup',
  });
}

export async function ensureTerminalCleanupTracked(
  internals: EngineInternals,
  workflowId: string,
): Promise<void> {
  if (internals.workflowsNeedingTerminalCleanup.has(workflowId)) {
    return;
  }

  internals.workflowsNeedingTerminalCleanup.add(workflowId);
  await internals.storage.put(KEYS.terminalCleanupNeeded(workflowId), EMPTY_STORAGE_VALUE);
}

export function finalizePendingTimelineEntry(
  internals: EngineInternals,
  workflowId: string,
  status: WorkflowTimelineEntry['status'],
  output: unknown,
  finishedAt = internals.options.getNow(),
): void {
  const pendingEntry = internals.pendingTimelineEntries.get(workflowId);
  if (!pendingEntry) {
    return;
  }

  const currentStatus = pendingEntry.entry.status;
  if (currentStatus === status) {
    return;
  }

  const canOverrideCompletedWithTerminalStatus =
    currentStatus === 'completed' &&
    (status === 'failed' || status === 'cancelled' || status === 'timed-out');
  if (currentStatus !== 'running' && !canOverrideCompletedWithTerminalStatus) {
    return;
  }

  pendingEntry.entry.status = status;
  pendingEntry.entry.outputSummary = summarizeTimelineValue(output);
  pendingEntry.entry.duration = finishedAt - pendingEntry.startedAt;
}

export function buildPendingTimelineOperation(
  internals: EngineInternals,
  workflowId: string,
): BatchOperation | null {
  const pendingEntry = internals.pendingTimelineEntries.get(workflowId);
  if (!pendingEntry) {
    return null;
  }

  return {
    type: 'put',
    key: KEYS.timeline(workflowId, pendingEntry.entry.step),
    value: encode(pendingEntry.entry),
  };
}
