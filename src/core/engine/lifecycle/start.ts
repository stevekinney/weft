import type { BatchOperation } from '../../../storage/interface.ts';
import { createCheckpoint } from '../../checkpoint.ts';
import { assertPayloadWithinLimit } from '../../payload-size.ts';
import { normalizeStorageTimestamp } from '../../scheduler.ts';
import {
  StartWorkflowValidationError,
  assertExclusiveStartWorkflowOptions,
  assertValidOnTerminalConflict,
  coerceStartWorkflowId,
  coerceStartWorkflowTimestamp,
  parseStartWorkflowDuration,
} from '../../start-workflow-validation.ts';
import type {
  Checkpoint,
  Duration,
  StartOptions,
  StartWorkflowOptions,
  TimerEntry,
  WorkflowState,
} from '../../types.ts';
import { type WorkflowVersionTuple } from '../../workflow-version-tuple.ts';
import { forgetCommittedCheckpointBytes } from '../checkpoint-commit-snapshots.ts';
import { WorkflowAlreadyExistsError, WorkflowNotRegisteredError } from '../errors.ts';
import { type WorkflowHandle } from '../handles.ts';
import type { EngineInternals } from '../internals.ts';
import { createDelayedStartTimerEntry } from '../operations-time.ts';
import { selectPersistedWorkflowStartHeaders } from '../state-utilities.ts';
import { buildWorkflowConcurrencyStartOperations } from '../workflow-concurrency.ts';
import { createWorkflowVersionTuple } from './persist.ts';
import {
  createWorkflowHandle,
  normalizeStartWorkflowTags,
  setWorkflowStartHeaders,
  type LifecycleCallbacks,
} from './shared.ts';
import { buildAndCommitStartBatch, type BuildIdempotentStartOperations } from './start-commit.ts';
import {
  assertDeferSupported,
  beginExecutionAwaitingLiveness,
  runWorkflowStartInterceptor,
} from './start-exec.ts';
import {
  prepareTerminalRunPurge,
  resolveTerminalConflictForRestart,
} from './start-terminal-conflict-purge.ts';

export async function start(
  internals: EngineInternals,
  type: string,
  input: unknown,
  options: StartWorkflowOptions | undefined,
  callbacks: LifecycleCallbacks,
): Promise<WorkflowHandle> {
  return startWorkflow(internals, type, input, options, undefined, callbacks);
}

type StartWorkflowPreparation = {
  workflowId: string;
  callerProvidedId: boolean;
  parentHeaders: Map<string, string> | undefined;
  executionStateOwnerId: string | undefined;
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
  const pendingExecutionStateOwnerId = internals.pendingExecutionStateOwnerId;
  const executionStateOwnerId =
    pendingExecutionStateOwnerId === null
      ? undefined
      : (pendingExecutionStateOwnerId ?? workflowId);
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

function rollbackTransientStartState(internals: EngineInternals, workflowId: string): void {
  forgetCommittedCheckpointBytes(internals, workflowId);
  internals.checkpoints.delete(workflowId);
  internals.workflowHeaders.delete(workflowId);
  internals.workflowVersionTuples.delete(workflowId);
  internals.workflowServices.delete(workflowId);
  internals.workflowsNeedingTerminalCleanup.delete(workflowId);
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
  options: StartWorkflowOptions | undefined,
  additionalStartOperations: BatchOperation[] | undefined,
  callbacks: LifecycleCallbacks,
  buildIdempotentStartOperations?: BuildIdempotentStartOperations,
): Promise<WorkflowHandle> {
  const registration = internals.registrations.get(type);
  if (!registration) {
    throw new WorkflowNotRegisteredError(type);
  }
  const workflowConcurrency = registration.concurrency;

  assertServicesSupportedForMode(internals, options);
  assertValidOnTerminalConflict(options);

  const preparation = prepareStartWorkflow(internals, options, callbacks);
  const { workflowId, callerProvidedId, parentHeaders, executionStateOwnerId, delayedStartTimer } =
    preparation;

  assertDeferSupported(internals, options, Boolean(delayedStartTimer));

  // Atomic check-and-reserve: prevent two concurrent start() calls with the
  // same ID from both passing the storage check before either writes state.
  if (internals.pendingStarts.has(workflowId)) {
    throw new WorkflowAlreadyExistsError(workflowId);
  }
  internals.pendingStarts.add(workflowId);
  let startSucceeded = false;

  try {
    // Only caller-supplied ids can collide; a generated UUID skips the read.
    // Decide the duplicate-id outcome up front (throws for a non-terminal or
    // default-policy collision), but DEFER any destructive purge until just
    // before the create commit below — so a `'start-new'` restart rejected by
    // later validation leaves the prior terminal run intact. The `pendingStarts`
    // reservation is held across the whole decide → build → purge → create
    // window, so a concurrent same-id start cannot race into the gap.
    const terminalRunToPurge = callerProvidedId
      ? await resolveTerminalConflictForRestart(internals, workflowId, options)
      : null;

    // Reject oversized input before any durable write (and before the purge).
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

    // Last possible moment before the create commit, and after every throwing
    // build step above (version tuple, state/deadline, checkpoint, start
    // interceptor). Preparing here means a `'start-new'` restart rejected by any of
    // those leaves the prior terminal run intact. This clears the OLD run's
    // in-memory caches BEFORE the new run's maps are written below (so the clear
    // can't wipe fresh entries) but does NOT commit the destructive storage
    // delete — that is folded into the atomic create batch below as
    // `purgeDeleteOperations`, so purge-and-recreate either both happen or neither
    // does. A create-batch failure can no longer strand the id with no record.
    const purgeDeleteOperations =
      terminalRunToPurge !== null
        ? await prepareTerminalRunPurge(internals, terminalRunToPurge, callbacks)
        : undefined;

    internals.checkpoints.set(workflowId, checkpoint);
    setWorkflowStartHeaders(internals, workflowId, workflowStartHeaders, callbacks);

    // Cache the workflow version tuple for forwarding to event-log entries.
    internals.workflowVersionTuples.set(workflowId, versionTuple);

    // Build the create batch (folding in the id-dependent idempotency mapping /
    // signal, and prepending any restart purge deletes) and commit it, gated on
    // any idempotency preconditions. Throws StartIdempotencyRaceLostError when a
    // concurrent same-key caller won the CAS, which the `finally` rollback below
    // unwinds for the wrapper to handle.
    await buildAndCommitStartBatch(
      {
        internals,
        workflowId,
        state,
        checkpoint,
        registration,
        options,
        delayedStartTimer,
        persistedWorkflowStartHeaders,
        additionalStartOperations,
        buildWorkflowConcurrencyStartOperations:
          workflowConcurrency === undefined
            ? undefined
            : () =>
                buildWorkflowConcurrencyStartOperations(
                  internals,
                  type,
                  workflowId,
                  input,
                  workflowConcurrency,
                ),
        callbacks,
        purgeDeleteOperations,
      },
      buildIdempotentStartOperations,
    );

    // Hold the non-serialized per-run services in engine memory so the inline
    // Context can read them. The services value is never written to storage — it
    // bypasses every durable record. A presence-only "expects services" marker IS
    // written atomically in the start batch (see buildStartBatchOperations) so a
    // fresh-process recovery knows to re-provide them. Cleared on terminal cleanup
    // (and on rollback below).
    //
    // Joining `workflowsNeedingTerminalCleanup` mirrors `setWorkflowStartHeaders`:
    // it is what makes `completeWorkflow` schedule the deferred durable cleanup
    // that sweeps the marker. The start batch wrote the matching
    // `terminalCleanupNeeded` key so recovery re-derives this membership.
    if (options?.services !== undefined) {
      internals.workflowServices.set(workflowId, options.services);
      internals.workflowsNeedingTerminalCleanup.add(workflowId);
    }
    if (workflowConcurrency !== undefined) {
      internals.workflowsNeedingTerminalCleanup.add(workflowId);
    }

    const handle = createWorkflowHandle(internals, workflowId, callbacks);
    await beginExecutionAwaitingLiveness(
      internals,
      {
        type,
        input,
        checkpoint,
        state,
        registration,
        options,
        isDelayed: Boolean(delayedStartTimer),
      },
      workflowId,
      callbacks,
    );
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

function buildInitialIdentitySlice(
  workflowId: string,
  type: string,
  input: unknown,
  versionTuple: WorkflowVersionTuple,
  executionStateOwnerId: string | undefined,
  delayedStartTimer: TimerEntry | undefined,
  now: number,
  tags: string[] | undefined,
): WorkflowState {
  return {
    id: workflowId,
    type,
    status: delayedStartTimer ? 'pending' : 'running',
    input,
    versionTuple,
    workflowExecutionToken: crypto.randomUUID(),
    ...(executionStateOwnerId !== undefined && { executionStateOwnerId }),
    createdAt: now,
    ...(!delayedStartTimer && { startedAt: now }),
    updatedAt: now,
    ...(tags !== undefined && { tags }),
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
  executionStateOwnerId: string | undefined,
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
