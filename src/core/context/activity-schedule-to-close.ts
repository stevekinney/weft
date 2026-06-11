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
 * activities have no definition fields, so only the per-call option applies.
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
 * Whether the schedule-to-close budget is exhausted at this retry boundary. Only
 * meaningful from attempt 2 onward (an activity always gets one try); the caller
 * is responsible for that guard. Compares the live engine clock against the
 * persisted first-dispatch anchor, so only the frontier (uncached) attempt is
 * ever governed — exactly the wall-clock semantic the budget promises.
 */
export function isScheduleToCloseBudgetExhausted(
  budget: ScheduleToCloseBudget,
  now: number,
): boolean {
  return now - budget.dispatchedAt > budget.budgetMs;
}
