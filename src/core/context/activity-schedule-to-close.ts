import { parseDuration } from '../scheduler.ts';
import type { ActivityCallOptions, Duration } from '../types.ts';
import { WeftError } from '../weft-error.ts';

/**
 * Thrown when an activity's {@link ActivityCallOptions.scheduleToCloseTimeout}
 * is enforced at the retry boundary. This fires in two situations, both reported
 * with the **actual** wall-clock {@link elapsed} at the moment of the throw:
 *
 * - The budget has genuinely elapsed (`elapsed >= budget`) — an attempt overran,
 *   or downtime during a backoff sleep pushed wall time past the deadline.
 * - The budget has NOT yet elapsed, but the next retry's backoff would start it at
 *   or after the deadline — so Weft refuses to schedule a doomed sleep and fails at
 *   the retry decision point. In this case {@link projectedNextDispatch} is set to
 *   the wall-clock time the skipped retry would have started.
 *
 * The name is registered as a `timeout` failure category, so it classifies and is
 * searchable the same way the other timeout errors are.
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
  /** Actual wall-clock milliseconds elapsed since first dispatch, at the throw. */
  readonly elapsed: number;
  readonly budget: number;
  /**
   * When the failure is the early retry-decision case (the budget has not yet
   * elapsed but the next backoff would start the retry at or after the deadline),
   * the wall-clock time that skipped retry would have started. `undefined` when the
   * budget had genuinely elapsed at the throw.
   */
  readonly projectedNextDispatch?: number;

  constructor(
    activityName: string,
    elapsed: number,
    budget: number,
    projectedNextDispatch?: number,
  ) {
    super(
      'ActivityScheduleToCloseTimeoutError',
      projectedNextDispatch === undefined
        ? `Activity "${activityName}" exceeded its scheduleToCloseTimeout budget of ${budget}ms ` +
            `(elapsed ${elapsed}ms across retries)`
        : `Activity "${activityName}" will not retry within its scheduleToCloseTimeout budget of ` +
            `${budget}ms (elapsed ${elapsed}ms; next retry would start at ${projectedNextDispatch}ms ` +
            `after first dispatch, at or beyond the deadline)`,
    );
    this.activityName = activityName;
    this.elapsed = elapsed;
    this.budget = budget;
    if (projectedNextDispatch !== undefined) this.projectedNextDispatch = projectedNextDispatch;
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
 * Throw {@link ActivityScheduleToCloseTimeoutError} when the schedule-to-close
 * budget bars the next attempt, otherwise return. Called two ways at the retry
 * boundary, both routing through this single check; the thrown error always
 * reports the ACTUAL elapsed time at `now`, never a projected one:
 *
 * - **Top of the retry loop** (`now = getNow()`, no `projectedNextDispatch`):
 *   the live clock has reached or passed the deadline — an attempt overran, or
 *   downtime during a backoff replay pushed wall time past it. Exhaustion is
 *   checked at `now`; the error reports `now - dispatchedAt` and no projection.
 * - **Catch branch** (`now = getNow()`, `projectedNextDispatch = getNow() +
 *   nextBackoff`): the budget may not have elapsed yet, but the next backoff would
 *   start the retry at or after the deadline, so we refuse to schedule that doomed
 *   sleep and fail at the retry decision point. Exhaustion is checked at the
 *   PROJECTED dispatch; the error still reports the actual `now - dispatchedAt`
 *   elapsed plus the projected next-dispatch as the deciding reason.
 *
 * `budget` is `undefined` when no `scheduleToCloseTimeout` is configured, in which
 * case this is a no-op.
 */
export function assertScheduleToCloseBudgetNotExhausted(
  budget: ScheduleToCloseBudget | undefined,
  activityName: string,
  now: number,
  projectedNextDispatch?: number,
): void {
  if (budget === undefined) return;
  // The catch branch decides on the projected next dispatch; the top-of-loop
  // decides on the live clock. Either way the reported elapsed is actual (`now`).
  const decisionClock = projectedNextDispatch ?? now;
  if (!isScheduleToCloseBudgetExhausted(budget, decisionClock)) return;
  throw new ActivityScheduleToCloseTimeoutError(
    activityName,
    now - budget.dispatchedAt,
    budget.budgetMs,
    // Only surface the projection when it (not the actual clock) is the decider:
    // a genuinely-elapsed budget at the top of the loop has no meaningful projection.
    projectedNextDispatch !== undefined && now - budget.dispatchedAt < budget.budgetMs
      ? projectedNextDispatch - budget.dispatchedAt
      : undefined,
  );
}
