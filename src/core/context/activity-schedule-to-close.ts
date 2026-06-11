import { parseDuration } from '../scheduler.ts';
import type { ActivityCallOptions, Duration } from '../types.ts';
import { WeftError } from '../weft-error.ts';

/**
 * Thrown when an activity's {@link ActivityCallOptions.scheduleToCloseTimeout}
 * wall-clock budget is exhausted across its retry attempts. Its name is
 * registered as a `timeout` failure category, so it classifies and is searchable
 * the same way the other timeout errors are.
 *
 * @example
 * ```ts
 * import { ActivityScheduleToCloseTimeoutError } from '@lostgradient/weft';
 *
 * function exceededRetryBudget(error: unknown): boolean {
 *   return error instanceof ActivityScheduleToCloseTimeoutError;
 * }
 * ```
 */
export class ActivityScheduleToCloseTimeoutError extends WeftError<'ActivityScheduleToCloseTimeoutError'> {
  readonly activityName: string;
  readonly elapsed: number;
  readonly budget: number;

  constructor(activityName: string, elapsed: number, budget: number) {
    super(
      'ActivityScheduleToCloseTimeoutError',
      `Activity "${activityName}" exceeded its scheduleToCloseTimeout budget of ${budget}ms ` +
        `(elapsed ${elapsed}ms across retries)`,
    );
    this.activityName = activityName;
    this.elapsed = elapsed;
    this.budget = budget;
  }
}

/**
 * The first-dispatch anchor and parsed budget for a `ctx.run` call's
 * `scheduleToCloseTimeout`, or `undefined` when no budget is configured.
 */
export type ScheduleToCloseBudget = {
  budgetMs: number;
  dispatchedAt: number;
};

/**
 * Parse a `scheduleToCloseTimeout` duration to milliseconds, or `undefined` when
 * unset.
 */
export function parseScheduleToCloseBudgetMs(
  scheduleToCloseTimeout: Duration | undefined,
): number | undefined {
  return scheduleToCloseTimeout === undefined ? undefined : parseDuration(scheduleToCloseTimeout);
}

/**
 * Resolve the cross-attempt wall-clock budget for a `ctx.run` call: a per-call
 * `scheduleToCloseTimeout` overrides the activity definition's default. String
 * activities have no definition fields, so only the per-call option applies. The
 * by-reference arm is `Function & { scheduleToCloseTimeout?: Duration }` to match
 * the caller's `ActivityInput` (a callable carrying the activity definition); this
 * resolver reads only the single `scheduleToCloseTimeout` field off it.
 */
export function resolveActivityScheduleToCloseTimeout(
  activity: string | (Function & { scheduleToCloseTimeout?: Duration }),
  options: ActivityCallOptions | undefined,
): Duration | undefined {
  if (options?.scheduleToCloseTimeout !== undefined) return options.scheduleToCloseTimeout;
  if (typeof activity === 'string') return undefined;
  return activity.scheduleToCloseTimeout;
}

/**
 * Whether the schedule-to-close budget is exhausted at the given clock value.
 * The comparison is `>=` so an exact-deadline or zero-budget retry is treated as
 * exhausted — a `0`ms budget allows exactly one attempt, then throws.
 */
export function isScheduleToCloseBudgetExhausted(
  budget: ScheduleToCloseBudget,
  now: number,
): boolean {
  return now - budget.dispatchedAt >= budget.budgetMs;
}

/**
 * Throw {@link ActivityScheduleToCloseTimeoutError} if the budget is exhausted at
 * `now`, otherwise return. Called two ways at the retry boundary, both routing
 * through this single check so the catch branch carries no extra inline branch:
 *
 * - Top of the retry loop with the live clock (`getNow()`), catching a crash whose
 *   downtime pushed wall time past the deadline — the path replay reaches when the
 *   backoff sleep replays from cache and the catch branch never runs.
 * - In the catch branch with `getNow() + nextBackoff`, refusing to schedule a
 *   backoff that would itself carry past the deadline.
 *
 * `budget` is `undefined` when no `scheduleToCloseTimeout` is configured, in which
 * case this is a no-op.
 */
export function assertScheduleToCloseBudgetNotExhausted(
  budget: ScheduleToCloseBudget | undefined,
  activityName: string,
  now: number,
): void {
  if (budget === undefined || !isScheduleToCloseBudgetExhausted(budget, now)) return;
  throw new ActivityScheduleToCloseTimeoutError(
    activityName,
    now - budget.dispatchedAt,
    budget.budgetMs,
  );
}
