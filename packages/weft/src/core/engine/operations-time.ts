import { storageHas } from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import { deserializeCheckpoint } from '../checkpoint.ts';
import type { ContextOperationRequest } from '../context.ts';
import { normalizeStorageTimestamp, type TimerFiredOutcome } from '../scheduler.ts';
import type { Checkpoint, StartOptions, TimerEntry, WorkflowState } from '../types.ts';
import { adoptLaunchCheckpoint } from './checkpoint-commit-snapshots.ts';
import { notifyConditionWaiters, notifyConditionWaitersForTimerFire } from './condition-waiters.ts';
import { commitDelayedStartRunning } from './delayed-start-commit.ts';
import { currentExecutionAttempt } from './execution-attempts.ts';
import type { EngineInternals } from './internals.ts';
import { resolveDelayedStartRegistrationOrFail } from './lifecycle/delayed-start-registration.ts';
import { reprovideRecoveredServices } from './lifecycle/recovered-services.ts';
import { ensureDelayedStartClaimAndCleanupBeforeFailure } from './lifecycle/standalone-claim-acquire.ts';
import {
  handOverPendingLaunch,
  letGoOfPendingLaunch,
  type PendingLaunch,
} from './local-execution.ts';
import { registerSleepResolver } from './sleep-resolver-registration.ts';
import {
  acknowledgeSupersededSleepTimers,
  fireExecutionDeadline,
  handleSleepTimerWithAcknowledgement,
  resolveSleepTimer,
  retainDiscardedDurableTimer,
  retainTimerOfAbandonedGeneration,
} from './sleep-timer-acknowledgements.ts';
import { type TimeOperationCallbacks } from './time-operation-callbacks.ts';
import { wakeNeedsOwnershipCheck } from './wake-ownership-guard.ts';

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

/** Whether the scheduler fired `timer`, this run's sleep, before its resolver registered. */
function sleepTimerFiredEarly(
  internals: EngineInternals,
  timer: TimerEntry,
  operationId: string,
): boolean {
  const { workflowId, fireAt: scheduledFireAt } = timer;
  const workflowMarkers = internals.sleepTimersFiredWithoutResolver.get(workflowId);
  if (!workflowMarkers) return false;
  const markedFireAt = workflowMarkers.get(operationId);
  if (markedFireAt === undefined) return false;
  const markerToken = internals.sleepTimerTokensFiredWithoutResolver
    ?.get(workflowId)
    ?.get(operationId);
  if (markerToken !== timer.workflowExecutionToken) return false;
  workflowMarkers.delete(operationId);
  internals.sleepTimerTokensFiredWithoutResolver?.get(workflowId)?.delete(operationId);
  if (workflowMarkers.size === 0) {
    internals.sleepTimersFiredWithoutResolver.delete(workflowId);
  }
  if (markedFireAt < scheduledFireAt) {
    acknowledgeSupersededSleepTimers(internals, workflowId, scheduledFireAt);
  }
  return markedFireAt >= scheduledFireAt;
}

export async function processSleepOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: SleepOperation,
  callbacks: Pick<TimeOperationCallbacks, 'completeOperation' | 'loadWorkflowState'>,
): Promise<void> {
  const workflowExecutionToken =
    internals.durableInlineOperations?.get(workflowId)?.workflowExecutionToken;
  // The run this sleep belongs to, captured before the timer write's await (COR-1604).
  const run = currentExecutionAttempt(internals, workflowId);
  if (operation.scheduledFireAt <= internals.options.getNow()) {
    callbacks.completeOperation(
      workflowId,
      undefined,
      operation.operationId,
      workflowExecutionToken,
    );
    return;
  }

  const { promise, resolve } = Promise.withResolvers<void>();
  const timer: TimerEntry = {
    id: `sleep:${operation.operationId}`,
    workflowId,
    fireAt: operation.scheduledFireAt,
    kind: 'sleep',
    ...(workflowExecutionToken === undefined ? {} : { workflowExecutionToken }),
  };
  await internals.scheduler.schedule(timer);
  const registered = registerSleepResolver(
    internals,
    workflowId,
    operation.operationId,
    resolve,
    operation.scheduledFireAt,
    workflowExecutionToken,
    run,
  );
  if (!registered) return;

  // Guard against the race where the scheduler tick fires the timer in the window
  // between the schedule() write and registerSleepResolver(). The resolver guard
  // prevents a spurious resolveSleepTimer call once the tick already settled it.
  // The replayed fire is the scheduled entry itself, token included: a resolver
  // bound to a token only accepts an entry carrying the same one (COR-1604).
  const resolverKey = `${workflowId}:${operation.operationId}`;
  if (
    sleepTimerFiredEarly(internals, timer, operation.operationId) &&
    internals.sleepResolvers.has(resolverKey)
  ) {
    resolveSleepTimer(internals, timer);
  }

  await promise;

  const postSleepState = await callbacks.loadWorkflowState(workflowId);
  if (postSleepState?.status === 'running') {
    callbacks.completeOperation(
      workflowId,
      undefined,
      operation.operationId,
      workflowExecutionToken,
    );
  }
}

function isPendingDelayedStart(state: WorkflowState | null): state is WorkflowState {
  return state !== null && state.status === 'pending';
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
  if (!isPendingDelayedStart(state)) {
    return;
  }

  const loadedCheckpoint = await loadDelayedWorkflowCheckpoint(internals, entry, callbacks);
  if (!loadedCheckpoint) {
    return;
  }
  const { checkpoint, serialized: serializedCheckpoint } = loadedCheckpoint;

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

  // From the fold to the launch the run is held and launching (COR-1625). The marker is handed to
  // the inline queue by the enqueue, settled once a worker has the run, and otherwise let go of.
  let handedOver = false;
  let launch: PendingLaunch | undefined;
  try {
    const committed = await callbacks.runSerializedWorkflowStateWrite(entry.workflowId, () =>
      commitDelayedStartRunning(internals, entry, callbacks, {
        now,
        executionDeadline,
        resolvedRevision,
      }),
    );
    if (!committed) {
      return;
    }
    const runningState = committed.state;
    launch = committed.launch;

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

    // The headers are read before the checkpoint is adopted: nothing awaits between adoption and the
    // launch completing, so an attempt is never observable adopted but not launched across an await.
    const startHeaders = await callbacks.loadWorkflowStartHeaders(entry.workflowId);
    // Prime the checkpoint compare-and-swap baseline from the bytes just loaded, so
    // this run's first commit is conditioned on them like start and resume.
    adoptLaunchCheckpoint(internals, entry.workflowId, checkpoint, serializedCheckpoint);
    internals.workflowVersionTuples.set(
      entry.workflowId,
      callbacks.workflowVersionTupleFromState(runningState),
    );
    callbacks.setWorkflowStartHeaders(entry.workflowId, startHeaders);
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
    handedOver = true;
    handOverPendingLaunch(internals, launch);
  } finally {
    if (!handedOver) await letGoOfPendingLaunch(internals, launch);
  }
}

async function loadDelayedWorkflowCheckpoint(
  internals: EngineInternals,
  entry: TimerEntry,
  callbacks: Pick<TimeOperationCallbacks, 'failWorkflow'>,
): Promise<{ checkpoint: Checkpoint; serialized: Uint8Array } | null> {
  const checkpointBytes = await internals.storage.get(KEYS.checkpoint(entry.workflowId));
  if (!checkpointBytes) {
    await callbacks.failWorkflow(
      entry.workflowId,
      new Error(`Checkpoint not found for delayed workflow "${entry.workflowId}"`),
    );
    return null;
  }

  return { checkpoint: deserializeCheckpoint(checkpointBytes), serialized: checkpointBytes };
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
): Promise<TimerFiredOutcome> {
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
    await callbacks.runWorkflowFinalizer(entry.workflowId, entry.id, entry.fireAt);
    return;
  }

  if (entry.kind === 'schedule') {
    return callbacks.handleScheduleTimer(entry);
  }

  if (entry.kind === 'sleep') {
    await handleSleepTimerWithAcknowledgement(internals, entry, callbacks.loadWorkflowState);
  } else if (entry.kind === 'wait-condition') {
    // No claim registry and no abandoned generation: unchanged sync fast path, no async hop.
    if (!wakeNeedsOwnershipCheck(internals, entry.workflowId)) {
      resolveConditionTimer(internals, entry);
    } else {
      await resolveConditionTimerConfirmingOwnership(internals, entry, callbacks.loadWorkflowState);
    }
  } else if (entry.kind === 'execution-deadline') {
    await fireExecutionDeadline(internals, entry, callbacks);
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
  if (decision === 'discard')
    await retainDiscardedDurableTimer(entry.id, entry.workflowId, loadWorkflowState);
}
async function handleReviewTimer(
  internals: EngineInternals,
  entry: TimerEntry,
  callbacks: Pick<TimeOperationCallbacks, 'loadWorkflowState'>,
): Promise<void> {
  const retained = retainTimerOfAbandonedGeneration(internals, entry, callbacks.loadWorkflowState);
  if (retained !== undefined) return retained;
  const reviewId = entry.id.split(':')[1];
  if (!reviewId) return;
  const handler = internals.reviewEscalationHandlers.get(reviewId);
  if (!handler) return;
  const state = await callbacks.loadWorkflowState(entry.workflowId);
  if (!state || state.status !== 'running') return;
  await handler(entry);
}
