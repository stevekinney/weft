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
 * (see `guides/workflow-versioning.md`'s "Schedule revision policy" section)
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
  id?: string;
  /** Human-readable operator description stored with this schedule. */
  description?: string;
  overlap?: ScheduleOverlapPolicy;
  /**
   * When `false` (the default), a tick that is more than one second late is
   * skipped instead of backfilled. Skipped ticks increment
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
   * Which revision future occurrences resolve against. Defaults to
   * `'active-at-fire'`. Passing `'pinned'` captures the revision that would
   * run right now — see {@link ScheduleRevisionPolicy}. This is a
   * per-schedule revision override; `StartOptions` (a one-shot
   * `engine.start()` call) has no equivalent per-call revision override.
   */
  revisionPolicy?: ScheduleRevisionPolicy;
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
  'description' | 'overlap' | 'backfill' | 'jitter' | 'revisionPolicy'
>;

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
  createdAt: number;
  updatedAt: number;
  /** Most recent occurrence that started a scheduled workflow. */
  lastFireAt?: number;
  /** Most recent occurrence skipped because a non-backfill timer was late. */
  lastMissedFireAt?: number;
  /** Lifetime count of occurrences skipped because a non-backfill timer was late. */
  missedFireCount: number;
  nextFireAt: number | null;
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
