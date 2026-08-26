import {
  KEYS,
  type BatchOperation,
  type ConditionalBatchCondition,
} from '../../storage/interface.ts';
import { encode } from '../codec.ts';
import { buildTimerBatchOperations } from '../scheduler.ts';
import { WorkflowTimeoutError } from '../timeouts.ts';
import type { ScheduleState, WorkflowState } from '../types.ts';
import {
  clearPendingAtomicWorkflowCommitSideEffects,
  takePendingAtomicWorkflowCommitSideEffects,
} from './checkpoint-side-effects.ts';
import { commitFencedEngineWrite } from './fenced-write.ts';
import { getWorkflowExecutionStartedAt } from './handles.ts';
import type { EngineInternals } from './internals.ts';
import { resolveEffectiveScheduleFireAt } from './schedule-jitter.ts';
import { createScheduleTimerId, decodeWorkflowStartHeaders } from './state-utilities.ts';
import { decodeWorkflowState } from './validation.ts';
import { decodeScheduleState } from './validation/schedule.ts';
import {
  buildWorkflowClaimExternalTerminalRotationTransition,
  type WorkflowClaimTransitionFragment,
} from './workflow-claim-transitions.ts';

/** Run a workflow-state write after any earlier write for that workflow has settled. */
export async function runSerializedWorkflowStateWrite<TResult>(
  internals: EngineInternals,
  workflowId: string,
  writeOperation: () => Promise<TResult>,
): Promise<TResult> {
  const previousWrite = internals.workflowStateWriteChains.get(workflowId) ?? Promise.resolve();
  const execution = previousWrite.catch(() => undefined).then(writeOperation);
  const settledExecution = execution.then(
    () => undefined,
    () => undefined,
  );

  internals.workflowStateWriteChains.set(workflowId, settledExecution);

  try {
    return await execution;
  } finally {
    if (internals.workflowStateWriteChains.get(workflowId) === settledExecution) {
      internals.workflowStateWriteChains.delete(workflowId);
    }
  }
}

/**
 * Serialize a schedule read-modify-write operation with its timer callback.
 *
 * Unlike workflow-state write serialization, a failed predecessor is propagated
 * to callers that were already queued behind it. In particular, an update that
 * arrives while a scanned timer callback is rearming must not delete the fired
 * timer after that callback fails; rejecting the queued update leaves the durable
 * timer available for the scheduler (or a lease successor) to retry.
 */
export async function runSerializedScheduleStateOperation<TResult>(
  internals: EngineInternals,
  scheduleId: string,
  operation: () => Promise<TResult>,
): Promise<TResult> {
  const previousOperation =
    internals.scheduleStateOperationChains.get(scheduleId) ?? Promise.resolve();
  const execution = previousOperation.then(operation);
  const trackedExecution = execution.then(() => undefined);
  // Keep the rejected state available to an already-queued successor while
  // marking this bookkeeping promise handled when there is no successor.
  void trackedExecution.catch(() => undefined);

  internals.scheduleStateOperationChains.set(scheduleId, trackedExecution);

  try {
    return await execution;
  } finally {
    if (internals.scheduleStateOperationChains.get(scheduleId) === trackedExecution) {
      internals.scheduleStateOperationChains.delete(scheduleId);
    }
  }
}

/** Load and decode persisted workflow state by workflow ID. */
export async function loadWorkflowState(
  internals: EngineInternals,
  workflowId: string,
): Promise<WorkflowState | null> {
  const bytes = await internals.storage.get(KEYS.workflow(workflowId));
  if (!bytes) return null;
  return decodeWorkflowState(bytes);
}

/**
 * Derive a terminal result (or throw the persisted terminal error) from an
 * ALREADY-LOADED `WorkflowState` — pure, no storage read. Callers that hold a
 * state snapshot they have already validated as terminal (e.g.
 * `bootstrapWorkflowResultResolver`) must use this instead of
 * {@link loadWorkflowResult}: a second independent `loadWorkflowState` read
 * can observe a DIFFERENT run than the one the caller validated, if
 * `onTerminalConflict: 'start-new'` replaces the workflow between the two
 * reads — attributing a replacement run's result (or a spurious "still
 * running") to a waiter that was made terminal by the original run.
 */
export function deriveWorkflowResultFromState(state: WorkflowState): unknown {
  if (state.status === 'completed') return state.result;
  if (state.status === 'failed') {
    const restoredError = new Error(state.error ?? 'Workflow failed');
    if (state.errorStack) restoredError.stack = state.errorStack;
    throw restoredError;
  }
  if (state.status === 'cancelled') throw new Error('Workflow cancelled');
  if (state.status === 'timed-out') {
    const elapsed = state.executionDeadline
      ? state.executionDeadline - getWorkflowExecutionStartedAt(state)
      : 0;
    throw new WorkflowTimeoutError(state.id, 'execution', elapsed, state.terminationReason);
  }
  throw new Error(`Workflow "${state.id}" is still ${state.status}`);
}

/** Load a terminal workflow result or throw the persisted terminal error. */
export async function loadWorkflowResult(
  internals: EngineInternals,
  workflowId: string,
): Promise<unknown> {
  const state = await loadWorkflowState(internals, workflowId);
  if (!state) throw new Error(`Workflow "${workflowId}" not found`);
  return deriveWorkflowResultFromState(state);
}

type WorkflowStateCommitOptions = {
  includePendingAtomicSideEffects?: boolean;
};

/**
 * Assemble the operations + CAS conditions for a workflow-state commit, folding in
 * any pending atomic side effects, so the side-effect batching and condition
 * derivation live in one place that both {@link commitSelfWorkflowStateOperations}
 * and {@link commitExternalTerminalWorkflowStateOperations} reuse.
 */
function buildWorkflowStateCommit(
  internals: EngineInternals,
  workflowId: string,
  operations: BatchOperation[],
  options: WorkflowStateCommitOptions,
): {
  operations: BatchOperation[];
  conditions: ConditionalBatchCondition[];
  hasPendingSideEffects: boolean;
} {
  const pendingSideEffects = options.includePendingAtomicSideEffects
    ? takePendingAtomicWorkflowCommitSideEffects(internals, workflowId)
    : undefined;
  const operationsWithSideEffects =
    pendingSideEffects === undefined
      ? operations
      : [...operations, ...pendingSideEffects.operations];
  const storageSupportsConditionalBatch = internals.storage.capabilities().conditionalBatch;
  const conditions = storageSupportsConditionalBatch ? (pendingSideEffects?.conditions ?? []) : [];
  return {
    operations: operationsWithSideEffects,
    conditions,
    hasPendingSideEffects: pendingSideEffects !== undefined,
  };
}

/**
 * Build the `wf-owner-epoch:<id>` / `wf-owner-holder:<id>` ROTATION fragment
 * for an EXTERNAL terminal transition — cancel, timeout, suspend, purge (ADR
 * 0002 § "External terminal transitions must rotate the epoch"). Any engine
 * may commit these against a workflow it does not own; deleting the holder
 * alone is not sufficient to make that safe, so the epoch is rotated in the
 * SAME atomic batch that writes the terminal/suspended state, deposing a
 * still-running owner — its next write carries the now-stale epoch and loses
 * its CAS. Meant to be folded (via `[...fragment.operations]` /
 * `[...fragment.conditions]`) into the caller's own operations/conditions,
 * never committed standalone.
 *
 * Under `ownership: 'none'` or `'lease'` this returns an EMPTY fragment with
 * NO storage read: the `wf-owner-*` keyspace is not in play under those
 * modes, and this function must not touch it — that is what keeps external
 * terminal commits byte-for-byte unchanged there.
 */
export async function buildExternalTerminalRotationFragment(
  internals: EngineInternals,
  workflowId: string,
): Promise<WorkflowClaimTransitionFragment> {
  if (internals.options.ownershipMode !== 'workflow-lease') {
    return { conditions: [], operations: [] };
  }
  const observedEpochBytes = await internals.storage.get(KEYS.workflowOwnerEpoch(workflowId));
  return buildWorkflowClaimExternalTerminalRotationTransition({ workflowId, observedEpochBytes });
}

/**
 * Commit a SELF-transition workflow-state advance (complete, fail): this
 * engine is finishing its OWN workflow, so the write is workflow-scoped and
 * fenced on THIS engine's claim epoch under `ownership: 'workflow-lease'`
 * (via {@link commitFencedEngineWrite}'s `workflowId` parameter), or the
 * global lease epoch under `ownership: 'lease'`. A deposed engine's write
 * loses its CAS instead of corrupting the successor's state; the deposition
 * is detected and the engine (or, under `workflow-lease`, just this one
 * workflow) halts. Under `ownership: 'none'` this is byte-for-byte the
 * pre-ADR commit shape. Never rotates `wf-owner-epoch:<id>` — that is the
 * external-transition shape below. Operator/external mutations
 * (search-attribute and tag edits) do NOT use this helper; they batch
 * directly and are intentionally never fenced.
 */
export async function commitSelfWorkflowStateOperations(
  internals: EngineInternals,
  state: WorkflowState,
  operations: BatchOperation[],
  options: WorkflowStateCommitOptions = {},
): Promise<void> {
  const commit = buildWorkflowStateCommit(internals, state.id, operations, options);

  await commitFencedEngineWrite(
    internals,
    state.id,
    commit.operations,
    commit.conditions,
    () =>
      new Error(
        `Workflow state commit for workflow "${state.id}" lost its atomic side-effect precondition.`,
      ),
  );

  if (commit.hasPendingSideEffects) {
    clearPendingAtomicWorkflowCommitSideEffects(internals, state.id);
  }
}

/**
 * Commit an EXTERNAL terminal workflow-state transition — cancel, timeout, or
 * suspend (ADR 0002 § "External terminal transitions must rotate the
 * epoch"). ANY engine may commit these against a workflow it does not own, so
 * — unlike {@link commitSelfWorkflowStateOperations} — this is never fenced
 * on this engine's own workflow claim (`workflowId: null` is passed to
 * {@link commitFencedEngineWrite}). Instead {@link
 * buildExternalTerminalRotationFragment} folds a claim ROTATION into the same
 * atomic batch under `ownership: 'workflow-lease'`, deposing a still-running
 * owner. Under `ownership: 'lease'` the write still carries the global lease
 * epoch condition (via `commitFencedEngineWrite`'s `workflowId: null` path);
 * under `'none'` it is byte-for-byte unchanged.
 */
export async function commitExternalTerminalWorkflowStateOperations(
  internals: EngineInternals,
  state: WorkflowState,
  operations: BatchOperation[],
  options: WorkflowStateCommitOptions = {},
): Promise<void> {
  const commit = buildWorkflowStateCommit(internals, state.id, operations, options);
  const rotation = await buildExternalTerminalRotationFragment(internals, state.id);

  await commitFencedEngineWrite(
    internals,
    null,
    [...commit.operations, ...rotation.operations],
    [...commit.conditions, ...rotation.conditions],
    () =>
      new Error(
        // This path carries two kinds of precondition: the caller's staged
        // side-effect conditions and, under `workflow-lease`, the folded epoch
        // rotation. Naming only the former would send an operator debugging a
        // claim race toward the side-effect subsystem instead of the epoch one.
        `External terminal commit for workflow "${state.id}" lost a commit precondition ` +
          '(staged side effects, or the ownership epoch rotation under `workflow-lease`).',
      ),
  );

  if (commit.hasPendingSideEffects) {
    clearPendingAtomicWorkflowCommitSideEffects(internals, state.id);
  }
}

/** Load and decode persisted schedule state by schedule ID. */
export async function loadScheduleState(
  internals: EngineInternals,
  scheduleId: string,
): Promise<ScheduleState | null> {
  const bytes = await internals.storage.get(KEYS.schedule(scheduleId));
  return bytes ? decodeScheduleState(bytes) : null;
}

/** Load a schedule state. */
export async function requireScheduleState(
  internals: EngineInternals,
  scheduleId: string,
): Promise<ScheduleState> {
  const state = await loadScheduleState(internals, scheduleId);
  if (!state) {
    throw new Error(`Schedule "${scheduleId}" not found`);
  }
  return state;
}

function buildPreviousScheduleTimerDeleteOperations(
  previousState: ScheduleState | undefined,
): BatchOperation[] {
  if (previousState?.status !== 'active' || previousState.nextFireAt === null) return [];
  return [
    {
      type: 'delete',
      key: KEYS.scheduleTick(
        resolveEffectiveScheduleFireAt(previousState, previousState.nextFireAt),
        previousState.id,
      ),
    },
  ];
}

function buildNextScheduleTimerOperations(
  state: ScheduleState,
  includeTimer: boolean,
): BatchOperation[] {
  if (!includeTimer || state.status !== 'active' || state.nextFireAt === null) return [];
  return buildTimerBatchOperations({
    id: createScheduleTimerId(state.id),
    workflowId: state.id,
    fireAt: resolveEffectiveScheduleFireAt(state, state.nextFireAt),
    kind: 'schedule',
  });
}

function buildScheduleTimerReplacementOperations(
  state: ScheduleState,
  includeTimer: boolean,
  previousState: ScheduleState | undefined,
): BatchOperation[] {
  const deleteOperations = buildPreviousScheduleTimerDeleteOperations(previousState);
  const nextTimerOperations = buildNextScheduleTimerOperations(state, includeTimer);
  if (nextTimerOperations.length > 0) return [...deleteOperations, ...nextTimerOperations];
  if (previousState === undefined) return deleteOperations;
  return [
    ...deleteOperations,
    { type: 'delete', key: `timer-idx:${createScheduleTimerId(state.id)}` },
  ];
}

/** Persist schedule state and optionally write the next schedule timer. */
export async function writeScheduleState(
  internals: EngineInternals,
  state: ScheduleState,
  options?: {
    includeTimer?: boolean;
    replaceTimerFrom?: ScheduleState;
    additionalOperations?: BatchOperation[];
  },
): Promise<void> {
  const operations: BatchOperation[] = [
    { type: 'put', key: KEYS.schedule(state.id), value: encode(state) },
  ];

  const includeTimer = options?.includeTimer ?? state.status === 'active';
  operations.push(
    ...buildScheduleTimerReplacementOperations(state, includeTimer, options?.replaceTimerFrom),
  );

  operations.push(...(options?.additionalOperations ?? []));

  // Engine-scoped: `state.id` here is a SCHEDULE id, not a workflow id, and
  // this writes the schedule record itself (create/pause/resume/cancel/update),
  // not any one workflow's execution. No `wf-owner-epoch` fence applies.
  await commitFencedEngineWrite(
    internals,
    null,
    operations,
    [],
    () => new Error(`Schedule state commit for schedule "${state.id}" lost its precondition.`),
  );
}

/** Load persisted workflow start headers by workflow ID. */
export async function loadWorkflowStartHeaders(
  internals: EngineInternals,
  workflowId: string,
): Promise<Map<string, string> | undefined> {
  const bytes = await internals.storage.get(KEYS.workflowHeaders(workflowId));
  if (!bytes) {
    return undefined;
  }

  return decodeWorkflowStartHeaders(bytes);
}
