import type { BatchOperation } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { decode, encode } from '../codec.ts';
import type {
  PaginatedResult,
  ScheduleFilter,
  ScheduleOptions,
  ScheduleSpec,
  ScheduleState,
  ScheduleSummary,
  WorkflowState,
} from '../types.ts';
import { WorkflowNotRegisteredError } from './errors.ts';
import type { EngineInternals } from './internals.ts';
import { ScheduleHandle } from './schedule-handle.ts';
import { getNextScheduleOccurrence } from './schedule-occurrence.ts';
import {
  clearScheduleCurrentWorkflow,
  createScheduleTimerId,
  matchesScheduleFilter,
  paginateScheduleSummaries,
} from './state-utilities.ts';
import { loadScheduleState, requireScheduleState, writeScheduleState } from './storage-io.ts';
import {
  coerceScheduleId,
  decodeScheduleState,
  isValidScheduleIdentifier,
  normalizeScheduleFilter,
  normalizeScheduleOptions,
  normalizeScheduleSpec,
} from './validation/schedule.ts';

export { handleScheduleTimer } from './schedule-timer.ts';

export type RefreshedScheduleState = {
  state: ScheduleState;
  currentWorkflowState: WorkflowState | null;
};

export type ScheduleCallbacks = {
  startWorkflow: (
    type: string,
    input: unknown,
    options: { id: string },
    additionalStartOperations?: BatchOperation[],
  ) => Promise<void>;
  loadWorkflowState: (workflowId: string) => Promise<WorkflowState | null | undefined>;
  cancelWorkflow: (workflowId: string) => Promise<void>;
  getWorkflowResult: (workflowId: string) => Promise<unknown>;
  refreshScheduledWorkflowState: (state: ScheduleState) => Promise<RefreshedScheduleState>;
  startScheduledRun: (state: ScheduleState) => Promise<string>;
  applyScheduleOccurrence: (state: ScheduleState) => Promise<ScheduleState>;
  settleBackfillScheduleState: (state: ScheduleState) => Promise<ScheduleState>;
  flushQueuedInlineWorkflowStartsDirectly: () => Promise<void>;
};

export async function schedule(
  internals: EngineInternals,
  type: string,
  input: unknown,
  spec: string | ScheduleSpec,
  options?: ScheduleOptions,
): Promise<ScheduleHandle> {
  if (!internals.registrations.has(type)) {
    throw new WorkflowNotRegisteredError(type);
  }
  const normalizedSpec = normalizeScheduleSpec(spec);
  const normalizedOptions = normalizeScheduleOptions(options);
  const scheduleId = normalizedOptions.id ?? crypto.randomUUID();
  if (internals.pendingScheduleCreations.has(scheduleId)) {
    throw new Error(`Schedule with id "${scheduleId}" already exists`);
  }
  internals.pendingScheduleCreations.add(scheduleId);
  try {
    if (await internals.storage.get(KEYS.schedule(scheduleId))) {
      throw new Error(`Schedule with id "${scheduleId}" already exists`);
    }
    const now = internals.options.getNow();
    const cadenceFields =
      normalizedSpec.kind === 'interval'
        ? { intervalMs: normalizedSpec.intervalMs }
        : { cronExpression: normalizedSpec.cronExpression };
    const state: ScheduleState = {
      id: scheduleId,
      workflowType: type,
      input,
      ...cadenceFields,
      status: 'active',
      overlap: normalizedOptions.overlap,
      backfill: normalizedOptions.backfill,
      createdAt: now,
      updatedAt: now,
      nextFireAt: getNextScheduleOccurrence({ ...cadenceFields, createdAt: now }, now),
      queuedRuns: 0,
    };
    await writeScheduleState(internals, state);
    return new ScheduleHandle(scheduleId, internals.engine);
  } finally {
    internals.pendingScheduleCreations.delete(scheduleId);
  }
}

export async function listSchedules(
  internals: EngineInternals,
  filter?: ScheduleFilter,
): Promise<PaginatedResult<ScheduleSummary>> {
  const normalizedFilter = normalizeScheduleFilter(filter);
  const items: ScheduleSummary[] = [];
  for await (const [key, value] of internals.storage.scan('schedule:')) {
    const scheduleKeySuffix = key.slice('schedule:'.length);
    if (scheduleKeySuffix.includes(':')) continue;
    const state = decodeScheduleState(value);
    if (!state || !matchesScheduleFilter(state, normalizedFilter)) continue;
    const { input: _input, ...summary } = state;
    items.push(summary);
  }

  return paginateScheduleSummaries(items, normalizedFilter);
}

export function toScheduleSummary(state: ScheduleState): ScheduleSummary {
  const { input: _input, ...summary } = state;
  return summary;
}

export async function pauseSchedule(internals: EngineInternals, scheduleId: string): Promise<void> {
  const normalizedScheduleId = coerceScheduleId(scheduleId, 'scheduleId');
  const state = await requireScheduleState(internals, normalizedScheduleId);
  if (state.status !== 'active') return;
  await internals.scheduler.cancel(
    createScheduleTimerId(normalizedScheduleId),
    normalizedScheduleId,
  );
  const now = internals.options.getNow();
  const updatedState: ScheduleState = {
    ...state,
    status: 'paused',
    updatedAt: now,
    nextFireAt: getNextScheduleOccurrence(state, now),
    queuedRuns: 0,
  };
  await writeScheduleState(internals, updatedState, { includeTimer: false });
}

export async function resumeSchedule(
  internals: EngineInternals,
  scheduleId: string,
): Promise<void> {
  const normalizedScheduleId = coerceScheduleId(scheduleId, 'scheduleId');
  const state = await requireScheduleState(internals, normalizedScheduleId);
  if (state.status === 'cancelled') {
    throw new Error(`Schedule "${normalizedScheduleId}" has been cancelled and cannot be resumed`);
  }
  if (state.status === 'active') return;
  const now = internals.options.getNow();
  const updatedState: ScheduleState = {
    ...state,
    status: 'active',
    updatedAt: now,
    nextFireAt: getNextScheduleOccurrence(state, now),
  };
  await writeScheduleState(internals, updatedState);
}

export async function cancelSchedule(
  internals: EngineInternals,
  scheduleId: string,
): Promise<void> {
  const normalizedScheduleId = coerceScheduleId(scheduleId, 'scheduleId');
  const state = await requireScheduleState(internals, normalizedScheduleId);
  if (state.status === 'active') {
    await internals.scheduler.cancel(
      createScheduleTimerId(normalizedScheduleId),
      normalizedScheduleId,
    );
  }
  const updatedState: ScheduleState = {
    ...state,
    status: 'cancelled',
    updatedAt: internals.options.getNow(),
    nextFireAt: null,
    queuedRuns: 0,
  };
  await writeScheduleState(internals, updatedState, { includeTimer: false });
}

export async function updateSchedule(
  internals: EngineInternals,
  scheduleId: string,
  newSpec: string | ScheduleSpec,
): Promise<void> {
  const normalizedScheduleId = coerceScheduleId(scheduleId, 'scheduleId');
  const normalizedSpec = normalizeScheduleSpec(newSpec);
  const state = await requireScheduleState(internals, normalizedScheduleId);
  if (state.status === 'active') {
    await internals.scheduler.cancel(
      createScheduleTimerId(normalizedScheduleId),
      normalizedScheduleId,
    );
  }
  const now = internals.options.getNow();
  // Replace the cadence wholesale so switching kinds (cron <-> interval) never
  // leaves a stale field behind. Interval cadence re-anchors at the update time.
  // Strip both cadence fields from the carried-over state first, then attach
  // only the one the new spec selects (exactOptionalPropertyTypes forbids
  // carrying an explicit `undefined`).
  const {
    cronExpression: _droppedCron,
    intervalMs: _droppedInterval,
    ...stateWithoutCadence
  } = state;
  const cadenceFields =
    normalizedSpec.kind === 'interval'
      ? { intervalMs: normalizedSpec.intervalMs }
      : { cronExpression: normalizedSpec.cronExpression };
  // For interval specs the occurrence grid is anchored at `createdAt`. Re-anchor
  // to `now` (the update time) so the timer's subsequent `getNextScheduleOccurrence`
  // calls use the same origin as the `nextFireAt` computed here. Without this,
  // the first fire after the update is correct but later fires drift back to the
  // original creation-time grid.
  const anchorFields = normalizedSpec.kind === 'interval' ? { createdAt: now } : {};
  const updatedState: ScheduleState = {
    ...stateWithoutCadence,
    ...cadenceFields,
    ...anchorFields,
    updatedAt: now,
    nextFireAt:
      state.status === 'cancelled'
        ? null
        : getNextScheduleOccurrence({ ...cadenceFields, createdAt: now }, now),
  };
  await writeScheduleState(internals, updatedState, { includeTimer: state.status === 'active' });
}

/**
 * Whether a schedule's current run still occupies the schedule slot for overlap
 * purposes. A `'suspended'` run is non-terminal and resumable — it has NOT
 * finished, so it must keep the slot occupied exactly like `'running'`/`'pending'`,
 * otherwise the next occurrence would start an overlapping run under a non-`allow`
 * overlap policy (skip/queue/cancel-running) while the paused run still exists.
 * This is deliberately a wider set than `workflowStatusCanRetainLocalOwnership`
 * (which excludes `'suspended'` so recoverAll skips it): "occupies the schedule
 * slot" is "not terminal", not "locally owned".
 */
function scheduledRunOccupiesSlot(
  currentWorkflowState: WorkflowState | null | undefined,
): currentWorkflowState is WorkflowState {
  const status = currentWorkflowState?.status;
  return status === 'running' || status === 'pending' || status === 'suspended';
}

export async function refreshScheduledWorkflowState(
  internals: EngineInternals,
  state: ScheduleState,
  callbacks: Pick<ScheduleCallbacks, 'loadWorkflowState'>,
): Promise<RefreshedScheduleState> {
  if (!state.currentWorkflowId) {
    return { state, currentWorkflowState: null };
  }
  const currentWorkflowState = await callbacks.loadWorkflowState(state.currentWorkflowId);
  if (scheduledRunOccupiesSlot(currentWorkflowState)) {
    return { state, currentWorkflowState };
  }
  await internals.storage.delete(KEYS.scheduleRun(state.currentWorkflowId));
  return {
    state: clearScheduleCurrentWorkflow(state),
    currentWorkflowState: currentWorkflowState ?? null,
  };
}

export async function startScheduledRun(
  _internals: EngineInternals,
  state: ScheduleState,
  callbacks: Pick<ScheduleCallbacks, 'startWorkflow'>,
): Promise<string> {
  const workflowId = crypto.randomUUID();
  const scheduleRunOperations =
    state.overlap === 'allow'
      ? undefined
      : [{ type: 'put' as const, key: KEYS.scheduleRun(workflowId), value: encode(state.id) }];
  await callbacks.startWorkflow(
    state.workflowType,
    state.input,
    { id: workflowId },
    scheduleRunOperations,
  );
  return workflowId;
}

function hasActiveScheduledWorkflow(
  currentWorkflowState: WorkflowState | null | undefined,
): boolean {
  return scheduledRunOccupiesSlot(currentWorkflowState);
}

async function applyBlockedScheduleOccurrence(
  state: ScheduleState,
  hasActiveWorkflow: boolean,
  callbacks: Pick<ScheduleCallbacks, 'cancelWorkflow' | 'getWorkflowResult' | 'startScheduledRun'>,
): Promise<ScheduleState> {
  if (!hasActiveWorkflow) {
    return { ...state, currentWorkflowId: await callbacks.startScheduledRun(state) };
  }

  if (state.overlap === 'cancel-running') {
    if (state.currentWorkflowId) {
      void callbacks.getWorkflowResult(state.currentWorkflowId).catch(() => {});
      await callbacks.cancelWorkflow(state.currentWorkflowId);
    }
    const stateForStart = clearScheduleCurrentWorkflow(state);
    return { ...state, currentWorkflowId: await callbacks.startScheduledRun(stateForStart) };
  }

  if (state.overlap === 'queue') {
    return { ...state, queuedRuns: state.queuedRuns + 1 };
  }

  return state;
}

export async function applyScheduleOccurrence(
  _internals: EngineInternals,
  state: ScheduleState,
  callbacks: ScheduleCallbacks,
): Promise<ScheduleState> {
  const { state: refreshedState, currentWorkflowState } =
    await callbacks.refreshScheduledWorkflowState(state);
  const hasActiveWorkflow = hasActiveScheduledWorkflow(currentWorkflowState);

  if (refreshedState.overlap === 'allow') {
    await callbacks.startScheduledRun(refreshedState);
    return refreshedState;
  }

  return applyBlockedScheduleOccurrence(refreshedState, hasActiveWorkflow, callbacks);
}

export async function settleBackfillScheduleState(
  internals: EngineInternals,
  state: ScheduleState,
  callbacks: Pick<
    ScheduleCallbacks,
    'flushQueuedInlineWorkflowStartsDirectly' | 'refreshScheduledWorkflowState'
  >,
): Promise<ScheduleState> {
  if (!state.currentWorkflowId) {
    return state;
  }

  await callbacks.flushQueuedInlineWorkflowStartsDirectly();

  const pendingTurn = internals.inlineStrategy?.waitForWorkflowTurn(state.currentWorkflowId);
  if (pendingTurn) {
    await pendingTurn;
  }

  const refreshed = await callbacks.refreshScheduledWorkflowState(state);
  return refreshed.state;
}

export async function handleScheduledWorkflowTerminal(
  internals: EngineInternals,
  workflowId: string,
  callbacks: ScheduleCallbacks,
): Promise<void> {
  const scheduleRunBytes = await internals.storage.get(KEYS.scheduleRun(workflowId));
  if (!scheduleRunBytes) {
    return;
  }
  await internals.storage.delete(KEYS.scheduleRun(workflowId));
  const decodedScheduleId = decode(scheduleRunBytes);
  if (!isValidScheduleIdentifier(decodedScheduleId)) {
    return;
  }
  const scheduleId = decodedScheduleId;
  const state = await loadScheduleState(internals, scheduleId);
  if (!state || state.currentWorkflowId !== workflowId) {
    return;
  }
  const now = internals.options.getNow();
  const clearedState: ScheduleState = {
    ...clearScheduleCurrentWorkflow(state),
    updatedAt: now,
  };
  if (
    clearedState.status === 'active' &&
    clearedState.overlap === 'queue' &&
    clearedState.queuedRuns > 0
  ) {
    const nextWorkflowId = await callbacks.startScheduledRun(clearedState);
    await writeScheduleState(
      internals,
      {
        ...clearedState,
        currentWorkflowId: nextWorkflowId,
        queuedRuns: clearedState.queuedRuns - 1,
        updatedAt: now,
      },
      { includeTimer: false },
    );
    return;
  }
  await writeScheduleState(internals, clearedState, { includeTimer: false });
}
