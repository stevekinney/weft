import type { BatchOperation } from '../../storage/interface.ts';
import { KEYS, storageHas } from '../../storage/interface.ts';
import { deserializeCheckpoint } from '../checkpoint.ts';
import { encode } from '../codec.ts';
import type { ContextOperationRequest } from '../context.ts';
import { buildTimerBatchOperations, normalizeStorageTimestamp } from '../scheduler.ts';
import type { Checkpoint, Duration, StartOptions, TimerEntry, WorkflowState } from '../types.ts';
import type { WorkflowVersionTuple } from '../workflow-version-tuple.ts';
import type { EngineInternals } from './internals.ts';
import { reprovideRecoveredServices } from './lifecycle/recovered-services.ts';
import { buildWorkflowVisibilityIndexTransition } from './workflow-indexes.ts';

type RegistrationEntry =
  EngineInternals['registrations'] extends Map<string, infer Entry> ? Entry : never;

type SleepOperation = Extract<ContextOperationRequest, { type: 'sleep' }>;

export type TimeOperationCallbacks = {
  completeOperation: (workflowId: string, value: unknown) => void;
  loadWorkflowState: (workflowId: string) => Promise<WorkflowState | null>;
  failWorkflow: (workflowId: string, error: Error) => Promise<void>;
  runSerializedWorkflowStateWrite: <Result>(
    workflowId: string,
    writeOperation: () => Promise<Result>,
  ) => Promise<Result>;
  beginWorkflowExecution: (
    workflowId: string,
    workflowType: string,
    input: unknown,
    checkpoint: Checkpoint,
    executionDeadline: number | undefined,
    executionStateOwnerId: string,
    registration: RegistrationEntry,
  ) => void;
  workflowVersionTupleFromState: (state: WorkflowState) => WorkflowVersionTuple;
  setWorkflowStartHeaders: (workflowId: string, headers: Map<string, string> | undefined) => void;
  loadWorkflowStartHeaders: (workflowId: string) => Promise<Map<string, string> | undefined>;
  parseStartOptionDuration: (
    value: Duration,
    fieldName: 'options.executionTimeout' | 'options.startAfter',
  ) => number;
  runDeferredTerminalCleanup: (workflowId: string, timerId: string) => Promise<void>;
  handleScheduleTimer: (entry: TimerEntry) => Promise<void>;
  timeout: (workflowId: string) => Promise<void>;
  handleCleanupError: (source: string, error: unknown, workflowId: string) => void;
};

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
  registerSleepResolver(internals, workflowId, operation.operationId, resolve);
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
): void {
  internals.sleepResolvers.set(`${workflowId}:${operationId}`, resolve);

  let workflowOperations = internals.sleepResolversByWorkflow.get(workflowId);
  if (!workflowOperations) {
    workflowOperations = new Set();
    internals.sleepResolversByWorkflow.set(workflowId, workflowOperations);
  }
  workflowOperations.add(operationId);
}

export async function startDelayedWorkflow(
  internals: EngineInternals,
  entry: TimerEntry,
  callbacks: Pick<
    TimeOperationCallbacks,
    | 'beginWorkflowExecution'
    | 'failWorkflow'
    | 'handleCleanupError'
    | 'loadWorkflowStartHeaders'
    | 'loadWorkflowState'
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

  const registration = internals.registrations.get(state.type);
  if (!registration) {
    await callbacks.failWorkflow(
      entry.workflowId,
      new Error(`No workflow registered with name "${state.type}"`),
    );
    return;
  }

  const now = internals.options.getNow();
  const executionDeadline = await resolveDelayedExecutionDeadline(entry, now, callbacks);
  if (executionDeadline === 'invalid') return;

  const runningState = await callbacks.runSerializedWorkflowStateWrite(
    entry.workflowId,
    async () => {
      const latestState = await callbacks.loadWorkflowState(entry.workflowId);
      if (!latestState || latestState.status !== 'pending') {
        return null;
      }

      const nextRunningState: WorkflowState = {
        ...latestState,
        status: 'running',
        startedAt: now,
        updatedAt: now,
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

      await internals.storage.batch(operations);
      return nextRunningState;
    },
  );
  if (!runningState) {
    return;
  }

  // A delayed-start workflow that crashed `pending` before its timer fired
  // loses its in-memory services on recovery (the timer fires in a fresh
  // process). Re-provide them before execution begins, exactly as the
  // running-workflow resume path does — and fail the run if unavailable rather
  // than silently executing with `ctx.services === undefined`.
  const servicesUnavailable = await reprovideRecoveredServices(
    internals,
    runningState,
    (workflowId, error) => callbacks.failWorkflow(workflowId, error),
    callbacks.handleCleanupError,
  );
  if (servicesUnavailable) {
    return;
  }

  // Re-derive terminal-cleanup tracking from the durable marker, exactly as the
  // running-workflow resume path does (loadTerminalCleanupTrackedState). On a
  // fresh process the in-memory workflowsNeedingTerminalCleanup set is empty, so
  // without this a recovered services-only run (no start headers, which would
  // otherwise re-add it) would complete without scheduling the deferred durable
  // sweep — leaking its wf-has-services marker and other per-run scratch.
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
    runningState.type,
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
  entry: TimerEntry,
  now: number,
  callbacks: Pick<TimeOperationCallbacks, 'failWorkflow'>,
): Promise<number | undefined | 'invalid'> {
  if (entry.executionTimeoutMs === undefined) {
    return undefined;
  }

  if (!Number.isFinite(entry.executionTimeoutMs) || entry.executionTimeoutMs < 0) {
    await failInvalidDelayedExecutionTimeout(entry, callbacks);
    return 'invalid';
  }

  try {
    return normalizeStorageTimestamp(
      now + entry.executionTimeoutMs,
      `Delayed execution timeout for workflow "${entry.workflowId}"`,
    );
  } catch {
    await failInvalidDelayedExecutionTimeout(entry, callbacks);
    return 'invalid';
  }
}

async function failInvalidDelayedExecutionTimeout(
  entry: TimerEntry,
  callbacks: Pick<TimeOperationCallbacks, 'failWorkflow'>,
): Promise<void> {
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
    | 'runSerializedWorkflowStateWrite'
    | 'handleScheduleTimer'
    | 'setWorkflowStartHeaders'
    | 'timeout'
    | 'beginWorkflowExecution'
    | 'workflowVersionTupleFromState'
  >,
): Promise<void> {
  if (entry.id.startsWith('review-escalation:') || entry.id.startsWith('review-timeout:')) {
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

  if (entry.kind === 'schedule') {
    await callbacks.handleScheduleTimer(entry);
    return;
  }

  if (entry.kind === 'sleep') {
    resolveSleepTimer(internals, entry);
  } else if (entry.kind === 'execution-deadline') {
    await callbacks.timeout(entry.workflowId);
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

function resolveSleepTimer(internals: EngineInternals, entry: TimerEntry): void {
  const operationId = entry.id.replace('sleep:', '');
  const resolverKey = `${entry.workflowId}:${operationId}`;
  const resolver = internals.sleepResolvers.get(resolverKey);
  if (!resolver) return;

  internals.sleepResolvers.delete(resolverKey);
  untrackSleepResolver(internals, entry.workflowId, operationId);
  resolver();
}

function untrackSleepResolver(
  internals: EngineInternals,
  workflowId: string,
  operationId: string,
): void {
  const workflowOperations = internals.sleepResolversByWorkflow.get(workflowId);
  if (!workflowOperations) return;

  workflowOperations.delete(operationId);
  if (workflowOperations.size === 0) internals.sleepResolversByWorkflow.delete(workflowId);
}
