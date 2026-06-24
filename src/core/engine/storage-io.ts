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

/** Load and decode persisted workflow state by workflow ID. */
export async function loadWorkflowState(
  internals: EngineInternals,
  workflowId: string,
): Promise<WorkflowState | null> {
  const bytes = await internals.storage.get(KEYS.workflow(workflowId));
  if (!bytes) return null;
  return decodeWorkflowState(bytes);
}

/** Load a terminal workflow result or throw the persisted terminal error. */
export async function loadWorkflowResult(
  internals: EngineInternals,
  workflowId: string,
): Promise<unknown> {
  const state = await loadWorkflowState(internals, workflowId);
  if (!state) throw new Error(`Workflow "${workflowId}" not found`);
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
    throw new WorkflowTimeoutError(workflowId, 'execution', elapsed, state.terminationReason);
  }
  throw new Error(`Workflow "${workflowId}" is still ${state.status}`);
}

type WorkflowStateCommitOptions = {
  includePendingAtomicSideEffects?: boolean;
};

/**
 * Assemble the operations + CAS conditions for a workflow-state commit, folding in
 * any pending atomic side effects, so the side-effect batching and condition
 * derivation live in one place that {@link commitFencedWorkflowStateOperations}
 * reuses.
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
 * Commit an engine-generator-owned workflow-state advance, FENCED on the lease
 * epoch under `ownership: 'lease'` (issue #470 Step 2). A deposed engine's write
 * loses its CAS instead of corrupting the successor's state; the deposition is
 * detected and the engine halts (see {@link commitFencedEngineWrite}). Under
 * `ownership: 'none'` it is byte-for-byte the pre-Step-2 commit shape — the epoch
 * condition is only appended when a lease is held. Use this for suspend,
 * completion, and other state advances driven by the workflow lifecycle. Operator/
 * external mutations (search-attribute and tag edits) do NOT use this helper; they
 * batch directly and are intentionally never fenced.
 */
export async function commitFencedWorkflowStateOperations(
  internals: EngineInternals,
  state: WorkflowState,
  operations: BatchOperation[],
  options: WorkflowStateCommitOptions = {},
): Promise<void> {
  const commit = buildWorkflowStateCommit(internals, state.id, operations, options);

  await commitFencedEngineWrite(
    internals,
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

/** Persist schedule state and optionally write the next schedule timer. */
export async function writeScheduleState(
  internals: EngineInternals,
  state: ScheduleState,
  options?: { includeTimer?: boolean },
): Promise<void> {
  const operations: BatchOperation[] = [
    { type: 'put', key: KEYS.schedule(state.id), value: encode(state) },
  ];

  const includeTimer = options?.includeTimer ?? state.status === 'active';
  if (includeTimer && state.status === 'active' && state.nextFireAt !== null) {
    const effectiveFireAt = resolveEffectiveScheduleFireAt(state, state.nextFireAt);
    operations.push(
      ...buildTimerBatchOperations({
        id: createScheduleTimerId(state.id),
        workflowId: state.id,
        fireAt: effectiveFireAt,
        kind: 'schedule',
      }),
    );
  }

  await commitFencedEngineWrite(
    internals,
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
