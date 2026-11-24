import type { BatchOperation, ConditionalBatchCondition } from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import { encode } from '../codec.ts';
import { ScheduleFiredEvent } from '../events.ts';
import type { ScheduleState } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { unavailableServicesError } from './lifecycle/recovered-services.ts';
import { EMPTY_STORAGE_VALUE } from './lifecycle/shared.ts';
import type { StartTransientState } from './lifecycle/start-transient-state.ts';
import { buildPinnedRevisionOverride } from './schedule-revision-fire.ts';
import { encodeScheduleRunMetadata } from './schedule-run-metadata.ts';
import type { ScheduleCallbacks } from './schedules.ts';

/** What {@link resolveScheduledRunServices} reports for one occurrence. */
type ScheduledRunServicesResolution =
  { status: 'available'; services: unknown } | { status: 'unavailable'; reason: string };

/**
 * The tag every run a schedule fire starts carries (COR-1902): `origin:schedule`, the spelling
 * Bureau gives a task of that origin (`origin:<kind>`), so `engine.list({ tags })` finds a schedule's
 * runs. It rides in the run's start options, so it is written in the same create batch as the
 * run and the schedule record that names it, and a crash cannot leave a fired run without it.
 */
export const SCHEDULE_ORIGIN_TAG = 'origin:schedule';

export type ScheduledRunStartOptions = {
  occurrence?: number;
  /** Present and `true` for a run a person triggered by hand (`engine.triggerSchedule`). */
  manual?: true;
  /** Reserved queue identity. A fresh id is minted when omitted. */
  workflowId?: string;
  /** Schedule state committed atomically with the workflow start. */
  scheduleStateAfterStart?: ScheduleState;
  /**
   * What goes in the same batch as `scheduleStateAfterStart` besides the record itself (COR-1925):
   * the schedule's timer swap and the rows a tick records, which land with the run or not at all.
   */
  scheduleStateOperations?: BatchOperation[];
  /** Prior terminal run whose transient schedule metadata is now settled. */
  completedWorkflowId?: string;
  /**
   * Conditions the start batch commits under (COR-1829): a run now passes the condition that the
   * schedule key still holds the bytes it decided from, with `scheduleStateAfterStart`, so the run
   * and the schedule that names it land together or not at all.
   */
  startConditions?: ConditionalBatchCondition[];
  /**
   * Internal only (WFT-95). Set by `drainQueuedScheduleRun()` when `workflowId`
   * is a persisted `queuedRuns[].workflowId` being replayed, not a freshly
   * minted one — safe unconditionally, since a post-fix queued run was already
   * validated as non-`.`/`..` at schedule-admission time (relaxing the check
   * here is then a no-op), and it is what lets a legacy pre-WFT-95 queued run
   * whose id is `.`/`..` keep draining instead of pausing the schedule.
   * Threaded straight through to `startWorkflow`'s `skipAdmissionIdCheck`.
   */
  skipAdmissionIdCheck?: boolean;
};

/**
 * Launch one scheduled occurrence's workflow run and emit `schedule:fired`.
 *
 * This is the single chokepoint every occurrence launch flows through — initial
 * cadence ticks, `cancel-running` replacements, and `queue`-drained runs — so it
 * is the one place that reliably holds the launched `workflowId` across all
 * overlap policies. The blocked policies (`skip`, and `queue` while a run is
 * active) never reach here, so they correctly do not fire.
 *
 * `occurrence` is the scheduled grid timestamp the run was due, threaded from the
 * timer loop or retained on its durable queue entry until drain.
 */
export async function startScheduledRun(
  internals: EngineInternals,
  state: ScheduleState,
  callbacks: Pick<ScheduleCallbacks, 'startWorkflow' | 'failWorkflow' | 'handleCleanupError'>,
  options: ScheduledRunStartOptions = {},
): Promise<string> {
  const workflowId = options.workflowId ?? crypto.randomUUID();
  const occurrence = options.occurrence;
  const manual = options.manual;
  // Whether the occurrence resolves services is known without resolving them, and the marker that
  // says so goes in the start batch. The resolver itself runs once that batch has committed
  // (COR-1925): a start that loses its condition to another engine never launches, and must not
  // leave a task admission or a `schedule.fired` audit entry for a run that never exists.
  const resolves = scheduledRunResolvesServices(internals);
  const resolved: { resolution?: ScheduledRunServicesResolution } = {};
  const scheduleRunOperations = buildScheduledRunOperations(state, workflowId, options, resolves);

  // Put nothing in engine memory here. Every scheduled run writes `schedule-run` metadata, and
  // the inline start can complete before this function resumes after the await, so the run must
  // join terminal cleanup: the in-memory membership is what makes completion schedule the deferred
  // durable cleanup timer that sweeps that metadata if the fire-and-forget scheduled-terminal
  // handler is interrupted. Membership goes to `startWorkflow` as its internal `transientState`,
  // which installs it when its launch adopts the id, before the create batch commits, so a cancel
  // or timeout that lands while the batch commits already finds it. The launch removes it again if
  // it is rejected after it adopted a checkpoint. A start rejected before that has installed
  // nothing, so there is nothing to take back, and the id, which may by then belong to another
  // launch, is never touched. The run's services are not resolved yet: `transientState` carries the
  // resolver, which `startWorkflow` calls once the create batch has committed (COR-1925).
  //
  // An empty array and `undefined` are equivalent at the receiving end
  // (buildStartBatchOperations spreads `?? []`), so pass the array directly.
  // `buildPinnedRevisionOverride` is `undefined` for an `'active-at-fire'`
  // schedule — every non-pinned occurrence launches byte-for-byte the
  // pre-WFT-20 way.
  await callbacks.startWorkflow(
    state.workflowType,
    state.input,
    { id: workflowId, tags: [SCHEDULE_ORIGIN_TAG] },
    scheduleRunOperations,
    buildPinnedRevisionOverride(state),
    options.skipAdmissionIdCheck,
    buildScheduledRunTransientState(
      resolves
        ? async () => {
            const resolution = await resolveScheduledRunServices(
              internals,
              workflowId,
              state,
              occurrence,
              manual,
            );
            resolved.resolution = resolution;
            return resolution.status === 'available' ? { value: resolution.services } : undefined;
          }
        : undefined,
    ),
    options.startConditions,
  );

  // The run launched, so the occurrence fired. Emit before the unavailable
  // check: a services failure becomes a separate `workflow:failed`, and the
  // natural causal order is fired -> failed. A `startWorkflow` throw skips this
  // (nothing launched).
  internals.engine.dispatchEvent(
    new ScheduleFiredEvent(state.id, workflowId, internals.options.getNow(), occurrence),
  );

  const resolution = resolved.resolution;
  if (resolution?.status === 'unavailable') {
    // Services unavailable — fail only this occurrence. The schedule timer handler
    // wraps applyScheduleOccurrence in a try/catch that pauses the whole schedule on
    // error; an individual occurrence's resolver failure must not escape there.
    // The run was just started (status 'running') and is in the inline launch queue;
    // failing it here sets status to 'failed' so the queue's status check skips the body.
    const unavailableError = unavailableServicesError(workflowId, resolution.reason);
    try {
      await callbacks.failWorkflow(workflowId, unavailableError);
    } catch (error) {
      callbacks.handleCleanupError('startScheduledRun', error, workflowId);
    }
  }

  return workflowId;
}

/** The operations a scheduled run's start batch carries besides the workflow record itself. */
function buildScheduledRunOperations(
  state: ScheduleState,
  workflowId: string,
  options: ScheduledRunStartOptions,
  resolves: boolean,
): BatchOperation[] {
  const metadata = encodeScheduleRunMetadata(state.id, options.occurrence, options.manual);
  const scheduleRunOperations: BatchOperation[] = [
    {
      type: 'put',
      key: KEYS.scheduleRun(workflowId),
      value: metadata,
    },
    {
      type: 'put',
      key: KEYS.scheduleRunLink(workflowId),
      value: metadata,
    },
    {
      type: 'put',
      key: KEYS.scheduleRunBySchedule(state.id, workflowId),
      value: EMPTY_STORAGE_VALUE,
    },
    {
      type: 'put',
      key: KEYS.terminalCleanupNeeded(workflowId),
      value: EMPTY_STORAGE_VALUE,
    },
  ];

  if (options.scheduleStateAfterStart !== undefined) {
    scheduleRunOperations.push({
      type: 'put',
      key: KEYS.schedule(options.scheduleStateAfterStart.id),
      value: encode(options.scheduleStateAfterStart),
    });
  }
  scheduleRunOperations.push(...(options.scheduleStateOperations ?? []));
  if (options.completedWorkflowId !== undefined) {
    scheduleRunOperations.push({
      type: 'delete',
      key: KEYS.scheduleRun(options.completedWorkflowId),
    });
  }

  if (resolves) {
    // Write the "expects services" marker atomically with the workflow record.
    // This mirrors startWorkflow's buildPerRunScratchOperations path and is
    // required for both the available and unavailable cases so a fresh-process
    // recovery can tell "never had services" from "had services".
    scheduleRunOperations.push({
      type: 'put',
      key: KEYS.workflowHasServices(workflowId),
      value: EMPTY_STORAGE_VALUE,
    });
  }
  return scheduleRunOperations;
}

/**
 * What the occurrence hands `startWorkflow`: membership in terminal cleanup, which every scheduled
 * run owes, and the resolver of its services when it has one.
 */
function buildScheduledRunTransientState(
  resolveServices: StartTransientState['resolveServices'],
): StartTransientState {
  return {
    joinTerminalCleanup: true,
    ...(resolveServices !== undefined && { resolveServices }),
  };
}

/**
 * Whether an occurrence resolves workflow services: the engine has a `resolveWorkflowServices`
 * resolver and is in inline execution mode. Decided without calling the resolver, because the
 * "expects services" marker it implies goes in the start batch, and the resolver runs after.
 */
function scheduledRunResolvesServices(internals: EngineInternals): boolean {
  return internals.inlineStrategy !== null && Boolean(internals.options.resolveWorkflowServices);
}

/**
 * Resolve workflow services for a scheduled occurrence. Resolver throws are coerced to unavailable
 * to prevent a single occurrence fault from escaping into the schedule timer handler's error
 * boundary. Called only once the occurrence's run has committed and when
 * {@link scheduledRunResolvesServices} holds.
 */
async function resolveScheduledRunServices(
  internals: EngineInternals,
  workflowId: string,
  state: ScheduleState,
  occurrence: number | undefined,
  manual: true | undefined,
): Promise<ScheduledRunServicesResolution> {
  const resolver = internals.options.resolveWorkflowServices;
  if (!resolver) return { status: 'unavailable', reason: 'no services resolver is configured' };
  try {
    return await resolver({
      workflowId,
      workflowType: state.workflowType,
      input: state.input,
      launchOptions: { id: workflowId, tags: [SCHEDULE_ORIGIN_TAG] },
      schedule: {
        id: state.id,
        ...(occurrence !== undefined ? { occurrence } : {}),
        ...(manual === true ? { manual } : {}),
      },
    });
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
