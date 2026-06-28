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
}

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
 * Full persisted state of a recurring schedule. Returned by `engine.getSchedule(id)`.
 * Use {@link ScheduleSummary} (returned by list operations and `engine.getSchedule()`)
 * for the lightweight variant — it omits `input` to keep payloads small.
 */
export interface ScheduleState {
  id: string;
  workflowType: string;
  input: unknown;
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
  queuedRuns: number;
}

/**
 * Lightweight summary of a recurring schedule returned by list operations.
 * Contains cron expression, status, timing metadata, and the ID of the
 * currently running workflow (if any). For the full record including the
 * `input`, use {@link ScheduleState}.
 */
export interface ScheduleSummary {
  id: string;
  workflowType: string;
  /** Human-readable operator description stored with this schedule. */
  description?: string;
  /** Cron expression for cron-based schedules; absent for interval schedules. */
  cronExpression?: string;
  /** Interval period in milliseconds for interval-based schedules; absent for cron schedules. */
  intervalMs?: number;
  status: ScheduleStatus;
  overlap: ScheduleOverlapPolicy;
  backfill: boolean;
  /** Normalized deterministic jitter window in milliseconds. */
  jitterMs?: number;
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
  queuedRuns: number;
}

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
