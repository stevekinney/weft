/**
 * Build the initial in-memory {@link WorkflowState} and {@link Checkpoint}
 * for a fresh `start()` — split out of `start.ts`, which has no headroom
 * under the repository's 500-line implementation-file ceiling for this
 * logic inline.
 *
 * @module core/engine/lifecycle/start-state
 */

import { inheritWorkflowWorkerBinding } from '../../../worker/binding-helpers.ts';
import type { WorkflowWorkerBinding } from '../../../worker/versioning-policy.ts';
import { resolveWorkflowWorkerStartBinding } from '../../../worker/versioning-policy.ts';
import { createCheckpoint } from '../../checkpoint.ts';
import { normalizeStorageTimestamp } from '../../scheduler.ts';
import {
  StartWorkflowValidationError,
  parseStartWorkflowDuration,
} from '../../start-workflow-validation.ts';
import type { Checkpoint, Duration, StartOptions, TimerEntry, WorkflowState } from '../../types.ts';
import { type WorkflowVersionTuple } from '../../workflow-version-tuple.ts';
import type { EngineInternals } from '../internals.ts';
import { type LifecycleCallbacks, type RegistrationEntry } from './shared.ts';

export function parseStartOptionDuration(
  _internals: EngineInternals,
  duration: Duration,
  fieldName: 'options.executionTimeout' | 'options.startAfter',
  _callbacks: LifecycleCallbacks,
): number {
  return parseStartWorkflowDuration(duration, fieldName);
}

export async function resolveStartWorkerBinding(
  internals: EngineInternals,
  registration: RegistrationEntry,
  workflowId: string,
  type: string,
  revision: string,
): Promise<WorkflowWorkerBinding | undefined> {
  if (registration.workerVersioningPolicy === undefined) return undefined;
  return resolveWorkflowWorkerStartBinding(internals.storage, {
    workflowId,
    workflowType: type,
    workflowRevision: revision,
    policy: registration.workerVersioningPolicy,
    boundAt: internals.options.getNow(),
    checkpointId: workflowId,
  });
}

function shouldInheritParentWorkerBinding(
  parentWorkerBinding: WorkflowWorkerBinding | undefined,
  type: string,
  revision: string,
  options: StartOptions | undefined,
): parentWorkerBinding is WorkflowWorkerBinding {
  return (
    parentWorkerBinding !== undefined &&
    options?.workerStartOverridePreview === undefined &&
    parentWorkerBinding.workflowType === type &&
    parentWorkerBinding.workflowRevision === revision
  );
}

export async function resolveInitialWorkerBinding(
  internals: EngineInternals,
  registration: RegistrationEntry,
  workflowId: string,
  type: string,
  revision: string,
  options: StartOptions | undefined,
  terminalRunToPurge: WorkflowState | null,
  parentWorkerBinding: WorkflowWorkerBinding | undefined,
  submissionTime: number,
): Promise<WorkflowWorkerBinding | undefined> {
  if (registration.workerVersioningPolicy === undefined) return undefined;
  if (
    terminalRunToPurge?.workerBinding !== undefined &&
    options?.workerStartOverridePreview === undefined
  ) {
    return inheritWorkflowWorkerBinding(terminalRunToPurge.workerBinding.current, {
      workflowId,
      boundAt: submissionTime,
      checkpointId: workflowId,
    });
  }
  if (shouldInheritParentWorkerBinding(parentWorkerBinding, type, revision, options)) {
    return inheritWorkflowWorkerBinding(parentWorkerBinding, {
      workflowId,
      boundAt: submissionTime,
      checkpointId: workflowId,
    });
  }
  return resolveStartWorkerBinding(internals, registration, workflowId, type, revision);
}

function buildInitialIdentitySlice(
  workflowId: string,
  type: string,
  input: unknown,
  versionTuple: WorkflowVersionTuple,
  revision: string,
  executionStateOwnerId: string | undefined,
  parentWorkflowId: string | undefined,
  parentWorkflowExecutionToken: string | undefined,
  delayedStartTimer: TimerEntry | undefined,
  now: number,
  tags: string[] | undefined,
  /**
   * COR-75: `engine.prepare()` wants the exact same `'pending'`, no-`startedAt`
   * shape a delayed start's create batch produces — WITHOUT a
   * `delayedStartTimer`, so the create batch still folds claim acquisition
   * (unlike an actual `startAt`/`startAfter` start, whose create batch
   * intentionally skips it — see `start-commit.ts`) and writes no durable
   * timer. Independent of `delayedStartTimer` for exactly that reason.
   */
  forcePendingWithoutTimer: boolean | undefined,
): WorkflowState {
  const isPending = delayedStartTimer !== undefined || forcePendingWithoutTimer === true;
  return {
    id: workflowId,
    type,
    status: isPending ? 'pending' : 'running',
    input,
    versionTuple,
    revision,
    workflowExecutionToken: crypto.randomUUID(),
    ...(executionStateOwnerId !== undefined && { executionStateOwnerId }),
    ...(parentWorkflowId !== undefined && { parentWorkflowId }),
    ...(parentWorkflowExecutionToken !== undefined && { parentWorkflowExecutionToken }),
    createdAt: now,
    ...(!isPending && { startedAt: now }),
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
  revision: string,
  options: StartOptions | undefined,
  tags: string[] | undefined,
  executionStateOwnerId: string | undefined,
  parentWorkflowId: string | undefined,
  parentWorkflowExecutionToken: string | undefined,
  delayedStartTimer: TimerEntry | undefined,
  callbacks: LifecycleCallbacks,
  /** See {@link buildInitialIdentitySlice}'s parameter of the same name (COR-75). */
  forcePendingWithoutTimer?: boolean,
  registration?: RegistrationEntry,
  workerBinding?: WorkflowWorkerBinding,
): WorkflowState {
  const now = internals.options.getNow();
  const state = buildInitialIdentitySlice(
    workflowId,
    type,
    input,
    versionTuple,
    revision,
    executionStateOwnerId,
    parentWorkflowId,
    parentWorkflowExecutionToken,
    delayedStartTimer,
    now,
    tags,
    forcePendingWithoutTimer,
  );

  // A prepared-but-unlaunched workflow defers execution-deadline computation
  // to `launch()`, exactly like a delayed start defers it to its timer fire
  // (`resolveDelayedExecutionDeadline` in `operations-time.ts`) — the
  // deadline should count from when execution actually begins, not from
  // `prepare()` time.
  const executionDeadline = forcePendingWithoutTimer
    ? undefined
    : resolveInitialExecutionDeadline(internals, options, delayedStartTimer, now, callbacks);
  if (executionDeadline !== undefined) {
    state.executionDeadline = executionDeadline;
  }

  if (registration?.workerVersioningPolicy !== undefined) {
    state.workerVersioningPolicy = registration.workerVersioningPolicy;
    if (workerBinding === undefined) {
      throw new Error('Accepted worker deployment binding is required for versioned workflows.');
    }
    state.workerBinding = { current: workerBinding, history: [] };
  }

  return state;
}

export function createInitialCheckpoint(
  internals: EngineInternals,
  workflowId: string,
  workflowVersion: string,
  options: StartOptions | undefined,
  workflowExecutionToken: string | undefined,
  _callbacks: LifecycleCallbacks,
): Checkpoint {
  const checkpoint = createCheckpoint(
    workflowId,
    workflowVersion,
    internals.options.getNow(),
    workflowExecutionToken,
  );
  if (options?.searchAttributes) {
    checkpoint.searchAttributes = { ...options.searchAttributes };
  }
  return checkpoint;
}

export function applyRestartLineage(
  state: WorkflowState,
  displacedState: WorkflowState | null,
): void {
  if (displacedState === null) return;
  state.restartedFrom = {
    workflowId: displacedState.id,
    ...(displacedState.workflowExecutionToken !== undefined && {
      workflowExecutionToken: displacedState.workflowExecutionToken,
    }),
    replacedAt: state.createdAt,
  };
}
