import {
  storageValuesEqual,
  type BatchOperation,
  type ConditionalBatchCondition,
} from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import { WorkflowTimeoutError } from '../timeouts.ts';
import type { ScheduleState, WorkflowState } from '../types.ts';
import {
  clearPendingAtomicWorkflowCommitSideEffects,
  stageAtomicWorkflowCommitSideEffects,
  takePendingAtomicWorkflowCommitSideEffects,
} from './checkpoint-side-effects.ts';
import {
  commitFencedEngineWrite,
  commitFencedEngineWriteAllowingPreconditionFailure,
} from './fenced-write.ts';
import { getWorkflowExecutionStartedAt } from './handles.ts';
import type { EngineInternals } from './internals.ts';
import { isScheduleReadCondition, ScheduleReadConditionLostError } from './schedule-state-read.ts';
import { buildScheduleStateOperations } from './schedule-write-operations.ts';
import { decodeWorkflowStartHeaders } from './state-utilities.ts';
import { retryTerminalWorkflowStateWrite } from './terminal-write-retry.ts';
import { decodeWorkflowState } from './validation.ts';
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
  /**
   * Further preconditions for the commit, such as the exact state bytes the caller decided on. They
   * apply only on a storage with `conditionalBatch`. A commit that loses one restores the staged
   * side effects it took, so the caller can re-decide and commit again.
   */
  extraConditions?: ConditionalBatchCondition[];
  /** Retry a refused write in process, as this terminal write; read only by the self commit. */
  retryRefusedWrite?: 'completion' | 'failure';
  /** Rebuild the operations over a fresher record of the same run; read only with a retry. */
  rebuildOperations?: (fresh: WorkflowState) => BatchOperation[];
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
  /** The staged side-effect operations the commit folded in; a rebuilt batch carries them too. */
  sideEffectOperations: BatchOperation[];
  hasPendingSideEffects: boolean;
  restoreSideEffects: () => void;
} {
  const pendingSideEffects = options.includePendingAtomicSideEffects
    ? takePendingAtomicWorkflowCommitSideEffects(
        internals,
        workflowId,
        internals.checkpoints?.get(workflowId)?.workflowExecutionToken,
      )
    : undefined;
  const sideEffectOperations = pendingSideEffects?.operations ?? [];
  const storageSupportsConditionalBatch = internals.storage.capabilities().conditionalBatch;
  const conditions = storageSupportsConditionalBatch
    ? [...(pendingSideEffects?.conditions ?? []), ...(options.extraConditions ?? [])]
    : [];
  return {
    operations: [...operations, ...sideEffectOperations],
    conditions,
    sideEffectOperations,
    hasPendingSideEffects: pendingSideEffects !== undefined,
    restoreSideEffects: () => {
      if (pendingSideEffects !== undefined) {
        stageAtomicWorkflowCommitSideEffects(internals, workflowId, pendingSideEffects);
      }
    },
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
  const onLostRace = () =>
    new Error(
      `Workflow state commit for workflow "${state.id}" lost its atomic side-effect precondition.`,
    );

  try {
    try {
      await commitFencedEngineWrite(
        internals,
        state.id,
        commit.operations,
        commit.conditions,
        onLostRace,
      );
    } catch (error) {
      // A refused write is retried in process when asked: from this catch, so no extra promise turn.
      if (options.retryRefusedWrite === undefined) throw error;
      await retryTerminalWorkflowStateWrite(
        internals,
        state,
        options.retryRefusedWrite,
        commit.operations,
        commit.conditions,
        error,
        onLostRace,
        options.rebuildOperations,
        commit.sideEffectOperations,
      );
    }
  } catch (error) {
    commit.restoreSideEffects();
    throw error;
  }

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

  try {
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
  } catch (error) {
    commit.restoreSideEffects();
    throw error;
  }

  if (commit.hasPendingSideEffects) {
    clearPendingAtomicWorkflowCommitSideEffects(internals, state.id);
  }
}

/**
 * Persist schedule state and optionally write the next schedule timer.
 *
 * `extraConditions` (WFT-20) additionally fences the commit on caller-supplied
 * preconditions — used by a `revisionPolicy: 'pinned'` create/update to fence
 * the write on `buildCatalogEntryRevisionCondition(type, pinnedRevision)` so a
 * concurrent `removeWorkflowRevision()` landing between pin capture and this
 * commit cannot let a pin to an already-removed revision durably land. When
 * the commit's `extraConditions` are the ones that lost the CAS,
 * `onExtraConditionsLost` (required whenever `extraConditions` is non-empty)
 * supplies the thrown error instead of this function's own generic
 * lost-precondition error, so the caller sees an actionable, typed failure
 * (e.g. `WorkflowRevisionUnavailableError`) rather than a bare "lost its
 * precondition" message. A write that passes neither option and no schedule read
 * condition (a create) gets byte-for-byte the pre-WFT-20 commit shape.
 *
 * COR-1594: a read-then-write adds {@link scheduleReadConditions} to `extraConditions`, which makes
 * the write conditional on the schedule key's exact stored bytes. When that condition is the one
 * lost, this throws {@link ScheduleReadConditionLostError} and not `onExtraConditionsLost`, which
 * speaks only for the caller's own conditions: the writer re-reads and decides again. Resolves
 * with the bytes written, which the next write of the same writer is conditioned on.
 */
export async function writeScheduleState(
  internals: EngineInternals,
  state: ScheduleState,
  options?: {
    includeTimer?: boolean;
    replaceTimerFrom?: ScheduleState;
    additionalOperations?: BatchOperation[];
    extraConditions?: ConditionalBatchCondition[];
    onExtraConditionsLost?: () => Error;
  },
): Promise<Uint8Array> {
  const { bytes, record, following } = buildScheduleStateOperations(state, options);
  const operations: BatchOperation[] = [record, ...following];

  const extraConditions = options?.extraConditions ?? [];

  // Engine-scoped: `state.id` here is a SCHEDULE id, not a workflow id, and
  // this writes the schedule record itself (create/pause/resume/cancel/update),
  // not any one workflow's execution. No `wf-owner-epoch` fence applies.
  if (extraConditions.length > 0) {
    await commitScheduleStateWithExtraConditions(
      internals,
      state,
      operations,
      extraConditions,
      options?.onExtraConditionsLost,
    );
    return bytes;
  }

  await commitFencedEngineWrite(
    internals,
    null,
    operations,
    [],
    () => new Error(`Schedule state commit for schedule "${state.id}" lost its precondition.`),
  );
  return bytes;
}

/**
 * The `extraConditions` half of {@link writeScheduleState} — split out to
 * keep that function under the complexity ceiling. Commits, and on a lost
 * CAS, disambiguates which extra condition actually changed (mirrors
 * `start-commit.ts`'s `hasCatalogEntryConflict` re-check pattern) before
 * trusting the caller-supplied typed error over the generic
 * lost-precondition one.
 */
async function commitScheduleStateWithExtraConditions(
  internals: EngineInternals,
  state: ScheduleState,
  operations: BatchOperation[],
  extraConditions: ConditionalBatchCondition[],
  onExtraConditionsLost: (() => Error) | undefined,
): Promise<void> {
  const committed = await commitFencedEngineWriteAllowingPreconditionFailure(
    internals,
    null,
    operations,
    extraConditions,
  );
  if (committed) {
    return;
  }
  // The engine's own read condition is judged first, and told from a caller's by identity: it is
  // the writer's to retry, and a caller's typed error must not stand in for it. A caller's
  // condition on any key, the schedule's own included, is the caller's.
  const ordered = [
    ...extraConditions.filter(isScheduleReadCondition),
    ...extraConditions.filter((condition) => !isScheduleReadCondition(condition)),
  ];
  for (const condition of ordered) {
    const currentValue = await internals.storage.get(condition.key);
    if (!storageValuesEqual(currentValue, condition.expectedValue)) {
      if (isScheduleReadCondition(condition)) throw new ScheduleReadConditionLostError(state.id);
      throw (
        onExtraConditionsLost?.() ??
        new Error(`Schedule state commit for schedule "${state.id}" lost its precondition.`)
      );
    }
  }
  throw new Error(`Schedule state commit for schedule "${state.id}" lost its precondition.`);
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
