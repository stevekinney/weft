import type { BatchOperation, ConditionalBatchCondition } from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
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
import type { EngineInternals } from './internals.ts';
import type { StartTransientState } from './lifecycle/start-transient-state.ts';
import {
  buildPinnedRevisionWriteOptions,
  resolveScheduleCreationRevision,
  updatedRevisionFields,
} from './pinned-schedule-revision.ts';
import { withoutSkip } from './schedule-controls.ts';
import { ScheduleHandle } from './schedule-handle.ts';
import type { OccurrenceCommit } from './schedule-occurrence-commit.ts';
import {
  getNextScheduleOccurrence,
  withSkippedOccurrences,
  withSkipsFrom,
} from './schedule-occurrence.ts';
import type { ScheduledRunStartOptions } from './schedule-run.ts';
import { runScheduleTransition } from './schedule-state-operations.ts';
import { survivingSkips, updatedNextFireAt } from './schedule-update-cadence.ts';
import { matchesScheduleFilter, paginateScheduleSummaries } from './state-utilities.ts';
import { writeScheduleState } from './storage-io.ts';
import { decodeScheduleState } from './validation/schedule-decode.ts';
import {
  assertCallerOwnedTransitionKeys,
  coerceExpectedScheduleRevision,
  coerceScheduleId,
  normalizeScheduleFilter,
  normalizeScheduleOptions,
  normalizeScheduleSpec,
  normalizeScheduleUpdateOptions,
  type NormalizedScheduleSpec,
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
   *
   * `transientState` (internal only) is threaded straight through to `startWorkflow`'s parameter
   * of the same name: the occurrence's resolved services, and the run's membership in terminal
   * cleanup, which `startWorkflow` installs when its launch adopts the id.
   *
   * `startConditions` (COR-1829) makes the start batch conditional on them, as an idempotent
   * start's mapping is: a run now commits its run only while the schedule key still holds the
   * bytes it decided from, so another engine's change makes the start fail and nothing launches.
   */
  startWorkflow: (
    type: string,
    input: unknown,
    options: { id: string; tags?: string[] },
    additionalStartOperations?: BatchOperation[],
    revisionOverride?: string,
    skipAdmissionIdCheck?: boolean,
    transientState?: StartTransientState,
    startConditions?: ConditionalBatchCondition[],
  ) => Promise<void>;
  loadWorkflowState: (workflowId: string) => Promise<WorkflowState | null | undefined>;
  cancelWorkflow: (workflowId: string) => Promise<void>;
  getWorkflowResult: (workflowId: string) => Promise<unknown>;
  refreshScheduledWorkflowState: (state: ScheduleState) => Promise<RefreshedScheduleState>;
  startScheduledRun: (state: ScheduleState, options?: ScheduledRunStartOptions) => Promise<string>;
  applyScheduleOccurrence: (
    state: ScheduleState,
    occurrence: number | undefined,
    manual: true | undefined,
    commit: OccurrenceCommit,
  ) => Promise<ScheduleState>;
  flushQueuedInlineWorkflowStartsDirectly: () => Promise<void>;
  failWorkflow: (workflowId: string, error: Error) => Promise<void>;
  handleCleanupError: (source: string, error: unknown, workflowId: string) => void;
};

/**
 * The time zone a schedule is read in: the one the caller named, else the one it keeps
 * (`current`), else UTC. An interval schedule counts elapsed time, so it has no zone to name and is
 * always read as UTC (naming `UTC` is accepted so a view round-trips).
 */
function resolveScheduleTimeZone(
  spec: NormalizedScheduleSpec,
  named: string | undefined,
  current: string | undefined,
): string {
  if (spec.kind === 'interval') {
    // `UTC` is the zone an interval schedule reports, so a caller that sends a view back unchanged
    // is not refused; any other zone would imply a calendar the schedule does not have.
    if (named !== undefined && named !== 'UTC') {
      throw new Error(
        'options.timeZone applies only to a cron schedule; an interval schedule counts elapsed time and accepts only UTC',
      );
    }
    return 'UTC';
  }
  return named ?? current ?? 'UTC';
}

/** The description and metadata a schedule is created with, each only when the caller gave one. */
function pickScheduleLabels(options: {
  description?: string;
  metadata?: Record<string, unknown>;
}): Pick<ScheduleState, 'description' | 'metadata'> {
  return {
    ...(options.description !== undefined && { description: options.description }),
    ...(options.metadata !== undefined && { metadata: options.metadata }),
  };
}

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
    const timeZone = resolveScheduleTimeZone(normalizedSpec, normalizedOptions.timeZone, undefined);
    const state: ScheduleState = {
      id: scheduleId,
      workflowType: type,
      input,
      ...pickScheduleLabels(normalizedOptions),
      ...cadenceFields,
      timeZone,
      status: normalizedOptions.initialStatus ?? 'active',
      overlap: normalizedOptions.overlap,
      backfill: normalizedOptions.backfill,
      ...(normalizedOptions.jitterMs !== undefined && { jitterMs: normalizedOptions.jitterMs }),
      revisionPolicy,
      ...(pinnedRevision !== undefined && { pinnedRevision }),
      revision: 1,
      createdAt: now,
      updatedAt: now,
      nextFireAt: getNextScheduleOccurrence({ ...cadenceFields, timeZone, createdAt: now }, now),
      missedFireCount: 0,
      skippedCount: 0,
      queuedRuns: [],
    };
    await writeScheduleState(internals, state, {
      ...(await buildPinnedRevisionWriteOptions(internals, type, pinnedRevision)),
      includeTimer: state.status === 'active',
    });
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

export function toScheduleSummary(state: ScheduleState): ScheduleSummary {
  const { input: _input, ...summary } = state;
  const projectedSummary = {
    ...summary,
    queuedRuns: summary.queuedRuns.map((queuedRun) => ({ ...queuedRun })),
  } satisfies ScheduleSummary;
  return projectedSummary;
}

/**
 * A write's pinned-revision fence (WFT-20), if it has one, with the conditions on the bytes the
 * write was decided from (COR-1594) ahead of it. The read conditions are judged first and never
 * reach the fence's typed error.
 */
function withReadConditions(
  readConditions: ConditionalBatchCondition[],
  pinned:
    | { extraConditions: ConditionalBatchCondition[]; onExtraConditionsLost: () => Error }
    | undefined,
): { extraConditions?: ConditionalBatchCondition[]; onExtraConditionsLost?: () => Error } {
  const extraConditions = [...readConditions, ...(pinned?.extraConditions ?? [])];
  return {
    ...(extraConditions.length > 0 && { extraConditions }),
    ...(pinned !== undefined && { onExtraConditionsLost: pinned.onExtraConditionsLost }),
  };
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
export function scheduleTransitionWriteOptions(
  options: ScheduleTransitionOptions | undefined,
  readConditions: ConditionalBatchCondition[],
): {
  additionalOperations?: BatchOperation[];
  extraConditions?: ConditionalBatchCondition[];
  onExtraConditionsLost?: () => Error;
} {
  const extraConditions = [...readConditions, ...(options?.extraConditions ?? [])];
  return {
    ...(options?.additionalOperations !== undefined && {
      additionalOperations: options.additionalOperations,
    }),
    ...(extraConditions.length > 0 && { extraConditions }),
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
 *
 * COR-1482: pause, resume, and cancel run inside the schedule's serialized write, as the timer
 * callback and `updateSchedule` do, so `options.expectedRevision` is compared against the state
 * the write is made from. A pause counts as a change to the schedule (`revision` goes up by one)
 * only when the schedule was active.
 *
 * COR-1594: the write is also conditioned on the exact bytes the transition read, so the
 * one-winner rule for `expectedRevision` holds across engine processes that share a store, not
 * only within one: of two transitions naming the same revision, the one whose write loses re-reads
 * and is refused with {@link ScheduleStaleRevisionError}. See {@link runScheduleTransition}.
 */
export async function pauseSchedule(
  internals: EngineInternals,
  scheduleId: string,
  options?: ScheduleTransitionOptions,
): Promise<void> {
  const normalizedScheduleId = coerceScheduleId(scheduleId, 'scheduleId');
  const expectedRevision = coerceExpectedScheduleRevision(options?.expectedRevision);
  assertCallerOwnedTransitionKeys(normalizedScheduleId, options);
  await runScheduleTransition(
    internals,
    normalizedScheduleId,
    expectedRevision,
    async (state, readConditions) => {
      if (state.status !== 'active') return;
      const now = internals.options.getNow();
      // A pause keeps the occurrences a person skipped (COR-2018): they are runs of the cadence,
      // and a resume that reaches them honors them.
      const updatedState: ScheduleState = {
        ...state,
        status: 'paused',
        revision: state.revision + 1,
        updatedAt: now,
        nextFireAt: getNextScheduleOccurrence(state, now),
        queuedRuns: [],
      };
      // The timer goes in the guarded write itself (COR-1594), so a transition that is refused,
      // by the caller's own conditions or by a failed write, leaves the timer where it was.
      await writeScheduleState(internals, updatedState, {
        includeTimer: false,
        replaceTimerFrom: state,
        ...scheduleTransitionWriteOptions(options, readConditions),
      });
    },
  );
}

/** `options` (COR-67, COR-1482) — see {@link pauseSchedule}'s doc comment. */
export async function resumeSchedule(
  internals: EngineInternals,
  scheduleId: string,
  options?: ScheduleTransitionOptions,
): Promise<void> {
  const normalizedScheduleId = coerceScheduleId(scheduleId, 'scheduleId');
  const expectedRevision = coerceExpectedScheduleRevision(options?.expectedRevision);
  assertCallerOwnedTransitionKeys(normalizedScheduleId, options);
  await runScheduleTransition(
    internals,
    normalizedScheduleId,
    expectedRevision,
    async (state, readConditions) => {
      if (state.status === 'cancelled') {
        throw new Error(
          `Schedule "${normalizedScheduleId}" has been cancelled and cannot be resumed`,
        );
      }
      if (state.status === 'active') return;
      const now = internals.options.getNow();
      const nextFireAt = getNextScheduleOccurrence(state, now);
      // The skips the pause kept that are still ahead stay; those it slept through are spent.
      const updatedState: ScheduleState = {
        ...withSkipsFrom(state, nextFireAt),
        status: 'active',
        revision: state.revision + 1,
        updatedAt: now,
        nextFireAt,
      };
      await writeScheduleState(internals, updatedState, {
        ...scheduleTransitionWriteOptions(options, readConditions),
      });
    },
  );
}

/**
 * `options` (COR-67, COR-1482) — see {@link pauseSchedule}'s doc comment. Cancelling a schedule
 * that is already cancelled still commits the caller's `additionalOperations`, and changes nothing
 * about the schedule, so its `revision` stays.
 */
export async function cancelSchedule(
  internals: EngineInternals,
  scheduleId: string,
  options?: ScheduleTransitionOptions,
): Promise<void> {
  const normalizedScheduleId = coerceScheduleId(scheduleId, 'scheduleId');
  const expectedRevision = coerceExpectedScheduleRevision(options?.expectedRevision);
  assertCallerOwnedTransitionKeys(normalizedScheduleId, options);
  await runScheduleTransition(
    internals,
    normalizedScheduleId,
    expectedRevision,
    async (state, readConditions) => {
      const updatedState: ScheduleState = {
        ...withoutSkip(state),
        status: 'cancelled',
        revision: state.status === 'cancelled' ? state.revision : state.revision + 1,
        updatedAt: internals.options.getNow(),
        nextFireAt: null,
        queuedRuns: [],
      };
      // As for a pause, the timer of an active schedule goes in the guarded write.
      await writeScheduleState(internals, updatedState, {
        includeTimer: false,
        ...(state.status === 'active' && { replaceTimerFrom: state }),
        ...scheduleTransitionWriteOptions(options, readConditions),
      });
    },
  );
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
  const expectedRevision = coerceExpectedScheduleRevision(options?.expectedRevision);
  await runScheduleTransition(
    internals,
    normalizedScheduleId,
    expectedRevision,
    async (state, readConditions) => {
      const now = internals.options.getNow();
      // Replace the cadence wholesale so switching kinds (cron <-> interval) never
      // leaves a stale field behind. Interval cadence re-anchors at the update time, unless the
      // interval is the one it already has (COR-1985): then the grid and the next run stay put.
      // Strip both cadence fields, and `pinnedRevision`, from the carried-over
      // state first, then attach only what the new spec/revision decision
      // selects (exactOptionalPropertyTypes forbids carrying an explicit
      // `undefined`).
      const {
        cronExpression: _droppedCron,
        intervalMs: _droppedInterval,
        pinnedRevision: _droppedPinnedRevision,
        // Kept below only where they are still upcoming runs of the updated cadence.
        skippedOccurrences: _droppedSkips,
        ...stateWithoutCadenceOrPin
      } = state;
      const cadenceFields =
        normalizedSpec.kind === 'interval'
          ? { intervalMs: normalizedSpec.intervalMs }
          : { cronExpression: normalizedSpec.cronExpression };
      // Omitting `timeZone` keeps the schedule's zone; a new interval cadence has none to keep.
      const timeZone = resolveScheduleTimeZone(
        normalizedSpec,
        normalizedOptions.timeZone,
        state.timeZone,
      );
      // For interval specs the occurrence grid is anchored at `createdAt`. Re-anchor
      // to `now` (the update time) so the timer's subsequent `getNextScheduleOccurrence`
      // calls use the same origin as the `nextFireAt` computed here. Without this,
      // the first fire after the update is correct but later fires drift back to the
      // original creation-time grid. An update that leaves the interval as it is has no new grid
      // to anchor: it keeps the anchor, and an active schedule keeps the run it was waiting for,
      // so what a person skipped, and a run that is due, are not moved by an edit to the
      // description. The engine whose tick stood aside from that run counts the lateness of the
      // delivery that follows from that tick (COR-1998).
      const keepsIntervalGrid =
        normalizedSpec.kind === 'interval' && state.intervalMs === normalizedSpec.intervalMs;
      const anchor = keepsIntervalGrid ? state.createdAt : now;
      const anchorFields =
        normalizedSpec.kind === 'interval' && !keepsIntervalGrid ? { createdAt: now } : {};
      const workflowType = normalizedOptions.workflowType ?? state.workflowType;
      const { revisionFields, pinnedRevision } = await updatedRevisionFields(
        internals,
        state,
        workflowType,
        normalizedOptions.revisionPolicy,
      );
      const updatedState: ScheduleState = {
        ...stateWithoutCadenceOrPin,
        ...normalizedOptions,
        ...cadenceFields,
        timeZone,
        ...anchorFields,
        ...revisionFields,
        revision: state.revision + 1,
        updatedAt: now,
        nextFireAt: updatedNextFireAt(state, keepsIntervalGrid, () =>
          getNextScheduleOccurrence({ ...cadenceFields, timeZone, createdAt: anchor }, now),
        ),
      };
      const skipped = survivingSkips(internals, state, updatedState, now);
      await writeScheduleState(internals, withSkippedOccurrences(updatedState, skipped), {
        includeTimer: state.status === 'active',
        replaceTimerFrom: state,
        ...withReadConditions(
          readConditions,
          await buildPinnedRevisionWriteOptions(internals, workflowType, pinnedRevision),
        ),
      });
    },
  );
}
