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
import { pendingAtomicWorkflowCommitSideEffectsStagePut } from '../checkpoint-side-effects.ts';
import { getWorkflowExecutionStartedAt } from '../handles.ts';
import { dropQueuedInlineWorkflowStart } from '../inline-launch-queue.ts';
import type { EngineInternals } from '../internals.ts';
import { EMPTY_STORAGE_VALUE } from '../lifecycle.ts';
import {
  createTeardownTimerId,
  createTerminalCleanupTimerId,
  summarizeTimelineValue,
  type TeardownClaim,
} from '../state-utilities.ts';
import { releaseWorkflowConcurrencySlot } from '../workflow-concurrency.ts';
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
    const terminalCleanupToken = internals.workflowsNeedingTerminalCleanup.has(workflowId)
      ? crypto.randomUUID()
      : undefined;
    const attributeBytes = await internals.storage.get(KEYS.attribute(workflowId));
    const attributes = attributeBytes
      ? (decode(attributeBytes) as Record<string, SearchAttributeValue>)
      : {};
    // A finalizer is only owed when the workflow recorded resource state
    // (`ctx.setFinalizerState`) before terminating — read presence up front,
    // alongside the attribute read, so the terminal batch can stage the marker
    // and teardown timer atomically. Absent state means no resource to destroy.
    //
    // `setFinalizerState` STAGES its `wf-finalizer-state:` put as a pending atomic
    // side-effect that the terminal `updateWorkflowState` batch below flushes
    // (`includePendingAtomicSideEffects` is set for terminal transitions). If no
    // checkpoint ran between the call and this terminal transition, that put has NOT
    // reached durable storage yet, so `storage.get()` alone returns null and we would
    // skip the marker even though the state is about to be committed — silently leaking
    // the resource. Peek the staged buffer too (non-destructively; the commit flush
    // still consumes it). The buffer is frozen here: `terminalizingWorkflows` already
    // contains this id, so `recordFinalizerState` can stage nothing new.
    const finalizerStatePresent =
      (await internals.storage.get(KEYS.finalizerState(workflowId))) !== null ||
      pendingAtomicWorkflowCommitSideEffectsStagePut(
        internals,
        workflowId,
        KEYS.finalizerState(workflowId),
      );
    const retainedAttributes = buildRetainedTerminalSearchAttributes(attributes);
    const terminationMessage = status === 'timed-out' ? 'Workflow timed out' : 'Workflow cancelled';
    const terminationResult = await updateWorkflowState(
      internals,
      workflowId,
      {
        status,
        ...(reason !== undefined ? { terminationReason: reason } : {}),
        ...(terminalCleanupToken !== undefined ? { terminalCleanupToken } : {}),
      },
      // Cancel/timeout are EXTERNAL terminal transitions (ADR 0002): any engine
      // may commit them against a workflow it does not own, so this rotates the
      // claim epoch under `ownership: 'workflow-lease'` rather than fencing on
      // this engine's own claim.
      'external-terminal',
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
          return [
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
    if (!terminationResult) {
      return;
    }
    // Captured synchronously, immediately after the commit resolved — see
    // `releaseWorkflowClaimAfterTerminalSettlement`'s doc.
    const claimEpoch = captureCurrentClaimEpoch(internals, workflowId);
    // Run teardown handlers only after the state transition succeeds — this
    // prevents handlers from firing when the workflow was already terminal.
    await runCancellationHandlersForStatus(internals, workflowId, status, callbacks);
    await releaseWorkflowConcurrencySlot(internals, workflowId);

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
    const terminalError = buildTerminalError(workflowId, status, elapsed, reason);
    await releaseWorkflowClaimAfterTerminalSettlement(internals, workflowId, claimEpoch);

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

/**
 * Release this engine's `workflow-lease` claim (if any) once a terminal
 * transition has durably committed. Without this, `completeWorkflow`,
 * `failWorkflow`, and `terminateWorkflow` (cancel/timeout) leave a terminated
 * workflow's claim registry entry in place — the recurring renewal pass
 * (`workflow-claim-renewal-task.ts`) keeps renewing it, and the held set only
 * shrinks via retention, purge, or engine disposal, unboundedly inflating
 * active claims and renewal writes on a long-lived engine with lengthy or
 * disabled retention.
 *
 * Must run AFTER the terminal commit resolved (never before): a `'self'`-
 * fenced write (completeWorkflow/failWorkflow) still needs this engine's
 * claim to land, and even an `'external-terminal'`-fenced write
 * (terminateWorkflow) needs the ordering fixed relative to the state
 * transition it accompanies. Best-effort, matching
 * `WorkflowClaimRegistry.releaseAll()`'s own posture: a lost CAS or a storage
 * error here just leaves the claim for TTL/grace expiry — strictly no worse
 * than today's behavior, and never worth failing an already-committed
 * terminal transition over. A harmless no-op when this engine holds no claim
 * for `workflowId` (an `'external-terminal'` writer that never actually
 * owned the workflow, or `ownership: 'none'`/`'lease'`, where
 * `workflowClaimRegistry` is `null`).
 *
 * Called BEFORE this engine's own in-process result-waiter settlement
 * (`notifyCompletionWaiters`'s `resolver.resolve()`, or this file's own
 * `resolver.reject()` calls), not after: resolving/rejecting a `Promise` a
 * second time is a documented no-op, so releasing first and then settling is
 * safe even if a concurrent cross-engine result poll
 * (`handle-result.ts`'s `deferToLocalTerminalDeliveryIfPending`) observes "no
 * local epoch" and settles the SAME shared waiter itself first — both paths
 * derive the identical result from the same durably-committed terminal
 * state. Releasing AFTER, by contrast, would let an external caller that
 * merely awaited `handle.result()` observe completion before the claim
 * release it might depend on (e.g. a subsequent reclaim-scan assertion in a
 * test) has actually happened, since `resolve()`/`reject()` only schedules
 * the awaiting `.then()` as a later microtask — it proves nothing about
 * synchronous code still running after it in this same function.
 *
 * `capturedEpoch` MUST be read synchronously (no intervening `await`)
 * immediately after the terminal write commits — never re-read fresh at the
 * top of this function. Every call site already awaits at least one thing
 * (`releaseWorkflowConcurrencySlot`, or this file's own cleanup/notify calls)
 * between the commit and this call; `onTerminalConflict: 'start-new'` can
 * replace the workflow and install a NEW registry entry for the same id
 * during that exact gap. Releasing unconditionally would then delete the
 * REPLACEMENT's holder and stop its renewal instead of the generation that
 * actually completed — the release is therefore conditioned on the registry
 * still tracking the exact epoch this call captured, mirroring
 * `confirmStillRunningOrReleaseFreshClaim`'s same generation-safety pattern
 * in `workflow-claim-reclaim-target.ts`.
 */
function captureCurrentClaimEpoch(internals: EngineInternals, workflowId: string): number | null {
  return internals.workflowClaimRegistry?.currentEpoch(workflowId) ?? null;
}

async function releaseWorkflowClaimAfterTerminalSettlement(
  internals: EngineInternals,
  workflowId: string,
  capturedEpoch: number | null,
): Promise<void> {
  const registry = internals.workflowClaimRegistry;
  if (registry === null || capturedEpoch === null) return;
  if (registry.currentEpoch(workflowId) !== capturedEpoch) return;
  try {
    await registry.release(workflowId);
  } catch {
    // Best-effort — see this function's doc.
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

      // completeWorkflow is a SELF-transition (ADR 0002): this engine is
      // finishing its own workflow.
      await callbacks.commitSelfWorkflowStateOperations(state, completionOperations, {
        includePendingAtomicSideEffects: true,
      });
      // Captured synchronously, immediately after the commit resolves — see
      // `releaseWorkflowClaimAfterTerminalSettlement`'s doc for why this
      // must not be re-read after the awaits below.
      const claimEpoch = captureCurrentClaimEpoch(internals, workflowId);
      return { duration, claimEpoch };
    },
  );
  if (!completionMetadata) return;

  await releaseWorkflowConcurrencySlot(internals, workflowId);
  await releaseWorkflowClaimAfterTerminalSettlement(
    internals,
    workflowId,
    completionMetadata.claimEpoch,
  );
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
  const terminalCleanupToken = internals.workflowsNeedingTerminalCleanup.has(workflowId)
    ? crypto.randomUUID()
    : undefined;
  if (error.stack !== undefined) {
    stateUpdate.errorStack = error.stack;
  }
  if (terminalCleanupToken !== undefined) {
    stateUpdate.terminalCleanupToken = terminalCleanupToken;
  }
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
      buildAdditionalOperations: (_previousState, updatedAt) => {
        finalizePendingTimelineEntry(internals, workflowId, 'failed', error.message, updatedAt);
        const pendingTimelineOperation = buildPendingTimelineOperation(internals, workflowId);
        return [
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
  if (!failureResult) {
    return;
  }
  // Captured synchronously, immediately after the commit resolved — see
  // `releaseWorkflowClaimAfterTerminalSettlement`'s doc.
  const claimEpoch = captureCurrentClaimEpoch(internals, workflowId);

  await releaseWorkflowConcurrencySlot(internals, workflowId);

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
  await releaseWorkflowClaimAfterTerminalSettlement(internals, workflowId, claimEpoch);
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
