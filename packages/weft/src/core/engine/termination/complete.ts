/* eslint-disable max-lines -- terminal orchestration keeps the complete state machine together. */
import type { BatchOperation } from "../../../embedded/storage/src/index.ts";
import { KEYS } from '../../../storage/keys.ts';
import { decode, encode } from '../../codec.ts';
import { errorCodeOf } from '../../error-code-of.ts';
import {
  ActivityCompletedEvent,
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowTimedOutEvent,
} from '../../events.ts';
import { tagWorkflowEventGeneration } from '../../events/workflow-event-generation.ts';
import { buildTimerBatchOperations, normalizeStorageTimestamp } from '../../scheduler.ts';
import { WorkflowTimeoutError } from '../../timeouts.ts';
import type {
  CancelWorkflowResult,
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
  writeRetainedTerminalSearchAttributes,
} from '../attributes-tags.ts';
import { TERMINAL_CLEANUP_DELAY_MS } from '../bulk-operations.ts';
import { takeCancelHandlers, type CancelHandler } from '../cancel-handlers.ts';
import { pendingAtomicWorkflowCommitSideEffectsStagePut } from '../checkpoint-side-effects.ts';
import type { WorkflowResultWaiter } from '../engine-internal-types.ts';
import { staleFailureGuard, type FailureOrigin } from '../execution-attempts.ts';
import { failedStepOf } from '../failure-record.ts';
import {
  fileWorkflowTerminalOperations,
  prepareFileWorkflowTerminalHistory as prepareTerminalHistory,
  recordFileWorkflowTerminalHistory as recordTerminalHistory,
  shouldRetryFileWorkflowTermination,
  type FileWorkflowRunIdentity,
} from '../file-workflow-history.ts';
import { getWorkflowExecutionStartedAt } from '../handles.ts';
import { captureInFlightActivityTurn } from '../in-flight-operation.ts';
import { dropQueuedInlineWorkflowStart } from '../inline-launch-queue.ts';
import type { EngineInternals } from '../internals.ts';
import { EMPTY_STORAGE_VALUE } from '../lifecycle.ts';
import { recordResultCommitter } from '../result-committer.ts';
import { resultWaiterForRun } from '../result-waiter-run.ts';
import {
  createTeardownTimerId,
  createTerminalCleanupTimerId,
  summarizeTimelineValue,
  type TeardownClaim,
} from '../state-utilities.ts';
import { isSupersededBySameIdRun } from '../superseded-generation.ts';
import {
  beginPendingTerminalSettlement,
  startPendingTerminalSettlement,
  type PendingTerminalSettlement,
} from '../terminal-settlement-pending.ts';
import { captureActivityCompletionReceipts } from '../timeline-coordinator-detail.ts';
import { releaseWorkflowConcurrencySlotForRun } from '../workflow-concurrency.ts';
import { updateWorkflowState } from '../workflow-state-update.ts';
import {
  refreshWorkflowVisibilityMaintenance,
  visibilityIndexOperations,
} from '../workflow-visibility-maintenance.ts';
import {
  cleanupTerminalWorkflowImmediately,
  cleanupTerminalWorkflowSynchronously,
  finalizeScheduledWorkflowTerminal,
  FORCIBLY_TERMINABLE_STATUSES,
  type TerminationCallbacks,
} from './cleanup.ts';
import {
  appendSearchAttributeOperations,
  buildCompletedWorkflowState,
  terminalCommitterStamp,
} from './completion-operations.ts';
import {
  cancellationOutcomeFromRefusal,
  captureTerminatedRun,
  settleTerminatedRunAfterRefusal,
} from './settle-refused-terminal.ts';
import {
  captureCurrentClaimEpoch,
  releaseWorkflowClaimAfterTerminalSettlement,
} from './terminal-claim-release.ts';
import {
  cancelRunTimers,
  captureOrReadTerminalFence,
  fencedTeardownCommit,
  sameRunCondition,
  warnUnknownRunIdentity,
} from './terminal-fence.ts';

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
): Promise<CancelWorkflowResult> {
  return await terminateWorkflow(internals, workflowId, 'cancelled', callbacks);
}

export async function timeoutWorkflow(
  internals: EngineInternals,
  workflowId: string,
  callbacks: TerminationCallbacks,
): Promise<void> {
  await terminateWorkflow(internals, workflowId, 'timed-out', callbacks);
}

// eslint-disable-next-line complexity -- identity-fenced retry adds one causal branch to this state machine.
export async function terminateWorkflow(
  internals: EngineInternals,
  workflowId: string,
  status: 'cancelled' | 'timed-out',
  callbacks: TerminationCallbacks,
  reason?: TerminationReason,
  historyRetry = 0,
  historyRunIdentity?: FileWorkflowRunIdentity,
): Promise<CancelWorkflowResult> {
  const terminatedRun = captureTerminatedRun(internals, workflowId);
  const inFlightActivityTurn = captureInFlightActivityTurn(internals, workflowId);
  let pendingSettlement: PendingTerminalSettlement | undefined;
  internals.terminalizingWorkflows.add(workflowId);
  dropQueuedInlineWorkflowStart(internals, workflowId);
  internals.strategy.cancelWorkflow(workflowId);
  try {
    const fileWorkflowHistory = await prepareTerminalHistory(
      internals,
      workflowId,
      status,
      historyRunIdentity,
    );
    const capturedHistoryRunIdentity = historyRunIdentity ?? fileWorkflowHistory?.identity;
    const terminalCleanupToken = internals.workflowsNeedingTerminalCleanup.has(workflowId)
      ? crypto.randomUUID()
      : undefined;
    const attributeBytes = await internals.storage.get(KEYS.attribute(workflowId));
    const attributes = attributeBytes
      ? (decode(attributeBytes) as Record<string, SearchAttributeValue>)
      : {};
    const finalizerStatePresent =
      (await internals.storage.get(KEYS.finalizerState(workflowId))) !== null ||
      pendingAtomicWorkflowCommitSideEffectsStagePut(
        internals,
        workflowId,
        KEYS.finalizerState(workflowId),
      );
    const retainedAttributes = buildRetainedTerminalSearchAttributes(attributes);
    const terminationMessage = status === 'timed-out' ? 'Workflow timed out' : 'Workflow cancelled';
    let terminationResult: Awaited<ReturnType<typeof updateWorkflowState>>;
    try {
      terminationResult = await updateWorkflowState(
        internals,
        workflowId,
        {
          status,
          ...(reason !== undefined ? { terminationReason: reason } : {}),
          ...(terminalCleanupToken !== undefined ? { terminalCleanupToken } : {}),
          ...terminalCommitterStamp(internals),
        },
        'external-terminal',
        {
          allowedStatuses: FORCIBLY_TERMINABLE_STATUSES,
          ...(capturedHistoryRunIdentity === undefined
            ? {}
            : {
                expectedWorkflowExecutionToken:
                  capturedHistoryRunIdentity.workflowExecutionToken ?? null,
              }),
          ...(fileWorkflowHistory === undefined
            ? {}
            : {
                extraConditions: [
                  fileWorkflowHistory.condition(),
                  sameRunCondition(workflowId, {
                    generation: fileWorkflowHistory.identity.generation,
                    holderMarker: null,
                  }),
                ],
              }),
          buildAdditionalOperations: (_previousState, updatedAt) => {
            finalizePendingTimelineEntry(
              internals,
              workflowId,
              status,
              terminationMessage,
              updatedAt,
            );
            const pendingTimelineOperation = buildPendingTimelineOperation(internals, workflowId);
            const historyOperations = fileWorkflowTerminalOperations(fileWorkflowHistory);
            return [
              ...historyOperations,
              ...(pendingTimelineOperation ? [pendingTimelineOperation] : []),
              ...(terminalCleanupToken !== undefined
                ? buildTerminalCleanupTimerOperations(
                    internals,
                    workflowId,
                    true,
                    updatedAt,
                    terminalCleanupToken,
                  )
                : []),
              // Stage the durable teardown marker + timer atomically with the
              // terminal transition (#446 Phase 2). Gated on recorded finalizer state
              // ALONE — NOT on whether the current registration declares a finalizer —
              // so a recorded resource is never silently dropped when the type isn't
              // registered with a finalizer here (see buildTeardownOperations). A
              // workflow that never recorded state pays nothing. The marker carries the
              // execution claim, fenced on the lease epoch by the enclosing terminal batch.
              ...buildTeardownOperations(workflowId, finalizerStatePresent, updatedAt),
            ];
          },
        },
      );
    } catch (error) {
      if (
        await shouldRetryFileWorkflowTermination(
          internals,
          workflowId,
          fileWorkflowHistory,
          historyRetry,
        )
      ) {
        return terminateWorkflow(
          internals,
          workflowId,
          status,
          callbacks,
          reason,
          historyRetry + 1,
          capturedHistoryRunIdentity,
        );
      }
      throw error;
    }
    if (!terminationResult) {
      await settleTerminatedRunAfterRefusal(internals, workflowId, callbacks, terminatedRun);
      if (status === 'timed-out') {
        return { workflowId, status: 'already-terminal', terminalStatus: 'timed-out' };
      }
      throw new Error(`Workflow "${workflowId}" was not found.`);
    }
    if ('kind' in terminationResult) {
      await settleTerminatedRunAfterRefusal(internals, workflowId, callbacks, terminatedRun);
      return cancellationOutcomeFromRefusal(workflowId, terminationResult);
    }
    recordTerminalHistory(internals, workflowId, fileWorkflowHistory);
    const { previousState, updatedAt, fence } = terminationResult;
    const elapsed = updatedAt - getWorkflowExecutionStartedAt(previousState);
    const terminalError = buildTerminalError(workflowId, status, elapsed, reason);
    // Set as soon as the commit's batch resolves, before any further I/O: only a microtask-level
    // race remains for a first `result()` whose read resolves in the same few hops.
    pendingSettlement = beginPendingTerminalSettlement(
      internals,
      { workflowId, workflowExecutionToken: previousState.workflowExecutionToken },
      inFlightActivityTurn,
      terminalError,
    );
    // Captured synchronously after the commit — see `releaseWorkflowClaimAfterTerminalSettlement`.
    const claimEpoch = captureCurrentClaimEpoch(internals, workflowId);
    const executionToken = internals.checkpoints.get(workflowId)?.workflowExecutionToken;
    // Run teardown handlers only after the state transition succeeds — this
    // prevents handlers from firing when the workflow was already terminal.
    await runCancellationHandlersForStatus(internals, workflowId, status, callbacks);
    const isSuperseded = () => isSupersededBySameIdRun(internals, workflowId, executionToken);
    await releaseWorkflowConcurrencySlotForRun(internals, workflowId, fence);
    warnUnknownRunIdentity(fence, workflowId, callbacks.handleCleanupError);

    // Fenced on this run's committed state: the id's attribute record is the replacement's once one lands.
    const fenced = fencedTeardownCommit(internals, workflowId, fence, isSuperseded);
    await cleanupAttributeIndex(internals, workflowId, attributes, fenced);
    await writeRetainedTerminalSearchAttributes(workflowId, retainedAttributes, fenced);
    // A same-id `start-new` replacement owns the deadline / delayed-start timer keys.
    const timerIds = [`deadline:${workflowId}`];
    if (previousState.status === 'pending') timerIds.push(`delayed-start:${workflowId}`);
    cancelRunTimers(
      internals,
      workflowId,
      fence,
      isSuperseded,
      timerIds,
      callbacks.swallowPromiseRejection,
    );

    // Match the waiter against the durable run for this external transition.
    const resolver = isSuperseded()
      ? undefined
      : resultWaiterForRun(internals, workflowId, previousState.workflowExecutionToken);
    if (pendingSettlement) pendingSettlement.waiter = resolver;
    // A held result is rejected, and its entry dropped, by the pending settlement instead.
    const settleResolver = (): void => {
      if (resolver && !pendingSettlement) settleRejected(internals, resolver, terminalError);
    };
    await releaseWorkflowClaimAfterTerminalSettlement(internals, workflowId, claimEpoch);
    const superseded = isSuperseded();

    try {
      if (!superseded) {
        await cleanupTerminalWorkflowSynchronously(internals, workflowId, true, callbacks, fenced);
      }

      const event = buildTerminalEvent(workflowId, status, elapsed, reason);
      callbacks.dispatchEvent(event);
      if (!superseded) callbacks.forwardEventToHandle(workflowId, event);

      settleResolver();
      // Scheduled queue handoff is best-effort cleanup and must not block
      // terminal delivery or handle settlement.
      void finalizeScheduledWorkflowTerminal(internals, workflowId, callbacks);
    } catch (cleanupError) {
      settleResolver();
      throw cleanupError;
    } finally {
      if (!superseded && !pendingSettlement) internals.resultResolvers.delete(workflowId);
    }
    return { workflowId, status: 'cancel-requested' };
  } finally {
    internals.terminalizingWorkflows.delete(workflowId);
    // After the terminal event is out, and on every path out, so a held result is always released.
    startPendingTerminalSettlement(internals, pendingSettlement);
  }
}

/** The error a terminated workflow's result promise rejects with. */
function buildTerminalError(
  workflowId: string,
  status: 'cancelled' | 'timed-out',
  elapsed: number,
  reason: TerminationReason | undefined,
): Error {
  return status === 'timed-out'
    ? new WorkflowTimeoutError(workflowId, 'execution', elapsed, reason)
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

/** Settle `waiter` with a result this engine committed, recording that first. */
function settleResolved(
  internals: EngineInternals,
  waiter: WorkflowResultWaiter,
  result: unknown,
): void {
  recordResultCommitter(waiter, internals.workflowClaimRegistry?.engineId);
  waiter.resolve(result);
}

/** Settle `waiter` as rejected by an outcome this engine committed, recording that first. */
function settleRejected(
  internals: EngineInternals,
  waiter: WorkflowResultWaiter,
  error: unknown,
): void {
  recordResultCommitter(waiter, internals.workflowClaimRegistry?.engineId);
  waiter.reject(error);
}

function buildBaseCompletionOperations(
  internals: EngineInternals,
  workflowId: string,
  previousState: WorkflowState,
  updatedState: WorkflowState,
): BatchOperation[] {
  const operations: BatchOperation[] = [
    ...buildTerminalWorkflowIndexOperations(previousState, updatedState),
    { type: 'put', key: KEYS.workflow(workflowId), value: encode(updatedState) },
    ...visibilityIndexOperations(internals, previousState, updatedState),
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
  superseded: boolean,
  cancelDeadline: () => void,
  executionToken: string | undefined,
): void {
  // Cancel deadline timer - fire-and-forget since the workflow is already
  // terminal and a stale timer firing will see the terminal state and no-op.
  // Fenced on the run's generation: a same-id replacement's deadline timer
  // lives under the same id and must survive.
  cancelDeadline();

  // Drop in-memory state immediately so the hot path releases engine memory
  // before result delivery. Durable scratch cleanup is handled by the
  // persisted terminal-cleanup timer written in the same state batch above.
  // A superseded run's in-memory state, and any result waiter now registered
  // under this id, belong to the same-id replacement: leave both alone. A
  // superseded run's own waiter was already settled with that run's terminal
  // outcome and removed by the start-new purge (COR-1386), so this path has
  // nothing to settle and must leave the replacement's map entry alone.
  const resolver = superseded
    ? undefined
    : resultWaiterForRun(internals, workflowId, executionToken);
  try {
    if (!superseded) cleanupTerminalWorkflowImmediately(internals, workflowId, callbacks);

    const event = new WorkflowCompletedEvent(workflowId, result, duration);
    callbacks.dispatchEvent(event);
    // The handle cached under this id now belongs to the replacement; a
    // terminal event forwarded to it would complete its observables and
    // iterators while it is still running.
    if (!superseded) callbacks.forwardEventToHandle(workflowId, event);

    callbacks.broadcast({ type: 'workflow:completed', workflowId });

    if (resolver) settleResolved(internals, resolver, result);
    // Scheduled queue handoff is best-effort cleanup and must not block
    // terminal delivery or handle settlement.
    void finalizeScheduledWorkflowTerminal(internals, workflowId, callbacks);
  } catch (completionError) {
    if (resolver) settleResolved(internals, resolver, result);
    throw completionError;
  } finally {
    if (!superseded) internals.resultResolvers.delete(workflowId);
  }
}

export async function completeWorkflow(
  internals: EngineInternals,
  workflowId: string,
  result: unknown,
  callbacks: TerminationCallbacks,
): Promise<void> {
  const fileWorkflowHistory = await prepareTerminalHistory(internals, workflowId, 'completed');
  const completionMetadata = await callbacks.runSerializedWorkflowStateWrite(
    workflowId,
    async () => {
      const state = await callbacks.loadWorkflowState(workflowId);
      if (!state || state.status !== 'running') {
        return null;
      }
      const captured = captureOrReadTerminalFence(
        internals,
        workflowId,
        state.workflowExecutionToken,
      );
      // Settled before the commit; awaited only when the adoption read is still in flight.
      const fence = captured instanceof Promise ? await captured : captured;
      const visibilityMaintenance = refreshWorkflowVisibilityMaintenance(internals);
      if (visibilityMaintenance !== undefined) await visibilityMaintenance;
      const now = normalizeStorageTimestamp(
        internals.options.getNow(),
        'Workflow completion timestamp',
      );
      const duration = now - getWorkflowExecutionStartedAt(state);
      const terminalCleanupToken = internals.workflowsNeedingTerminalCleanup.has(workflowId)
        ? crypto.randomUUID()
        : undefined;

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

      // Batch the completion state write with attribute index cleanup into a
      // single storage transaction to reduce round-trips on the hot path.
      const buildOperations = (base: WorkflowState): BatchOperation[] => {
        const updatedState = buildCompletedWorkflowState(
          internals,
          base,
          result,
          now,
          terminalCleanupToken,
        );
        const operations = buildBaseCompletionOperations(internals, workflowId, base, updatedState);
        fileWorkflowHistory?.append(operations);
        appendSearchAttributeOperations(operations, workflowId, currentAttributes);
        if (terminalCleanupToken !== undefined) {
          operations.push(
            ...buildTerminalCleanupTimerOperations(
              internals,
              workflowId,
              false,
              now,
              terminalCleanupToken,
            ),
          );
        }
        return operations;
      };
      const completionOperations = buildOperations(state);
      const activityCompletionReceipts = captureActivityCompletionReceipts(internals, workflowId);

      // completeWorkflow is a SELF-transition (ADR 0002): this engine is
      // finishing its own workflow.
      await callbacks.commitSelfWorkflowStateOperations(state, completionOperations, {
        includePendingAtomicSideEffects: true,
        // A refused write is retried in process; if every attempt fails the run fails as a
        // `system` failure with `CheckpointCommitFailedError` (see `handleStrategyMessage`).
        retryRefusedWrite: 'completion',
        // Another writer that changed the record while the run was still `running` (a tag edit,
        // say) does not stop it completing: the completion is built again over that fresher record.
        rebuildOperations: buildOperations,
      });
      // Captured synchronously, immediately after the commit resolves — see
      // `releaseWorkflowClaimAfterTerminalSettlement`'s doc for why this
      // must not be re-read after the awaits below.
      const claimEpoch = captureCurrentClaimEpoch(internals, workflowId);
      const executionToken = internals.checkpoints.get(workflowId)?.workflowExecutionToken;
      return { duration, claimEpoch, executionToken, fence, activityCompletionReceipts };
    },
  );
  if (!completionMetadata) return;
  recordTerminalHistory(internals, workflowId, fileWorkflowHistory);
  const { claimEpoch, executionToken, fence, activityCompletionReceipts } = completionMetadata;
  for (const receipt of activityCompletionReceipts) {
    callbacks.dispatchEvent(
      tagWorkflowEventGeneration(
        new ActivityCompletedEvent(
          receipt.operationId,
          workflowId,
          receipt.activityName,
          receipt.duration,
        ),
        receipt.workflowExecutionToken,
      ),
    );
  }
  const isSuperseded = () => isSupersededBySameIdRun(internals, workflowId, executionToken);

  await releaseWorkflowConcurrencySlotForRun(internals, workflowId, fence);
  warnUnknownRunIdentity(fence, workflowId, callbacks.handleCleanupError);
  await releaseWorkflowClaimAfterTerminalSettlement(internals, workflowId, claimEpoch);
  const superseded = isSuperseded();
  notifyCompletionWaiters(
    internals,
    workflowId,
    result,
    completionMetadata.duration,
    callbacks,
    superseded,
    () =>
      cancelRunTimers(
        internals,
        workflowId,
        fence,
        isSuperseded,
        [`deadline:${workflowId}`],
        callbacks.swallowPromiseRejection,
      ),
    executionToken,
  );
}

export async function failWorkflow(
  internals: EngineInternals,
  workflowId: string,
  error: Error,
  callbacks: TerminationCallbacks,
  failureCategory: FailureCategory = 'system',
  failureOrigin: FailureOrigin = 'execution',
): Promise<void> {
  // Captured before the first await: see `staleFailureGuard`.
  const skipCommitIf = staleFailureGuard(internals, workflowId, failureOrigin);
  const attributeBytes = await internals.storage.get(KEYS.attribute(workflowId));
  const attributes = attributeBytes
    ? (decode(attributeBytes) as Record<string, SearchAttributeValue>)
    : {};
  const retainedAttributes = buildRetainedTerminalSearchAttributes(attributes, {
    failureCategory,
  });
  const fileWorkflowHistory = await prepareTerminalHistory(internals, workflowId, 'failed');
  const stateUpdate: Partial<WorkflowState> = {
    status: 'failed',
    error: error.message,
    failureCategory,
  };
  const terminalCleanupToken = internals.workflowsNeedingTerminalCleanup.has(workflowId)
    ? crypto.randomUUID()
    : undefined;
  if (error.stack !== undefined) {
    stateUpdate.errorStack = error.stack;
  }
  // The code and the step ride the failure write itself (COR-2529). The step is the pending
  // timeline entry this write finalizes as `failed` below, so the two always agree.
  const errorCode = errorCodeOf(error);
  if (errorCode !== undefined) stateUpdate.errorCode = errorCode;
  const failedStep = failedStepOf(internals.pendingTimelineEntries.get(workflowId)?.entry);
  if (failedStep !== undefined) stateUpdate.failedStep = failedStep;
  if (terminalCleanupToken !== undefined) {
    stateUpdate.terminalCleanupToken = terminalCleanupToken;
  }
  Object.assign(stateUpdate, terminalCommitterStamp(internals));
  const failureResult = await updateWorkflowState(
    internals,
    workflowId,
    stateUpdate,
    // failWorkflow is a SELF-transition (ADR 0002): this engine is finishing
    // its own workflow, so the write fences on this engine's own claim rather
    // than rotating the epoch.
    'self',
    {
      // See FORCIBLY_TERMINABLE_STATUSES — 'suspended' included so a cross-process
      // resume whose services are unavailable can fail the run (the fail path runs
      // before the suspended→running flip) instead of stranding it 'suspended'.
      allowedStatuses: FORCIBLY_TERMINABLE_STATUSES,
      // Never write a terminal state over a generation this engine abandoned after losing a
      // checkpoint CAS, or over a run it has launched again since this failure began. Judged
      // after the last read, so a failure of the current attempt still fails normally.
      skipCommitIf,
      // A refused failure write is retried in process; if every attempt fails nothing durable can
      // be written, and `handleStrategyMessage` abandons the generation locally.
      retryRefusedWrite: 'failure',
      buildAdditionalOperations: (_previousState, updatedAt) => {
        finalizePendingTimelineEntry(internals, workflowId, 'failed', error.message, updatedAt);
        const pendingTimelineOperation = buildPendingTimelineOperation(internals, workflowId);
        const historyOperations = fileWorkflowTerminalOperations(fileWorkflowHistory);
        return [
          ...historyOperations,
          ...(pendingTimelineOperation ? [pendingTimelineOperation] : []),
          ...(terminalCleanupToken !== undefined
            ? buildTerminalCleanupTimerOperations(
                internals,
                workflowId,
                false,
                updatedAt,
                terminalCleanupToken,
              )
            : []),
        ];
      },
    },
  );
  if (!failureResult || 'kind' in failureResult) {
    return;
  }
  recordTerminalHistory(internals, workflowId, fileWorkflowHistory);
  // Captured synchronously, immediately after the commit resolved — see
  // `releaseWorkflowClaimAfterTerminalSettlement`'s doc.
  const claimEpoch = captureCurrentClaimEpoch(internals, workflowId);
  const executionToken = internals.checkpoints.get(workflowId)?.workflowExecutionToken;
  const isSuperseded = () => isSupersededBySameIdRun(internals, workflowId, executionToken);
  const fence = failureResult.fence;
  await releaseWorkflowConcurrencySlotForRun(internals, workflowId, fence);
  warnUnknownRunIdentity(fence, workflowId, callbacks.handleCleanupError);
  const fenced = fencedTeardownCommit(internals, workflowId, fence, isSuperseded);

  // A superseded run touches neither the attribute record nor the deadline timer.
  await cleanupAttributeIndex(internals, workflowId, attributes, fenced);
  const deadline = [`deadline:${workflowId}`];
  cancelRunTimers(
    internals,
    workflowId,
    fence,
    isSuperseded,
    deadline,
    callbacks.swallowPromiseRejection,
  );
  // Keep engine-managed terminal attributes queryable after the cleanup above.
  await writeRetainedTerminalSearchAttributes(workflowId, retainedAttributes, fenced);

  const resolver = isSuperseded()
    ? undefined
    : resultWaiterForRun(internals, workflowId, executionToken);
  await releaseWorkflowClaimAfterTerminalSettlement(internals, workflowId, claimEpoch);
  const superseded = isSuperseded();
  try {
    if (!superseded) {
      await cleanupTerminalWorkflowSynchronously(internals, workflowId, false, callbacks, fenced);
    }
    const event = new WorkflowFailedEvent(workflowId, error);
    callbacks.dispatchEvent(event);
    if (!superseded) callbacks.forwardEventToHandle(workflowId, event);

    if (resolver) settleRejected(internals, resolver, error);
    // Scheduled queue handoff is best-effort cleanup and must not block
    // terminal delivery or handle settlement.
    void finalizeScheduledWorkflowTerminal(internals, workflowId, callbacks);
  } catch (cleanupError) {
    if (resolver) settleRejected(internals, resolver, error);
    throw cleanupError;
  } finally {
    if (!superseded) internals.resultResolvers.delete(workflowId);
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

/**
 * Stage the durable teardown marker + timer for the terminal batch (#446 Phase 2).
 * Returns no operations unless a resource was recorded via `ctx.setFinalizerState`
 * (a workflow that never recorded state pays nothing). The durable `teardownOwed`
 * marker rides this same terminal batch as the finalizer state, so the synchronous
 * terminal cleanup that runs later in this call — and any cleanup after a crash/recover —
 * reads the committed marker to skip sweeping the finalizer-needed keys while teardown is
 * outstanding. The timer fires immediately (`fireAt = terminalizedAt`) because a paid
 * external resource should be destroyed now, not after a delay.
 *
 * The gate is `finalizerStatePresent` ALONE — it does NOT also require the current
 * registration to declare a `finalizer`. This matches the drive's stance: a fired timer
 * whose workflow type isn't registered with a finalizer LEAVES the marker and re-arms (a
 * node that recovers the type can run it), rather than clearing it. Skipping the marker
 * here when the registration lacks a finalizer would commit `wf-finalizer-state:` and then
 * let deferred cleanup delete it with no marker → a recorded external resource leaks
 * silently. Tradeoff (assumed transient): if the workflow type is NEVER (re)registered
 * with a finalizer, the marker is immortal and re-arms on the self-heal interval — a
 * VISIBLE unpurgeable workflow, which we prefer over a silent resource leak.
 */
function buildTeardownOperations(
  workflowId: string,
  finalizerStatePresent: boolean,
  terminalizedAt: number,
): BatchOperation[] {
  if (!finalizerStatePresent) {
    return [];
  }
  const token = crypto.randomUUID();
  const claim: TeardownClaim = { status: 'owed', attempts: 0, token };

  return [
    { type: 'put', key: KEYS.teardownOwed(workflowId), value: encode(claim) },
    ...buildTimerBatchOperations({
      id: createTeardownTimerId(token),
      workflowId,
      fireAt: terminalizedAt,
      kind: 'teardown',
    }),
  ];
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
