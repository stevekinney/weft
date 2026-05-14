import type { BatchOperation } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { decode, encode } from '../codec.ts';
import { getNextCronOccurrence, parseCronExpression } from '../schedule.ts';
import type { TenantContext } from '../tenant.ts';
import type {
  PaginatedResult,
  ScheduleAccessOptions,
  ScheduleFilter,
  ScheduleOptions,
  ScheduleState,
  ScheduleSummary,
  WorkflowState,
} from '../types.ts';
import { WorkflowNotRegisteredError } from './errors.ts';
import { ScheduleHandle } from './handles.ts';
import type { EngineInternals } from './internals.ts';
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
  normalizeScheduleAccessOptions,
  normalizeScheduleFilter,
  normalizeScheduleOptions,
} from './validation.ts';

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
    tenantResolution: { resolved: TenantContext | undefined },
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

async function resolveScheduleTenant(
  internals: EngineInternals,
  scheduleId: string,
  workflowType: string,
  input: unknown,
  accessOptions: ScheduleAccessOptions | undefined,
): Promise<TenantContext | undefined> {
  const resolvedTenant = await internals.options.tenantResolver?.resolve(
    scheduleId,
    input,
    workflowType,
  );

  if (accessOptions?.tenantId === undefined) {
    return resolvedTenant;
  }

  if (resolvedTenant === undefined) {
    return { id: accessOptions.tenantId };
  }

  if (resolvedTenant.id !== accessOptions.tenantId) {
    throw new Error('Schedule creation is limited to the authenticated tenant');
  }

  return resolvedTenant;
}

export async function schedule(
  internals: EngineInternals,
  type: string,
  input: unknown,
  cronExpression: string,
  options?: ScheduleOptions,
  accessOptions?: ScheduleAccessOptions,
): Promise<ScheduleHandle> {
  if (!internals.registrations.has(type)) {
    throw new WorkflowNotRegisteredError(type);
  }
  if (typeof cronExpression !== 'string') {
    throw new Error('cronExpression must be a string');
  }
  const normalizedOptions = normalizeScheduleOptions(options);
  const normalizedAccessOptions = normalizeScheduleAccessOptions(accessOptions);
  parseCronExpression(cronExpression);
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
    const tenant = await resolveScheduleTenant(
      internals,
      scheduleId,
      type,
      input,
      normalizedAccessOptions,
    );
    const state: ScheduleState = {
      id: scheduleId,
      workflowType: type,
      input,
      cronExpression,
      status: 'active',
      overlap: normalizedOptions.overlap,
      backfill: normalizedOptions.backfill,
      createdAt: now,
      updatedAt: now,
      nextFireAt: getNextCronOccurrence(cronExpression, now),
      queuedRuns: 0,
      ...(tenant !== undefined && { tenant }),
    };
    await writeScheduleState(internals, state);
    return new ScheduleHandle(
      scheduleId,
      internals.engine,
      tenant ? { tenantId: tenant.id } : undefined,
    );
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
    const { tenant: _tenant, input: _input, ...summary } = state;
    items.push(summary);
  }

  return paginateScheduleSummaries(items, normalizedFilter);
}

export function toScheduleSummary(state: ScheduleState): ScheduleSummary {
  const { tenant: _tenant, input: _input, ...summary } = state;
  return summary;
}

export async function pauseSchedule(
  internals: EngineInternals,
  scheduleId: string,
  accessOptions?: ScheduleAccessOptions,
): Promise<void> {
  const normalizedScheduleId = coerceScheduleId(scheduleId, 'scheduleId');
  const normalizedAccessOptions = normalizeScheduleAccessOptions(accessOptions);
  const state = await requireScheduleState(
    internals,
    normalizedScheduleId,
    normalizedAccessOptions,
  );
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
    nextFireAt: getNextCronOccurrence(state.cronExpression, now),
    queuedRuns: 0,
  };
  await writeScheduleState(internals, updatedState, { includeTimer: false });
}

export async function resumeSchedule(
  internals: EngineInternals,
  scheduleId: string,
  accessOptions?: ScheduleAccessOptions,
): Promise<void> {
  const normalizedScheduleId = coerceScheduleId(scheduleId, 'scheduleId');
  const normalizedAccessOptions = normalizeScheduleAccessOptions(accessOptions);
  const state = await requireScheduleState(
    internals,
    normalizedScheduleId,
    normalizedAccessOptions,
  );
  if (state.status === 'cancelled') {
    throw new Error(`Schedule "${normalizedScheduleId}" has been cancelled and cannot be resumed`);
  }
  if (state.status === 'active') return;
  const now = internals.options.getNow();
  const updatedState: ScheduleState = {
    ...state,
    status: 'active',
    updatedAt: now,
    nextFireAt: getNextCronOccurrence(state.cronExpression, now),
  };
  await writeScheduleState(internals, updatedState);
}

export async function cancelSchedule(
  internals: EngineInternals,
  scheduleId: string,
  accessOptions?: ScheduleAccessOptions,
): Promise<void> {
  const normalizedScheduleId = coerceScheduleId(scheduleId, 'scheduleId');
  const normalizedAccessOptions = normalizeScheduleAccessOptions(accessOptions);
  const state = await requireScheduleState(
    internals,
    normalizedScheduleId,
    normalizedAccessOptions,
  );
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
  newCronExpression: string,
  accessOptions?: ScheduleAccessOptions,
): Promise<void> {
  const normalizedScheduleId = coerceScheduleId(scheduleId, 'scheduleId');
  const normalizedAccessOptions = normalizeScheduleAccessOptions(accessOptions);
  if (typeof newCronExpression !== 'string') {
    throw new Error('newCronExpression must be a string');
  }
  parseCronExpression(newCronExpression);
  const state = await requireScheduleState(
    internals,
    normalizedScheduleId,
    normalizedAccessOptions,
  );
  if (state.status === 'active') {
    await internals.scheduler.cancel(
      createScheduleTimerId(normalizedScheduleId),
      normalizedScheduleId,
    );
  }
  const now = internals.options.getNow();
  const updatedState: ScheduleState = {
    ...state,
    cronExpression: newCronExpression,
    updatedAt: now,
    nextFireAt: state.status === 'cancelled' ? null : getNextCronOccurrence(newCronExpression, now),
  };
  await writeScheduleState(internals, updatedState, { includeTimer: state.status === 'active' });
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
  if (currentWorkflowState?.status === 'running' || currentWorkflowState?.status === 'pending') {
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
    { resolved: state.tenant },
    scheduleRunOperations,
  );
  return workflowId;
}

function hasActiveScheduledWorkflow(
  currentWorkflowState: WorkflowState | null | undefined,
): boolean {
  return currentWorkflowState?.status === 'running' || currentWorkflowState?.status === 'pending';
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
