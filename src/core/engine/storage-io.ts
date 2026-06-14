import { KEYS, storageConditionalBatch, type BatchOperation } from '../../storage/interface.ts';
import { encode } from '../codec.ts';
import { buildTimerBatchOperations } from '../scheduler.ts';
import { WorkflowTimeoutError } from '../timeouts.ts';
import type { ScheduleState, WorkflowState } from '../types.ts';
import {
  clearPendingAtomicWorkflowCommitSideEffects,
  takePendingAtomicWorkflowCommitSideEffects,
} from './checkpoint-side-effects.ts';
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
    throw new WorkflowTimeoutError(workflowId, 'execution', elapsed);
  }
  throw new Error(`Workflow "${workflowId}" is still ${state.status}`);
}

type WorkflowStateCommitOptions = {
  includePendingAtomicSideEffects?: boolean;
};

/** Commit workflow state operations. */
export async function commitWorkflowStateOperations(
  internals: EngineInternals,
  state: WorkflowState,
  operations: BatchOperation[],
  options: WorkflowStateCommitOptions = {},
): Promise<void> {
  const pendingSideEffects = options.includePendingAtomicSideEffects
    ? takePendingAtomicWorkflowCommitSideEffects(internals, state.id)
    : undefined;
  const operationsWithSideEffects =
    pendingSideEffects === undefined
      ? operations
      : [...operations, ...pendingSideEffects.operations];
  const conditions = pendingSideEffects?.conditions ?? [];

  if (conditions.length === 0) {
    await internals.storage.batch(operationsWithSideEffects);
  } else {
    const committed = await storageConditionalBatch(
      internals.storage,
      conditions,
      operationsWithSideEffects,
    );
    if (!committed) {
      throw new Error(
        `Workflow state commit for workflow "${state.id}" lost its atomic side-effect precondition.`,
      );
    }
  }

  if (pendingSideEffects !== undefined) {
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

  await internals.storage.batch(operations);
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
