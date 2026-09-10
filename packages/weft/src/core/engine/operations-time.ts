import type { BatchOperation } from '../../storage/interface.ts';
import { KEYS, storageHas } from '../../storage/interface.ts';
import { deserializeCheckpoint } from '../checkpoint.ts';
import { encode } from '../codec.ts';
import type { ContextOperationRequest } from '../context.ts';
import { buildTimerBatchOperations, normalizeStorageTimestamp } from '../scheduler.ts';
import type { Checkpoint, StartOptions, TimerEntry, WorkflowState } from '../types.ts';
import { notifyConditionWaiters, notifyConditionWaitersForTimerFire } from './condition-waiters.ts';
import { commitFencedEngineWrite } from './fenced-write.ts';
import type { EngineInternals } from './internals.ts';
import { resolveDelayedStartRegistrationOrFail } from './lifecycle/delayed-start-registration.ts';
import { reprovideRecoveredServices } from './lifecycle/recovered-services.ts';
import { ensureDelayedStartClaimAndCleanupBeforeFailure } from './lifecycle/standalone-claim-acquire.ts';
import {
  acknowledgeSupersededSleepTimers,
  handleSleepTimerWithAcknowledgement,
  resolveSleepTimer,
  retainDiscardedDurableTimer,
} from './sleep-timer-acknowledgements.ts';
import { type TimeOperationCallbacks } from './time-operation-callbacks.ts';
import { commitWithWorkflowClaimFold, prepareWorkflowClaimFold } from './workflow-claim-fold.ts';
import { buildWorkflowVisibilityIndexTransition } from './workflow-indexes.ts';

type SleepOperation = Extract<ContextOperationRequest, { type: 'sleep' }>;

export type { TimeOperationCallbacks };

export function createDelayedStartTimerEntry(
  _internals: EngineInternals,
  workflowId: string,
  scheduledStartAt: number,
  options: StartOptions | undefined,
  callbacks: Pick<TimeOperationCallbacks, 'parseStartOptionDuration'>,
): TimerEntry {
  return {
    id: `delayed-start:${workflowId}`,
    workflowId,
    fireAt: scheduledStartAt,
    kind: 'delayed-start',
    ...(options?.executionTimeout !== undefined && {
      executionTimeoutMs: callbacks.parseStartOptionDuration(
        options.executionTimeout,
        'options.executionTimeout',
      ),
    }),
  };
}

/** Returns true when the scheduler fired this run's sleep before resolver registration. */
function sleepTimerFiredEarly(
  internals: EngineInternals,
  workflowId: string,
  operation: Pick<SleepOperation, 'operationId' | 'scheduledFireAt'>,
): boolean {
  const workflowMarkers = internals.sleepTimersFiredWithoutResolver.get(workflowId);
  if (!workflowMarkers) return false;
  const markedFireAt = workflowMarkers.get(operation.operationId);
  if (markedFireAt === undefined) return false;
  workflowMarkers.delete(operation.operationId);
  if (workflowMarkers.size === 0) {
    internals.sleepTimersFiredWithoutResolver.delete(workflowId);
  }
  if (markedFireAt < operation.scheduledFireAt) {
    acknowledgeSupersededSleepTimers(internals, workflowId, operation.scheduledFireAt);
  }
  return markedFireAt >= operation.scheduledFireAt;
}

export async function processSleepOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: SleepOperation,
  callbacks: Pick<TimeOperationCallbacks, 'completeOperation' | 'loadWorkflowState'>,
): Promise<void> {
  if (operation.scheduledFireAt <= internals.options.getNow()) {
    callbacks.completeOperation(workflowId, undefined);
    return;
  }

  const { promise, resolve } = Promise.withResolvers<void>();
  await internals.scheduler.schedule({
    id: `sleep:${operation.operationId}`,
    workflowId,
    fireAt: operation.scheduledFireAt,
    kind: 'sleep',
  });
  registerSleepResolver(
    internals,
    workflowId,
    operation.operationId,
    resolve,
    operation.scheduledFireAt,
  );

  // Guard against the race where the scheduler tick fires the timer in the window
  // between the schedule() write and registerSleepResolver(). The resolver guard
  // prevents a spurious resolveSleepTimer call once the tick already settled it.
  const resolverKey = `${workflowId}:${operation.operationId}`;
  if (
    sleepTimerFiredEarly(internals, workflowId, operation) &&
    internals.sleepResolvers.has(resolverKey)
  ) {
    resolveSleepTimer(internals, {
      id: `sleep:${operation.operationId}`,
      workflowId,
      fireAt: operation.scheduledFireAt,
      kind: 'sleep',
    });
  }

  await promise;

  const postSleepState = await callbacks.loadWorkflowState(workflowId);
  if (postSleepState?.status === 'running') {
    callbacks.completeOperation(workflowId, undefined);
  }
}

export function registerSleepResolver(
  internals: EngineInternals,
  workflowId: string,
  operationId: string,
  resolve: () => void,
  scheduledFireAt: number,
): void {
  // Store the deadline so resolveSleepTimer ignores a stale timer reused by an old run.
  internals.sleepResolvers.set(`${workflowId}:${operationId}`, {
    resolve,
    fireAt: scheduledFireAt,
  });

  let workflowOperations = internals.sleepResolversByWorkflow.get(workflowId);
  if (!workflowOperations) {
    workflowOperations = new Set();
    internals.sleepResolversByWorkflow.set(workflowId, workflowOperations);
  }
  workflowOperations.add(operationId);

  const readinessWaiters = internals.sleepResolverReadyWaitersForTesting?.get(workflowId);
  if (readinessWaiters !== undefined) {
    internals.sleepResolverReadyWaitersForTesting?.delete(workflowId);
    for (const notifyReady of readinessWaiters) notifyReady();
  }
}

export async function startDelayedWorkflow(
  internals: EngineInternals,
  entry: TimerEntry,
  callbacks: Pick<
    TimeOperationCallbacks,
    | 'beginWorkflowExecution'
    | 'dispatchEvent'
    | 'failWorkflow'
    | 'handleCleanupError'
    | 'loadWorkflowStartHeaders'
    | 'loadWorkflowState'
    | 'resolveExecutableRegistrationForRevision'
    | 'runSerializedWorkflowStateWrite'
    | 'setWorkflowStartHeaders'
    | 'workflowVersionTupleFromState'
  >,
): Promise<void> {
  const state = await callbacks.loadWorkflowState(entry.workflowId);
  if (!state || state.status !== 'pending') {
    return;
  }

  const checkpoint = await loadDelayedWorkflowCheckpoint(internals, entry, callbacks);
  if (!checkpoint) {
    return;
  }

  const resolvedRegistration = await resolveDelayedStartRegistrationOrFail(
    internals,
    entry,
    state.type,
    state.revision,
    callbacks,
  );
  if (resolvedRegistration === null) {
    return;
  }
  // The resolver's OWN resolved revision, not `state.revision` re-read
  // independently: for a legacy, pre-revision-pinning pending record with
  // exactly one registered candidate, `state.revision` stays `undefined`
  // even though the resolver unambiguously resolved that candidate. Using
  // `state.revision` here would silently mis-stamp the identity cache
  // (WFT-19 review round 7) — mirrors `resume.ts`'s `resolvedRevision`.
  const { entry: registration, revision: resolvedRevision } = resolvedRegistration;

  const now = internals.options.getNow();
  const executionDeadline = await resolveDelayedExecutionDeadline(internals, entry, now, callbacks);
  if (executionDeadline === 'invalid') return;

  const runningState = await callbacks.runSerializedWorkflowStateWrite(
    entry.workflowId,
    async () => {
      const latestState = await callbacks.loadWorkflowState(entry.workflowId);
      if (!latestState || latestState.status !== 'pending') {
        return null;
      }

      // `latestState.revision ?? resolvedRevision` — NEVER the other order.
      // `resolveExecutableRegistrationForRevision()` always returns
      // `revision: undefined` for an eager registration (eager has no
      // ambiguity to resolve against), even when `latestState.revision` is a
      // real, independently-meaningful pin (stamped at ordinary start time
      // for every registration kind). Blindly preferring `resolvedRevision`
      // would silently WIPE that pin on every eager-type delayed-start fire.
      // `resolvedRevision` only fills the gap for the one case it actually
      // applies to: a legacy, pre-revision-pinning pending record on a
      // `registerSource()`-registered type with exactly one registered
      // candidate, where `latestState.revision` is itself `undefined` even
      // though the resolver unambiguously resolved that sole candidate.
      // Mirrors `createForkedWorkflowState()`'s identical fix (WFT-19 review
      // round 6) for the same resolver contract, one launch path over.
      const effectiveRevision = latestState.revision ?? resolvedRevision;
      const nextRunningState: WorkflowState = {
        ...latestState,
        status: 'running',
        startedAt: now,
        updatedAt: now,
        // Conditional spread, not a plain property: `revision` is optional
        // and `exactOptionalPropertyTypes` forbids assigning an explicit
        // `undefined` to it.
        ...(effectiveRevision !== undefined && { revision: effectiveRevision }),
        ...(executionDeadline !== undefined && { executionDeadline }),
      };

      const operations: BatchOperation[] = [
        {
          type: 'put',
          key: KEYS.workflow(entry.workflowId),
          value: encode(nextRunningState),
        },
        ...buildWorkflowVisibilityIndexTransition(entry.workflowId, latestState, nextRunningState)
          .batchOps,
      ];
      if (executionDeadline !== undefined) {
        operations.push(
          ...buildTimerBatchOperations({
            id: `deadline:${entry.workflowId}`,
            workflowId: entry.workflowId,
            fireAt: executionDeadline,
            kind: 'execution-deadline',
          }),
        );
      }

      // ADR 0002 row `startDelayedWorkflow` (delayed-start timer fire):
      // claim-acquiring — this is where a delayed-start workflow gets its FIRST
      // owner, since its create batch is intentionally external (no claim held
      // yet; see `lifecycle/start-commit.ts`). Fold `acquire()` into this SAME
      // pending→running batch when `workflow-lease` applies; a lost claim race
      // here is background-scanner territory (this fire is dispatched by the
      // scheduler tick, not an explicit single-workflow caller), so it is
      // reported by returning `null` — never thrown — letting the caller skip
      // this workflow and the scheduler continue its sweep undisturbed.
      const claimFold = await prepareWorkflowClaimFold(internals, entry.workflowId);
      if (claimFold) {
        const result = await commitWithWorkflowClaimFold(
          internals,
          claimFold,
          operations,
          [],
          'delayed-start workflow claim acquisition',
        );
        return result.status === 'committed' ? nextRunningState : null;
      }

      // Fence the delayed-start pending→running transition on the lease epoch: a
      // deposed timer must not flip a workflow the successor already owns. (Epoch-only
      // is sufficient under lease ownership's single-writer invariant; the existing
      // in-process serialization above handles same-engine ordering.) Also the
      // `ownership: 'none'` path, and the `'workflow-lease'` path while no
      // `WorkflowClaimRegistry` is constructed yet (a parallel construction stage).
      await commitFencedEngineWrite(
        internals,
        entry.workflowId,
        operations,
        [],
        () =>
          new Error(
            `Delayed-start transition for workflow "${entry.workflowId}" lost its CAS race.`,
          ),
      );
      return nextRunningState;
    },
  );
  if (!runningState) {
    return;
  }

  // A delayed-start workflow that crashed `pending` before its timer fired loses
  // its in-memory services on recovery (fires in a fresh process). Re-provide
  // them before execution, as resume does — fail rather than run with
  // `ctx.services === undefined`.
  const servicesUnavailable = await reprovideRecoveredServices(
    internals,
    runningState,
    (workflowId, error) => callbacks.failWorkflow(workflowId, error),
    callbacks.handleCleanupError,
    callbacks.dispatchEvent,
  );
  if (servicesUnavailable) {
    return;
  }

  // Re-derive terminal-cleanup tracking from the durable marker, as resume does.
  if (await storageHas(internals.storage, KEYS.terminalCleanupNeeded(entry.workflowId))) {
    internals.workflowsNeedingTerminalCleanup.add(entry.workflowId);
  }

  internals.checkpoints.set(entry.workflowId, checkpoint);
  internals.workflowVersionTuples.set(
    entry.workflowId,
    callbacks.workflowVersionTupleFromState(runningState),
  );
  callbacks.setWorkflowStartHeaders(
    entry.workflowId,
    await callbacks.loadWorkflowStartHeaders(entry.workflowId),
  );
  callbacks.beginWorkflowExecution(
    entry.workflowId,
    runningState.workflowExecutionToken,
    runningState.type,
    // `runningState.revision` — the EFFECTIVE revision computed above
    // (`latestState.revision ?? resolvedRevision`) and persisted onto this
    // exact state, never the raw `resolvedRevision` alone: that would
    // silently wipe an eager type's real pin (see the stamp's doc). The
    // per-instance identity cache this populates (`start-exec.ts`) must
    // agree with what storage now holds (WFT-19 review round 7).
    runningState.revision,
    runningState.input,
    checkpoint,
    executionDeadline,
    runningState.executionStateOwnerId ?? entry.workflowId,
    registration,
  );
}

async function loadDelayedWorkflowCheckpoint(
  internals: EngineInternals,
  entry: TimerEntry,
  callbacks: Pick<TimeOperationCallbacks, 'failWorkflow'>,
): Promise<Checkpoint | null> {
  const checkpointBytes = await internals.storage.get(KEYS.checkpoint(entry.workflowId));
  if (!checkpointBytes) {
    await callbacks.failWorkflow(
      entry.workflowId,
      new Error(`Checkpoint not found for delayed workflow "${entry.workflowId}"`),
    );
    return null;
  }

  return deserializeCheckpoint(checkpointBytes);
}

async function resolveDelayedExecutionDeadline(
  internals: EngineInternals,
  entry: TimerEntry,
  now: number,
  callbacks: Pick<TimeOperationCallbacks, 'failWorkflow'>,
): Promise<number | undefined | 'invalid'> {
  if (entry.executionTimeoutMs === undefined) {
    return undefined;
  }

  if (!Number.isFinite(entry.executionTimeoutMs) || entry.executionTimeoutMs < 0) {
    await failInvalidDelayedExecutionTimeout(internals, entry, callbacks);
    return 'invalid';
  }

  try {
    return normalizeStorageTimestamp(
      now + entry.executionTimeoutMs,
      `Delayed execution timeout for workflow "${entry.workflowId}"`,
    );
  } catch {
    await failInvalidDelayedExecutionTimeout(internals, entry, callbacks);
    return 'invalid';
  }
}

async function failInvalidDelayedExecutionTimeout(
  internals: EngineInternals,
  entry: TimerEntry,
  callbacks: Pick<TimeOperationCallbacks, 'failWorkflow'>,
): Promise<void> {
  await ensureDelayedStartClaimAndCleanupBeforeFailure(internals, entry.workflowId);
  await callbacks.failWorkflow(
    entry.workflowId,
    new Error(`Invalid delayed execution timeout for workflow "${entry.workflowId}"`),
  );
}

export async function handleTimerFired(
  internals: EngineInternals,
  entry: TimerEntry,
  callbacks: Pick<
    TimeOperationCallbacks,
    | 'failWorkflow'
    | 'handleCleanupError'
    | 'loadWorkflowStartHeaders'
    | 'loadWorkflowState'
    | 'runDeferredTerminalCleanup'
    | 'runWorkflowFinalizer'
    | 'runSerializedWorkflowStateWrite'
    | 'handleScheduleTimer'
    | 'setWorkflowStartHeaders'
    | 'timeout'
    | 'beginWorkflowExecution'
    | 'dispatchEvent'
    | 'resolveExecutableRegistrationForRevision'
    | 'workflowVersionTupleFromState'
  >,
): Promise<void> {
  if (isReviewTimerEntry(entry)) {
    await handleReviewTimer(internals, entry, callbacks);
    return;
  }

  if (entry.kind === 'delayed-start') {
    await startDelayedWorkflow(internals, entry, callbacks);
    return;
  }

  if (entry.kind === 'terminal-cleanup') {
    await callbacks.runDeferredTerminalCleanup(entry.workflowId, entry.id);
    return;
  }

  if (entry.kind === 'teardown') {
    await callbacks.runWorkflowFinalizer(entry.workflowId, entry.id);
    return;
  }

  if (entry.kind === 'schedule') {
    await callbacks.handleScheduleTimer(entry);
    return;
  }

  if (entry.kind === 'sleep') {
    await handleSleepTimerWithAcknowledgement(internals, entry, callbacks.loadWorkflowState);
  } else if (entry.kind === 'wait-condition') {
    // registry null: unchanged sync fast path ('none'/'lease'), no async hop.
    if (internals.workflowClaimRegistry === null) {
      resolveConditionTimer(internals, entry);
    } else {
      await resolveConditionTimerConfirmingOwnership(internals, entry, callbacks.loadWorkflowState);
    }
  } else if (entry.kind === 'execution-deadline') {
    await callbacks.timeout(entry.workflowId);
  }
}

function isReviewTimerEntry(entry: TimerEntry): boolean {
  return entry.id.startsWith('review-escalation:') || entry.id.startsWith('review-timeout:');
}

/** Wakes a parked `ctx.waitUntil`. `'none'`/`'lease'` fast path; see `handleTimerFired`. */
function resolveConditionTimer(internals: EngineInternals, entry: TimerEntry): void {
  notifyConditionWaiters(internals, entry.workflowId);
}

/**
 * `'workflow-lease'` counterpart to {@link resolveConditionTimer}: awaits the
 * ownership-confirmed wake so the Scheduler never treats this fire as
 * "processed" before the decision (and wake) has happened. On `'discard'`,
 * retains-or-collects like `sleep` does.
 */
async function resolveConditionTimerConfirmingOwnership(
  internals: EngineInternals,
  entry: TimerEntry,
  loadWorkflowState: (workflowId: string) => Promise<WorkflowState | null>,
): Promise<void> {
  const decision = await notifyConditionWaitersForTimerFire(internals, entry.workflowId);
  if (decision === 'discard') {
    await retainDiscardedDurableTimer(entry.id, entry.workflowId, loadWorkflowState);
  }
}

async function handleReviewTimer(
  internals: EngineInternals,
  entry: TimerEntry,
  callbacks: Pick<TimeOperationCallbacks, 'loadWorkflowState'>,
): Promise<void> {
  const reviewId = entry.id.split(':')[1];
  if (!reviewId) return;

  const handler = internals.reviewEscalationHandlers.get(reviewId);
  if (!handler) return;

  const state = await callbacks.loadWorkflowState(entry.workflowId);
  if (!state || state.status !== 'running') return;
  await handler(entry);
}
