import type { Duration } from './retry-retention.ts';
import type { WorkflowDefinition } from './workflow-function.ts';

// ---------------------------------------------------------------------------
// Recurring schedule state
// ---------------------------------------------------------------------------

/**
 * Lifecycle state of a recurring schedule managed by {@link Engine.schedule}.
 * `'active'` fires on cron cadence; `'paused'` skips upcoming runs without
 * deleting the schedule; `'cancelled'` is the terminal removed state.
 */
export type ScheduleStatus = 'active' | 'paused' | 'cancelled';

/**
 * Behaviour when a scheduled cron tick fires while a previous run is still
 * active. `'skip'` drops the new run; `'queue'` buffers it; `'cancel-running'`
 * cancels the active workflow and starts fresh; `'allow'` starts both
 * concurrently. Pass via {@link ScheduleOptions.overlap}.
 *
 * @example
 * ```ts
 * import { workflow, Engine, type ScheduleOverlapPolicy } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.register(workflow({ name: 'hourly' }).execute(async function* () { return 'done'; }));
 * const policy: ScheduleOverlapPolicy = 'skip';
 * await engine.schedule('hourly', null, '0 * * * *', { overlap: policy });
 * ```
 */
export type ScheduleOverlapPolicy = 'skip' | 'queue' | 'cancel-running' | 'allow';

/**
 * Which persisted workflow revision a schedule's future occurrences resolve
 * against (WFT-20). `'active-at-fire'` (the default) resolves whatever
 * revision is currently active at the moment each occurrence fires — this is
 * the schedule's pre-WFT-20 behavior, unchanged. `'pinned'` captures the
 * revision that would run right now at create/update time
 * ({@link ScheduleMetadata.pinnedRevision}) and forces every future
 * occurrence to resolve against exactly that revision, pausing the schedule
 * (see the "Scheduled runs" section of `guides/workflow-revisions.md`)
 * if that revision later becomes unavailable rather than silently falling
 * back to whatever is active.
 *
 * @example
 * ```ts
 * import type { ScheduleRevisionPolicy } from '@lostgradient/weft';
 *
 * const policy: ScheduleRevisionPolicy = 'pinned';
 * void policy;
 * ```
 */
export type ScheduleRevisionPolicy = 'active-at-fire' | 'pinned';

/**
 * One occurrence waiting behind the active run of a `queue` overlap schedule.
 * `workflowId` is reserved when the occurrence enters the durable queue and is
 * used when it eventually starts. No workflow record exists for that id until
 * the queue drains, so `engine.get(workflowId)` returns `null` while it waits.
 *
 * @example
 * ```ts
 * import type { ScheduleQueuedRun } from '@lostgradient/weft';
 *
 * const queuedRun: ScheduleQueuedRun = {
 *   workflowId: 'daily-report-queued-1',
 *   queuedAt: Date.now(),
 * };
 * void queuedRun;
 * ```
 */
export interface ScheduleQueuedRun {
  workflowId: string;
  queuedAt: number;
  /** Nominal cadence timestamp retained from the occurrence that was queued. */
  occurrence?: number;
  /**
   * Present and `true` when a person triggered this run by hand (see {@link Engine.triggerSchedule})
   * rather than the cadence. It travels to the run's schedule metadata when the queue drains.
   */
  manual?: true;
}

/**
 * Recurrence specification for a schedule. A schedule fires either on a cron
 * cadence (`{ cron: '0 9 * * *' }`) or at a fixed interval
 * (`{ every: '1h' }`). Exactly one of `cron` or `every` must be supplied.
 *
 * Interval schedules are anchored at the schedule's creation time and fire one
 * `every` period later, then every period after that. They reuse the same
 * overlap and backfill machinery as cron schedules.
 *
 * @example
 * ```ts
 * import type { ScheduleSpec } from '@lostgradient/weft';
 *
 * const cronSpec: ScheduleSpec = { cron: '0 9 * * *' };
 * const intervalSpec: ScheduleSpec = { every: '1h' };
 * void [cronSpec, intervalSpec];
 * ```
 */
export type ScheduleSpec = { cron: string; every?: never } | { every: Duration; cron?: never };

/**
 * Options accepted by {@link Engine.schedule}. `id` assigns a deterministic
 * schedule identifier; `overlap` controls what happens when a tick fires while a
 * previous run is still active; `backfill` controls missed ticks after downtime;
 * `jitter` deterministically spreads each occurrence's effective dispatch time.
 * `description` stores a human-readable operator label with the schedule.
 *
 * @example
 * ```ts
 * import { workflow, Engine, type ScheduleOptions } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.register(workflow({ name: 'report' }).execute(async function* () { return 'ok'; }));
 * const options: ScheduleOptions = {
 *   id: 'daily-report',
 *   overlap: 'skip',
 *   backfill: false,
 *   jitter: '30s',
 *   description: 'Generate the daily report',
 * };
 * const handle = await engine.schedule('report', null, '0 9 * * *', options);
 * void handle;
 * ```
 */
export interface ScheduleOptions {
  /** Persist a schedule without arming its timer until an explicit resume. */
  initialStatus?: 'active' | 'paused';
  id?: string;
  /** Human-readable operator description stored with this schedule. */
  description?: string;
  overlap?: ScheduleOverlapPolicy;
  /**
   * When `false` (the default), an occurrence the scheduler reaches more than
   * one second plus one scheduler poll interval
   * (the engine's `schedulerPollIntervalMs`) late is skipped
   * instead of backfilled. An occurrence the next poll tick reaches is never
   * skipped for the lateness that polling itself introduces. Skipped ticks increment
   * {@link ScheduleState.missedFireCount}, update
   * {@link ScheduleState.lastMissedFireAt}, and emit a
   * `ScheduleMissedFireEvent`.
   *
   * When `true`, missed ticks are processed immediately, up to the engine's
   * per-tick backfill cap.
   */
  backfill?: boolean;
  /**
   * Deterministic per-occurrence delay applied to the effective dispatch timer.
   * The persisted {@link ScheduleState.nextFireAt} remains the nominal
   * pre-jitter occurrence timestamp.
   */
  jitter?: Duration;
  /**
   * The IANA time zone a cron schedule's wall-clock times are read in, such as
   * `America/Los_Angeles`, or `UTC`. Omitted, the schedule runs in UTC. Only a cron schedule
   * takes one: an interval counts elapsed time, and passing one with `every` throws.
   *
   * A wall-clock time happens once. A time the clock skips when it springs forward (a daily
   * 02:30 on that day) does not fire: the schedule counts it in
   * {@link ScheduleState.missedFireCount}, sets {@link ScheduleState.lastMissedFireAt}, and emits a
   * `ScheduleMissedFireEvent` with `reason: 'dst-gap'` when the clock reaches the end of the gap.
   * A time the clock repeats when it falls back fires only the first time, so an expression that
   * matches every minute or hour has no second pass through the repeated hour; use `every` for
   * work that must run on elapsed time.
   */
  timeZone?: string;
  /**
   * Which revision future occurrences resolve against. Defaults to
   * `'active-at-fire'`. Passing `'pinned'` captures the revision that would
   * run right now — see {@link ScheduleRevisionPolicy}. This is a
   * per-schedule revision override; `StartOptions` (a one-shot
   * `engine.start()` call) has no equivalent per-call revision override.
   */
  revisionPolicy?: ScheduleRevisionPolicy;
  /**
   * A plain JSON object the caller keeps with the schedule, such as who owns it. Weft stores it
   * whole and returns it with the schedule; it never reads it, and it is not passed to the runs
   * the schedule starts. Omitted, the schedule has none. An update replaces it whole.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Mutable options accepted when updating an existing schedule. Omitted fields
 * retain their persisted values. Schedule identity, workflow type, and input
 * are intentionally excluded.
 *
 * Omitting `revisionPolicy` preserves the schedule's current policy AND its
 * captured {@link ScheduleMetadata.pinnedRevision} unchanged. Passing
 * `revisionPolicy: 'pinned'` — even when the schedule is already pinned —
 * always RE-resolves and re-captures the pin against the revision active
 * right now; it is never a no-op. Passing `revisionPolicy: 'active-at-fire'`
 * clears any previously captured pin.
 *
 * @example
 * ```ts
 * import { Engine, workflow, type ScheduleUpdateOptions } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.register(workflow({ name: 'report' }).execute(async function* () { return 'done'; }));
 * await engine.schedule('report', null, '0 9 * * *', { id: 'daily-report' });
 * const options: ScheduleUpdateOptions = { overlap: 'queue', jitter: '30s' };
 * await engine.updateSchedule('daily-report', '30 9 * * *', options);
 * engine[Symbol.dispose]();
 * ```
 */
export type ScheduleUpdateOptions = Pick<
  ScheduleOptions,
  'description' | 'overlap' | 'backfill' | 'jitter' | 'timeZone' | 'revisionPolicy' | 'metadata'
> & {
  /**
   * The workflow type each fire starts from now on; omitted, it is kept. A pinned schedule
   * re-captures its pin against the new type, which need not be registered yet.
   */
  workflowType?: string;
  /** The input each fire starts with from now on, replacing it whole; omitted, it is kept. */
  input?: unknown;
  /**
   * Apply the update only if the schedule's {@link ScheduleMetadata.revision} is still this
   * value. The comparison is made inside the schedule's serialized write, and the write is
   * conditioned on the exact bytes it read, so of two concurrent changes carrying the same
   * `expectedRevision`, from this engine or from another sharing the store, exactly one applies and
   * the other rejects with {@link ScheduleStaleRevisionError}. Omitted, the update applies whatever
   * the revision is.
   */
  expectedRevision?: number;
};

/**
 * Declarative recurring schedule definition returned by {@link schedule}. Supply
 * exactly one of `cron` (cron cadence) or `every` (fixed interval).
 *
 * @example
 * ```ts
 * import { schedule, type ScheduleDefinition } from '@lostgradient/weft';
 *
 * const dailyReport: ScheduleDefinition<{ day: string }> = schedule({
 *   workflow: 'report',
 *   cron: '0 9 * * *',
 *   input: { day: 'today' },
 *   overlapPolicy: 'skip',
 * });
 *
 * const heartbeat: ScheduleDefinition<null> = schedule({
 *   workflow: 'heartbeat',
 *   every: '30s',
 *   input: null,
 * });
 * void heartbeat;
 * ```
 */
export type ScheduleDefinition<TInput = unknown> = ScheduleSpec & {
  workflow: string | WorkflowDefinition<TInput>;
  input: TInput;
  id?: string;
  /** Human-readable operator description stored with this schedule. */
  description?: string;
  overlapPolicy?: ScheduleOverlapPolicy;
  backfill?: boolean;
  jitter?: Duration;
  /** The IANA time zone of a cron schedule; see {@link ScheduleOptions.timeZone}. */
  timeZone?: string;
  revisionPolicy?: ScheduleRevisionPolicy;
};

/**
 * Create a recurring schedule definition for `engine.schedule(definition)`.
 *
 * @example
 * ```ts
 * import { schedule } from '@lostgradient/weft';
 *
 * const definition = schedule({ workflow: 'report', cron: '0 9 * * *', input: null });
 * ```
 */
export function schedule<TInput>(
  definition: ScheduleDefinition<TInput>,
): ScheduleDefinition<TInput> {
  return definition;
}

/**
 * Metadata shared by persisted schedule state and lightweight schedule summaries.
 * Persisted state and summaries extend this contract so metadata cannot drift
 * between durable records and public lightweight responses.
 */
export interface ScheduleMetadata {
  id: string;
  workflowType: string;
  /** Human-readable operator description stored with this schedule. */
  description?: string;
  /**
   * The plain JSON object the caller stored with this schedule (see {@link ScheduleOptions.metadata}).
   * Absent on a schedule that has none, including every schedule stored before the field existed.
   */
  metadata?: Record<string, unknown>;
  /**
   * Cron expression driving the cadence for cron-based schedules. Present when
   * `intervalMs` is absent; the two are mutually exclusive.
   */
  cronExpression?: string;
  /**
   * Fixed interval in milliseconds for interval-based schedules. Occurrences are
   * anchored at `createdAt` and fire one interval later, then every interval
   * after that. Present when `cronExpression` is absent.
   */
  intervalMs?: number;
  status: ScheduleStatus;
  overlap: ScheduleOverlapPolicy;
  backfill: boolean;
  /** Normalized deterministic jitter window in milliseconds. */
  jitterMs?: number;
  /**
   * The IANA time zone a cron schedule's wall-clock times are read in, or `UTC`. Every schedule
   * has one: an interval schedule's is always `UTC` and does not change when it fires, and a
   * stored schedule that predates the field reads as `UTC`. See {@link ScheduleOptions.timeZone}
   * for how a daylight-saving transition treats a wall-clock time.
   *
   * While a cron schedule is in a zone whose clock is about to spring forward past one of its
   * wall-clock times, {@link ScheduleState.nextFireAt} may name the instant the gap ends: the
   * schedule wakes there, records the skipped time as missed, and fires only if the expression
   * also matches that instant.
   */
  timeZone: string;
  /**
   * Which revision future occurrences resolve against. Required on every
   * record this package writes; a legacy record persisted before WFT-20
   * decodes as `'active-at-fire'` (see `validation/schedule-revision.ts`) —
   * absence never means "unset," it means "pre-pinning."
   */
  revisionPolicy: ScheduleRevisionPolicy;
  /**
   * The exact revision every future occurrence resolves against, captured at
   * the moment this schedule was created or last switched to (or re-pinned
   * under) `revisionPolicy: 'pinned'`. Present only when `revisionPolicy ===
   * 'pinned'`.
   */
  pinnedRevision?: string;
  /**
   * How many times the schedule itself has changed: `1` when it is created, then one more for
   * every update, pause (a caller's, or the automatic pause after a timer failure), resume, and
   * cancel that changes the schedule. A call that changes nothing (pausing a paused schedule,
   * resuming an active one, cancelling a cancelled one) and the engine's bookkeeping (timer
   * ticks, fires, skips, missed fires, timer recovery at boot) leave it as it is. A stored
   * schedule that predates the field reads as `0`.
   *
   * This is not a workflow revision: it counts changes to the schedule's own status and
   * definition, and {@link ScheduleMetadata.pinnedRevision} is the workflow revision a pinned
   * schedule runs. Pass it back as `expectedRevision` to pause, resume, cancel, or update only
   * the schedule you read.
   */
  revision: number;
  createdAt: number;
  updatedAt: number;
  /** Most recent occurrence that started a scheduled workflow. */
  lastFireAt?: number;
  /** Most recent occurrence skipped because a non-backfill timer was late. */
  lastMissedFireAt?: number;
  /** Lifetime count of occurrences skipped because a non-backfill timer was late. */
  missedFireCount: number;
  /**
   * How many occurrences the overlap policy has dropped because a prior fire
   * was still running — in practice `overlap: 'skip'` collisions (COR-1224).
   *
   * Distinct from {@link ScheduleMetadata.missedFireCount}, which counts
   * occurrences the engine's timer never evaluated because it ran late. A skip
   * is a decision taken on a tick that WAS observed; a missed fire is a window
   * that was not.
   *
   * This is a counter rather than a durable event row per dropped tick, and
   * deliberately so: a schedule whose fires outlast its cadence collides on
   * every tick, so a per-tick durable record would grow without bound and
   * advance the durable event cursor for a fact whose content is "nothing
   * happened". A counter plus {@link ScheduleMetadata.lastSkippedAt} answers
   * the operator's actual question — is this schedule colliding, and when did
   * it last do so — in O(1) per schedule.
   */
  skippedCount: number;
  /** When the most recent occurrence was dropped by the overlap policy. */
  lastSkippedAt?: number;
  nextFireAt: number | null;
  /**
   * The occurrences a person asked to skip (see {@link Engine.skipNextScheduleOccurrence}), in
   * milliseconds since the epoch, ascending and without repeats: the schedule starts no run at any
   * of them. Each is an instant the cadence starts a run at, which is not always
   * {@link nextFireAt}: in a time zone, `nextFireAt` can be the end of a daylight-saving gap that
   * fires nothing. Any upcoming run can be skipped, of an active schedule or a paused one (a pause
   * keeps them), and {@link Engine.unskipScheduleOccurrence} takes one back. An occurrence leaves
   * the set once the schedule moves past it, and all go when it is cancelled or an update moves its
   * cadence off them; an update that leaves one on the cadence keeps it. It holds at most
   * {@link SCHEDULE_SKIPPED_OCCURRENCE_LIMIT} occurrences, and is absent when nothing is skipped. A
   * stored schedule with the single `skipUntil` it replaced reads as a set of that one.
   */
  skippedOccurrences?: number[];
  currentWorkflowId?: string;
  /** Ordered durable occurrences waiting behind `currentWorkflowId`. */
  queuedRuns: ScheduleQueuedRun[];
}

/**
 * Full persisted state of a recurring schedule. Returned by `engine.getSchedule(id)`.
 * Use {@link ScheduleSummary} (returned by list operations and `engine.getSchedule()`)
 * for the lightweight variant — it omits `input` to keep payloads small.
 */
export interface ScheduleState extends ScheduleMetadata {
  input: unknown;
}

/**
 * Lightweight summary of a recurring schedule returned by list operations.
 * Contains cron expression, status, timing metadata, and the ID of the
 * currently running workflow (if any). For the full record including the
 * `input`, use {@link ScheduleState}.
 */
export interface ScheduleSummary extends ScheduleMetadata {}

/**
 * Filter criteria for `engine.listSchedules`. All fields are optional.
 * `status` accepts one or more values; `limit` and `offset` control pagination.
 */
export interface ScheduleFilter {
  status?: ScheduleStatus | ScheduleStatus[];
  workflowType?: string;
  limit?: number;
  offset?: number;
}
