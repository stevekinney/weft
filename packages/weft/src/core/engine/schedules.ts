import type { BatchOperation, ConditionalBatchCondition } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { decode } from '../codec.ts';
import type {
  PaginatedResult,
  ScheduleFilter,
  ScheduleOptions,
  ScheduleSpec,
  ScheduleState,
  ScheduleSummary,
  ScheduleTransitionOptions,
  ScheduleUpdateOptions,
  WorkflowState,
} from '../types.ts';
import type { Engine } from './index.ts';
import type { EngineInternals } from './internals.ts';
import {
  buildPinnedRevisionWriteOptions,
  resolveScheduleCreationRevision,
  resolveScheduleRevisionForPin,
} from './pinned-schedule-revision.ts';
import { ScheduleHandle } from './schedule-handle.ts';
import { resolveEffectiveScheduleFireAt } from './schedule-jitter.ts';
import { getNextScheduleOccurrence } from './schedule-occurrence.ts';
import type { ScheduledRunStartOptions } from './schedule-run.ts';
import {
  createScheduleTimerId,
  matchesScheduleFilter,
  paginateScheduleSummaries,
} from './state-utilities.ts';
import {
  requireScheduleState,
  runSerializedScheduleStateOperation,
  writeScheduleState,
} from './storage-io.ts';
import { decodeScheduleState } from './validation/schedule-decode.ts';
import {
  coerceScheduleId,
  normalizeScheduleFilter,
  normalizeScheduleOptions,
  normalizeScheduleSpec,
  normalizeScheduleUpdateOptions,
} from './validation/schedule.ts';

export { startScheduledRun } from './schedule-run.ts';
export { handleScheduleTimer } from './schedule-timer.ts';

export type RefreshedScheduleState = {
  state: ScheduleState;
  currentWorkflowState: WorkflowState | null;
};

export type ScheduleCallbacks = {
  /**
   * `revisionOverride` (WFT-20) is the exact revision a `revisionPolicy: 'pinned'`
   * occurrence must resolve against; `undefined` for an `'active-at-fire'` schedule.
   *
   * `skipAdmissionIdCheck` (WFT-95, internal only) is threaded straight through to
   * `startWorkflow`'s parameter of the same name — see its doc comment. Set only when
   * replaying a schedule's already-persisted `queuedRuns[].workflowId` via
   * `drainQueuedScheduleRun()`; every other schedule-run start (a fresh cadence tick,
   * a `cancel-running` replacement) omits it and gets strict id admission.
   */
  startWorkflow: (
    type: string,
    input: unknown,
    options: { id: string },
    additionalStartOperations?: BatchOperation[],
    revisionOverride?: string,
    skipAdmissionIdCheck?: boolean,
  ) => Promise<void>;
  loadWorkflowState: (workflowId: string) => Promise<WorkflowState | null | undefined>;
  cancelWorkflow: (workflowId: string) => Promise<void>;
  getWorkflowResult: (workflowId: string) => Promise<unknown>;
  refreshScheduledWorkflowState: (state: ScheduleState) => Promise<RefreshedScheduleState>;
  startScheduledRun: (state: ScheduleState, options?: ScheduledRunStartOptions) => Promise<string>;
  applyScheduleOccurrence: (state: ScheduleState, occurrence?: number) => Promise<ScheduleState>;
  settleBackfillScheduleState: (state: ScheduleState) => Promise<ScheduleState>;
  flushQueuedInlineWorkflowStartsDirectly: () => Promise<void>;
  failWorkflow: (workflowId: string, error: Error) => Promise<void>;
  handleCleanupError: (source: string, error: unknown, workflowId: string) => void;
};

export async function schedule(
  internals: EngineInternals,
  type: string,
  input: unknown,
  spec: string | ScheduleSpec,
  options?: ScheduleOptions,
): Promise<ScheduleHandle> {
  // Validate the caller-supplied `spec`/`options` BEFORE ever touching a
  // `registerSource()`-registered type's loader below — both are pure,
  // synchronous, and cheap, so a malformed schedule spec or option set
  // throws immediately instead of after paying for (and single-flight
  // installing the result of) a dynamic-source load whose work this call
  // is about to discard anyway.
  const normalizedSpec = normalizeScheduleSpec(spec);
  const normalizedOptions = normalizeScheduleOptions(options);
  const scheduleId = normalizedOptions.id ?? crypto.randomUUID();
  const revisionPolicy = normalizedOptions.revisionPolicy ?? 'active-at-fire';
  const pinnedRevision = await resolveScheduleCreationRevision(internals, type, revisionPolicy);
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
      ...(normalizedOptions.description !== undefined && {
        description: normalizedOptions.description,
      }),
      ...cadenceFields,
      status: 'active',
      overlap: normalizedOptions.overlap,
      backfill: normalizedOptions.backfill,
      ...(normalizedOptions.jitterMs !== undefined && { jitterMs: normalizedOptions.jitterMs }),
      revisionPolicy,
      ...(pinnedRevision !== undefined && { pinnedRevision }),
      createdAt: now,
      updatedAt: now,
      nextFireAt: getNextScheduleOccurrence({ ...cadenceFields, createdAt: now }, now),
      missedFireCount: 0,
      skippedCount: 0,
      queuedRuns: [],
    };
    await writeScheduleState(
      internals,
      state,
      await buildPinnedRevisionWriteOptions(internals, type, pinnedRevision),
    );
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
    items.push(toScheduleSummary(state));
  }

  return paginateScheduleSummaries(items, normalizedFilter);
}

export async function recoverOrphanedScheduleTimers(internals: EngineInternals): Promise<void> {
  for await (const [key, value] of internals.storage.scan('schedule:')) {
    const scheduleKeySuffix = key.slice('schedule:'.length);
    if (scheduleKeySuffix.includes(':')) continue;

    const state = decodeScheduleState(value);
    if (!isActiveScheduleWithTimer(state)) continue;

    if (await hasCurrentScheduleTimer(internals, state)) continue;

    await writeScheduleState(internals, state);
  }
}

function isActiveScheduleWithTimer(
  state: ScheduleState | null,
): state is ScheduleState & { nextFireAt: number } {
  return state?.status === 'active' && state.nextFireAt !== null;
}

async function hasCurrentScheduleTimer(
  internals: EngineInternals,
  state: ScheduleState & { nextFireAt: number },
): Promise<boolean> {
  const timerKey = KEYS.scheduleTick(
    resolveEffectiveScheduleFireAt(state, state.nextFireAt),
    state.id,
  );
  const timerBytes = await internals.storage.get(timerKey);
  if (timerBytes === null) {
    return false;
  }

  const timerIndexBytes = await internals.storage.get(
    `timer-idx:${createScheduleTimerId(state.id)}`,
  );
  return timerIndexBytes !== null && decode(timerIndexBytes) === timerKey;
}

export function toScheduleSummary(state: ScheduleState): ScheduleSummary {
  const { input: _input, ...summary } = state;
  const projectedSummary = {
    ...summary,
    queuedRuns: summary.queuedRuns.map((queuedRun) => ({ ...queuedRun })),
  } satisfies ScheduleSummary;
  return projectedSummary;
}

/**
 * Project a caller-supplied {@link ScheduleTransitionOptions} onto the subset
 * of {@link writeScheduleState}'s options it forwards to. Built with
 * conditional spreads — rather than `{ additionalOperations:
 * options?.additionalOperations, ... }` — because `exactOptionalPropertyTypes`
 * forbids assigning an explicit `undefined` to an optional property whose type
 * does not itself include `undefined`; omitting an absent key entirely is the
 * only way to pass an "unset" option through untyped.
 */
function scheduleTransitionWriteOptions(options: ScheduleTransitionOptions | undefined): {
  additionalOperations?: BatchOperation[];
  extraConditions?: ConditionalBatchCondition[];
  onExtraConditionsLost?: () => Error;
} {
  return {
    ...(options?.additionalOperations !== undefined && {
      additionalOperations: options.additionalOperations,
    }),
    ...(options?.extraConditions !== undefined && {
      extraConditions: options.extraConditions,
    }),
    ...(options?.onExtraConditionsLost !== undefined && {
      onExtraConditionsLost: options.onExtraConditionsLost,
    }),
  };
}

/**
 * `options` (COR-67) lets a caller keeping its own durable projection in step
 * with the engine's schedule state fold `additionalOperations`/`extraConditions`
 * into this SAME storage commit — see {@link ScheduleTransitionOptions}. Every
 * existing caller passes neither and gets byte-for-byte the pre-COR-67 commit
 * shape.
 */
export async function pauseSchedule(
  internals: EngineInternals,
  scheduleId: string,
  options?: ScheduleTransitionOptions,
): Promise<void> {
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
    queuedRuns: [],
  };
  await writeScheduleState(internals, updatedState, {
    includeTimer: false,
    ...scheduleTransitionWriteOptions(options),
  });
}

/** `options` (COR-67) — see {@link pauseSchedule}'s doc comment. */
export async function resumeSchedule(
  internals: EngineInternals,
  scheduleId: string,
  options?: ScheduleTransitionOptions,
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
  await writeScheduleState(internals, updatedState, {
    ...scheduleTransitionWriteOptions(options),
  });
}

/** `options` (COR-67) — see {@link pauseSchedule}'s doc comment. */
export async function cancelSchedule(
  internals: EngineInternals,
  scheduleId: string,
  options?: ScheduleTransitionOptions,
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
    queuedRuns: [],
  };
  await writeScheduleState(internals, updatedState, {
    includeTimer: false,
    ...scheduleTransitionWriteOptions(options),
  });
}

export async function updateSchedule(
  internals: EngineInternals,
  scheduleId: string,
  newSpec: string | ScheduleSpec,
  options?: ScheduleUpdateOptions,
): Promise<void> {
  const normalizedScheduleId = coerceScheduleId(scheduleId, 'scheduleId');
  const normalizedSpec = normalizeScheduleSpec(newSpec);
  const normalizedOptions = normalizeScheduleUpdateOptions(options);
  await runSerializedScheduleStateOperation(internals, normalizedScheduleId, async () => {
    const state = await requireScheduleState(internals, normalizedScheduleId);
    const now = internals.options.getNow();
    // Replace the cadence wholesale so switching kinds (cron <-> interval) never
    // leaves a stale field behind. Interval cadence re-anchors at the update time.
    // Strip both cadence fields, and `pinnedRevision`, from the carried-over
    // state first, then attach only what the new spec/revision decision
    // selects (exactOptionalPropertyTypes forbids carrying an explicit
    // `undefined`).
    const {
      cronExpression: _droppedCron,
      intervalMs: _droppedInterval,
      pinnedRevision: _droppedPinnedRevision,
      ...stateWithoutCadenceOrPin
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
    // Omitting `revisionPolicy` preserves the schedule's current policy AND
    // its captured pin unchanged. Passing `'pinned'` — even when already
    // pinned — always RE-resolves and re-captures against the revision
    // active RIGHT NOW; it is never a no-op. Passing `'active-at-fire'`
    // clears any previously captured pin.
    let pinnedRevision: string | undefined;
    let revisionFields: Pick<ScheduleState, 'revisionPolicy' | 'pinnedRevision'>;
    if (normalizedOptions.revisionPolicy === undefined) {
      revisionFields = {
        revisionPolicy: state.revisionPolicy,
        ...(state.pinnedRevision !== undefined && { pinnedRevision: state.pinnedRevision }),
      };
    } else if (normalizedOptions.revisionPolicy === 'pinned') {
      pinnedRevision = await resolveScheduleRevisionForPin(
        internals.engine as unknown as Engine,
        internals,
        state.workflowType,
      );
      revisionFields = { revisionPolicy: 'pinned', pinnedRevision };
    } else {
      revisionFields = { revisionPolicy: 'active-at-fire' };
    }
    const updatedState: ScheduleState = {
      ...stateWithoutCadenceOrPin,
      ...normalizedOptions,
      ...cadenceFields,
      ...anchorFields,
      ...revisionFields,
      updatedAt: now,
      nextFireAt:
        state.status === 'cancelled'
          ? null
          : getNextScheduleOccurrence({ ...cadenceFields, createdAt: now }, now),
    };
    await writeScheduleState(internals, updatedState, {
      includeTimer: state.status === 'active',
      replaceTimerFrom: state,
      ...(await buildPinnedRevisionWriteOptions(internals, state.workflowType, pinnedRevision)),
    });
  });
}
