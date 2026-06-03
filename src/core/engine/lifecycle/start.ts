import type { BatchOperation } from '../../../storage/interface.ts';
import { KEYS } from '../../../storage/interface.ts';
import { createCheckpoint } from '../../checkpoint.ts';
import { WorkflowStartedEvent } from '../../events.ts';
import { assertPayloadWithinLimit } from '../../payload-size.ts';
import { normalizeStorageTimestamp } from '../../scheduler.ts';
import {
  StartWorkflowValidationError,
  assertExclusiveStartWorkflowOptions,
  coerceStartWorkflowId,
  coerceStartWorkflowTimestamp,
  parseStartWorkflowDuration,
} from '../../start-workflow-validation.ts';
import type { Checkpoint, Duration, StartOptions, TimerEntry, WorkflowState } from '../../types.ts';
import { type WorkflowVersionTuple } from '../../workflow-version-tuple.ts';
import { forgetCommittedCheckpointBytes } from '../checkpoint-commit-snapshots.ts';
import { WorkflowAlreadyExistsError, WorkflowNotRegisteredError } from '../errors.ts';
import { type WorkflowHandle } from '../handles.ts';
import type { EngineInternals } from '../internals.ts';
import { createDelayedStartTimerEntry } from '../operations-time.ts';
import { selectPersistedWorkflowStartHeaders } from '../state-utilities.ts';
import { createWorkflowVersionTuple } from './persist.ts';
import {
  createWorkflowHandle,
  normalizeStartWorkflowTags,
  setWorkflowStartHeaders,
  type LifecycleCallbacks,
  type RegistrationEntry,
} from './shared.ts';
import { buildStartBatchOperations } from './start-batch.ts';
import { runWorkflowStartInterceptor, startWorkflowExecution } from './start-exec.ts';

export async function start(
  internals: EngineInternals,
  type: string,
  input: unknown,
  options: StartOptions | undefined,
  callbacks: LifecycleCallbacks,
): Promise<WorkflowHandle> {
  return startWorkflow(internals, type, input, options, undefined, callbacks);
}

type StartWorkflowPreparation = {
  workflowId: string;
  callerProvidedId: boolean;
  parentHeaders: Map<string, string> | undefined;
  executionStateOwnerId: string;
  submissionTime: number;
  delayedStartTimer: TimerEntry | undefined;
  normalizedTags: string[] | undefined;
};

function prepareStartWorkflow(
  internals: EngineInternals,
  options: StartOptions | undefined,
  callbacks: LifecycleCallbacks,
): StartWorkflowPreparation {
  const callerProvidedId = options?.id !== undefined;
  const workflowId =
    options?.id !== undefined
      ? coerceStartWorkflowId(options.id, 'options.id')
      : crypto.randomUUID();

  // Capture and clear pending parent headers immediately, before any async
  // work, to prevent a concurrent child-workflow start from overwriting them.
  const parentHeaders = internals.pendingParentHeaders;
  internals.pendingParentHeaders = undefined;
  const executionStateOwnerId = internals.pendingExecutionStateOwnerId ?? workflowId;
  internals.pendingExecutionStateOwnerId = undefined;
  const submissionTime = internals.options.getNow();
  const scheduledStartAt = resolveScheduledStartAt(internals, options, submissionTime, callbacks);
  const normalizedTags = normalizeStartWorkflowTags(internals, options?.tags, undefined, callbacks);
  const delayedStartTimer =
    scheduledStartAt !== undefined && scheduledStartAt > submissionTime
      ? createDelayedStartTimerEntry(internals, workflowId, scheduledStartAt, options, {
          parseStartOptionDuration: (value, fieldName) =>
            parseStartOptionDuration(internals, value, fieldName, callbacks),
        })
      : undefined;

  return {
    workflowId,
    callerProvidedId,
    parentHeaders,
    executionStateOwnerId,
    submissionTime,
    delayedStartTimer,
    normalizedTags,
  };
}

async function persistStartBatch(
  internals: EngineInternals,
  startOperations: BatchOperation[],
): Promise<void> {
  await internals.storage.batch(startOperations);
}

function rollbackTransientStartState(internals: EngineInternals, workflowId: string): void {
  forgetCommittedCheckpointBytes(internals, workflowId);
  internals.checkpoints.delete(workflowId);
  internals.workflowHeaders.delete(workflowId);
  internals.workflowVersionTuples.delete(workflowId);
  internals.workflowServices.delete(workflowId);
}

/**
 * `services` is a non-serializable per-run value read inline as `ctx.services`.
 * It cannot cross to a Worker, so reject it early under worker execution mode
 * rather than stranding a persisted run that can never read its services.
 */
function assertServicesSupportedForMode(
  internals: EngineInternals,
  options: StartOptions | undefined,
): void {
  if (options?.services !== undefined && internals.inlineStrategy === null) {
    throw new Error(
      'options.services is only supported in inline execution mode; it cannot be ' +
        'serialized to a Worker. Remove services or use workflowExecutionMode: "inline".',
    );
  }
}

export async function startWorkflow(
  internals: EngineInternals,
  type: string,
  input: unknown,
  options: StartOptions | undefined,
  additionalStartOperations: BatchOperation[] | undefined,
  callbacks: LifecycleCallbacks,
): Promise<WorkflowHandle> {
  const registration = internals.registrations.get(type);
  if (!registration) {
    throw new WorkflowNotRegisteredError(type);
  }

  assertServicesSupportedForMode(internals, options);

  const preparation = prepareStartWorkflow(internals, options, callbacks);
  const { workflowId, callerProvidedId, parentHeaders, executionStateOwnerId, delayedStartTimer } =
    preparation;

  // Atomic check-and-reserve: prevent two concurrent start() calls with the
  // same ID from both passing the storage check before either writes state.
  if (internals.pendingStarts.has(workflowId)) {
    throw new WorkflowAlreadyExistsError(workflowId);
  }
  internals.pendingStarts.add(workflowId);
  let startSucceeded = false;

  try {
    // Only hit storage to dedup when the caller supplied the id. A
    // freshly-generated v4 UUID is (for all practical purposes) unique, so
    // the extra round trip is wasted work on the hot start path. This is
    // the dominant optimization behind the workflow-start benchmark — the
    // get → batch sequence was two storage calls per start, now one.
    if (callerProvidedId) {
      const existingBytes = await internals.storage.get(KEYS.workflow(workflowId));
      if (existingBytes !== null) {
        throw new WorkflowAlreadyExistsError(workflowId);
      }
    }

    // Reject oversized input before any durable write, but after the
    // duplicate-id checks above so a retried known id still reports
    // WorkflowAlreadyExistsError rather than a payload-size error.
    assertPayloadWithinLimit(input, internals.options.payloadSizePolicy.maxBytes, 'workflow input');

    const versionTuple = createWorkflowVersionTuple(internals, registration, callbacks);

    const state = createInitialWorkflowState(
      internals,
      workflowId,
      type,
      input,
      versionTuple,
      options,
      preparation.normalizedTags,
      executionStateOwnerId,
      delayedStartTimer,
      callbacks,
    );
    const checkpoint = createInitialCheckpoint(
      internals,
      workflowId,
      versionTuple.workflowVersion,
      options,
      callbacks,
    );
    const workflowStartHeaders = runWorkflowStartInterceptor(
      internals,
      workflowId,
      type,
      input,
      parentHeaders,
      callbacks,
    );
    const persistedWorkflowStartHeaders = selectPersistedWorkflowStartHeaders(workflowStartHeaders);
    internals.checkpoints.set(workflowId, checkpoint);
    setWorkflowStartHeaders(internals, workflowId, workflowStartHeaders, callbacks);

    // Cache the workflow version tuple for forwarding to event-log entries.
    internals.workflowVersionTuples.set(workflowId, versionTuple);

    const startOperations = buildStartBatchOperations(
      internals,
      workflowId,
      state,
      checkpoint,
      registration,
      options,
      state.executionDeadline,
      delayedStartTimer,
      persistedWorkflowStartHeaders,
      additionalStartOperations,
      callbacks,
    );

    await persistStartBatch(internals, startOperations);

    // Hold the non-serialized per-run services in engine memory so the inline
    // Context can read them. The services value is never written to storage — it
    // bypasses every durable record. A presence-only "expects services" marker IS
    // written atomically in the start batch (see buildStartBatchOperations) so a
    // fresh-process recovery knows to re-provide them. Cleared on terminal cleanup
    // (and on rollback below).
    if (options?.services !== undefined) {
      internals.workflowServices.set(workflowId, options.services);
    }

    const handle = createWorkflowHandle(internals, workflowId, callbacks);
    if (!delayedStartTimer) {
      beginWorkflowExecution(
        internals,
        workflowId,
        type,
        input,
        checkpoint,
        state.executionDeadline,
        state.executionStateOwnerId ?? workflowId,
        registration,
        callbacks,
      );
    }
    startSucceeded = true;
    return handle;
  } finally {
    internals.pendingStarts.delete(workflowId);
    if (!startSucceeded) {
      rollbackTransientStartState(internals, workflowId);
    }
  }
}

export function resolveScheduledStartAt(
  internals: EngineInternals,
  options: StartOptions | undefined,
  submissionTime: number,
  callbacks: LifecycleCallbacks,
): number | undefined {
  assertExclusiveStartWorkflowOptions(options?.startAt, options?.startAfter);

  if (options?.startAt !== undefined) {
    return coerceStartWorkflowTimestamp(options.startAt, 'options.startAt');
  }

  if (options?.startAfter !== undefined) {
    const startAfterMilliseconds = parseStartOptionDuration(
      internals,
      options.startAfter,
      'options.startAfter',
      callbacks,
    );
    try {
      return normalizeStorageTimestamp(
        submissionTime + startAfterMilliseconds,
        'options.startAfter',
      );
    } catch {
      throw new StartWorkflowValidationError(
        'options.startAfter must resolve to a finite, non-negative start time',
      );
    }
  }

  return undefined;
}

export function parseStartOptionDuration(
  _internals: EngineInternals,
  duration: Duration,
  fieldName: 'options.executionTimeout' | 'options.startAfter',
  _callbacks: LifecycleCallbacks,
): number {
  return parseStartWorkflowDuration(duration, fieldName);
}

export function beginWorkflowExecution(
  internals: EngineInternals,
  workflowId: string,
  workflowType: string,
  input: unknown,
  checkpoint: Checkpoint,
  executionDeadline: number | undefined,
  executionStateOwnerId: string,
  _registration: RegistrationEntry,
  callbacks: LifecycleCallbacks,
): void {
  const nestingDepth = internals.pendingNestingDepth ?? 0;
  internals.pendingNestingDepth = undefined;

  if (internals.inlineStrategy !== null) {
    callbacks.queueInlineWorkflowExecutionStart({
      workflowId,
      workflowType,
      input,
      checkpoint,
      nestingDepth,
      executionDeadline,
      executionStateOwnerId,
    });
    return;
  }

  callbacks.dispatchEvent(new WorkflowStartedEvent(workflowId, workflowType, input));
  startWorkflowExecution(
    internals,
    workflowId,
    workflowType,
    input,
    checkpoint,
    nestingDepth,
    executionDeadline,
    executionStateOwnerId,
    callbacks,
  );
}

function buildInitialIdentitySlice(
  workflowId: string,
  type: string,
  input: unknown,
  versionTuple: WorkflowVersionTuple,
  executionStateOwnerId: string,
  delayedStartTimer: TimerEntry | undefined,
  now: number,
  tags: string[] | undefined,
): WorkflowState {
  return {
    id: workflowId,
    type,
    status: delayedStartTimer ? 'pending' : 'running',
    input,
    version: versionTuple.workflowVersion,
    executionStateOwnerId,
    createdAt: now,
    ...(!delayedStartTimer && { startedAt: now }),
    updatedAt: now,
    ...(tags !== undefined && { tags }),
    ...(versionTuple.agentVersion !== undefined && {
      agentVersion: versionTuple.agentVersion,
    }),
    ...(versionTuple.toolVersions !== undefined && {
      toolVersions: versionTuple.toolVersions,
    }),
  };
}

function resolveInitialExecutionDeadline(
  internals: EngineInternals,
  options: StartOptions | undefined,
  delayedStartTimer: TimerEntry | undefined,
  now: number,
  callbacks: LifecycleCallbacks,
): number | undefined {
  if (options?.executionTimeout === undefined || delayedStartTimer) {
    return undefined;
  }
  const executionTimeoutMilliseconds = parseStartOptionDuration(
    internals,
    options.executionTimeout,
    'options.executionTimeout',
    callbacks,
  );
  try {
    return normalizeStorageTimestamp(
      now + executionTimeoutMilliseconds,
      'options.executionTimeout',
    );
  } catch {
    throw new StartWorkflowValidationError(
      'options.executionTimeout must resolve to a finite, non-negative deadline',
    );
  }
}

export function createInitialWorkflowState(
  internals: EngineInternals,
  workflowId: string,
  type: string,
  input: unknown,
  versionTuple: WorkflowVersionTuple,
  options: StartOptions | undefined,
  tags: string[] | undefined,
  executionStateOwnerId: string,
  delayedStartTimer: TimerEntry | undefined,
  callbacks: LifecycleCallbacks,
): WorkflowState {
  const now = internals.options.getNow();
  const state = buildInitialIdentitySlice(
    workflowId,
    type,
    input,
    versionTuple,
    executionStateOwnerId,
    delayedStartTimer,
    now,
    tags,
  );

  const executionDeadline = resolveInitialExecutionDeadline(
    internals,
    options,
    delayedStartTimer,
    now,
    callbacks,
  );
  if (executionDeadline !== undefined) {
    state.executionDeadline = executionDeadline;
  }

  return state;
}

export function createInitialCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  workflowVersion: string,
  options: StartOptions | undefined,
  _callbacks: LifecycleCallbacks,
): Checkpoint {
  const checkpoint = createCheckpoint(workflowId, workflowVersion, internals.options.getNow());
  if (options?.searchAttributes) {
    checkpoint.searchAttributes = { ...options.searchAttributes };
  }
  return checkpoint;
}
