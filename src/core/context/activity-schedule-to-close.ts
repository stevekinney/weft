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
 *   the retry decision point. In this case {@link projectedNextDispatchElapsed} is
 *   set to the elapsed milliseconds after first dispatch at which the skipped retry
 *   would have started.
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
   * the elapsed milliseconds after first dispatch at which that skipped retry would
   * have started. `undefined` when the budget had genuinely elapsed at the throw.
   */
  readonly projectedNextDispatchElapsed?: number;

  constructor(
    activityName: string,
    elapsed: number,
    budget: number,
    projectedNextDispatchElapsed?: number,
  ) {
    super(
      'ActivityScheduleToCloseTimeoutError',
      projectedNextDispatchElapsed === undefined
        ? `Activity "${activityName}" exceeded its scheduleToCloseTimeout budget of ${budget}ms ` +
            `(elapsed ${elapsed}ms across retries)`
        : `Activity "${activityName}" will not retry within its scheduleToCloseTimeout budget of ` +
            `${budget}ms (elapsed ${elapsed}ms; next retry would start at ${projectedNextDispatchElapsed}ms ` +
            `after first dispatch, at or beyond the deadline)`,
    );
    this.activityName = activityName;
    this.elapsed = elapsed;
    this.budget = budget;
    if (projectedNextDispatchElapsed !== undefined) {
      this.projectedNextDispatchElapsed = projectedNextDispatchElapsed;
    }
  }
}

/**
 * Thrown when an inline activity attempt overruns its per-attempt
 * {@link ActivityCallOptions.timeout} wall-clock cap. The cap is measured fresh
 * on every attempt (unlike {@link ActivityScheduleToCloseTimeoutError}, which is a
 * single budget across all attempts), so the {@link attempt} number is reported.
 *
 * When this fires, the workflow stops awaiting the attempt and the activity's
 * `AbortSignal` is aborted so a cooperating activity can stop promptly — but Weft
 * cannot forcibly preempt a running activity function, so a non-cooperating
 * activity keeps executing in the background until it returns. The timed-out
 * attempt is retried (with a fresh cap) when a retry policy permits.
 *
 * The name is registered as a `timeout` failure category, so it classifies and is
 * searchable the same way the other timeout errors are. `timeout` is enforced for
 * **inline** execution only; worker-mode per-attempt bounds are governed by
 * `visibilityTimeout`.
 *
 * @example
 * ```ts
 * import { ActivityPerAttemptTimeoutError } from '@lostgradient/weft';
 *
 * function overranAttempt(error: unknown): boolean {
 *   return error instanceof ActivityPerAttemptTimeoutError;
 * }
 * ```
 */
export class ActivityPerAttemptTimeoutError extends WeftError<'ActivityPerAttemptTimeoutError'> {
  readonly activityName: string;
  /** The 1-based attempt number that overran its per-attempt cap. */
  readonly attempt: number;
  /** The per-attempt wall-clock cap, in milliseconds. */
  readonly timeoutMs: number;

  constructor(activityName: string, attempt: number, timeoutMs: number) {
    super(
      'ActivityPerAttemptTimeoutError',
      `Activity "${activityName}" attempt ${attempt} exceeded its per-attempt timeout of ${timeoutMs}ms`,
    );
    this.activityName = activityName;
    this.attempt = attempt;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The largest delay a single `setTimeout` can represent without 32-bit overflow.
 * A delay above this silently wraps and fires almost immediately, so a per-attempt
 * `timeout` larger than this is rejected rather than misbehaving. (~24.8 days.)
 */
export const MAX_PER_ATTEMPT_TIMEOUT_MS = 2_147_483_647;

/**
 * Parse a per-attempt `timeout` duration to milliseconds, or `undefined` when
 * unset. The value is read off the serialized activity operation, so it is typed
 * `unknown` and validated here as hostile input: only a `number`/`string`
 * {@link Duration} is accepted, and `parseDuration` enforces finite/non-negative
 * so the cap can never silently become `NaN`/`Infinity`/negative. A `0`ms cap is
 * rejected as meaningless (it would expire an attempt before it could run) —
 * callers must omit `timeout` to disable the cap rather than passing `0` — and a
 * value above {@link MAX_PER_ATTEMPT_TIMEOUT_MS} is rejected because it would
 * overflow the underlying `setTimeout` and fire almost immediately.
 */
export function parsePerAttemptTimeoutMs(timeout: unknown): number | undefined {
  if (timeout === undefined) return undefined;
  if (typeof timeout !== 'number' && typeof timeout !== 'string') {
    throw new Error(
      `Activity timeout must be a number or duration string when set (got ${typeof timeout}).`,
    );
  }
  const ms = parseDuration(timeout);
  if (ms <= 0) {
    throw new Error(
      `Activity timeout must be greater than 0ms when set (got ${ms}ms); omit it to disable the per-attempt cap.`,
    );
  }
  if (ms > MAX_PER_ATTEMPT_TIMEOUT_MS) {
    throw new Error(
      `Activity timeout of ${ms}ms exceeds the maximum supported per-attempt cap of ${MAX_PER_ATTEMPT_TIMEOUT_MS}ms (~24.8 days).`,
    );
  }
  return ms;
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
 * unset. `parseDuration` validates the result is finite and non-negative on every
 * input path (numeric and string, via `assertValidDurationMilliseconds`) and
 * throws otherwise — so the budget can never silently become `NaN`/`Infinity`
 * (which would make `elapsed >= budgetMs` always-false) or negative. `0` is valid
 * (it permits exactly one attempt).
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
 * Resolve the per-attempt `timeout` for a `ctx.run` call: a per-call `timeout`
 * overrides the activity definition's default. String activities have no
 * definition fields, so only the per-call option applies. Mirrors
 * {@link resolveActivityScheduleToCloseTimeout} so the per-attempt cap honors a
 * `timeout` declared on the activity definition, not just at the call site.
 */
export function resolveActivityTimeout(
  activity: string | (Function & { timeout?: Duration }),
  options: ActivityCallOptions | undefined,
): Duration | undefined {
  if (options?.timeout !== undefined) return options.timeout;
  if (typeof activity === 'string') return undefined;
  return activity.timeout;
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
 * - **Top of the retry loop** (`now = getNow()`, no `projectedNextDispatchClock`):
 *   the live clock has reached or passed the deadline — an attempt overran, or
 *   downtime during a backoff replay pushed wall time past it. Exhaustion is
 *   checked at `now`; the error reports `now - dispatchedAt` and no projection.
 * - **Catch branch** (`now = getNow()`, `projectedNextDispatchClock = now +
 *   nextBackoff`, both from a single clock read): the budget may not have elapsed
 *   yet, but the next backoff would start the retry at or after the deadline, so we
 *   refuse to schedule that doomed sleep and fail at the retry decision point.
 *   Exhaustion is checked at the PROJECTED dispatch clock; the error still reports
 *   the actual `now - dispatchedAt` elapsed plus the projected next-dispatch
 *   (as elapsed-since-first-dispatch ms) as the deciding reason.
 *
 * `budget` is `undefined` when no `scheduleToCloseTimeout` is configured, in which
 * case this is a no-op.
 */
export function assertScheduleToCloseBudgetNotExhausted(
  budget: ScheduleToCloseBudget | undefined,
  activityName: string,
  now: number,
  projectedNextDispatchClock?: number,
): void {
  if (budget === undefined) return;
  // The catch branch decides on the projected next-dispatch clock; the top-of-loop
  // decides on the live clock. Either way the reported elapsed is actual (`now`).
  const decisionClock = projectedNextDispatchClock ?? now;
  if (!isScheduleToCloseBudgetExhausted(budget, decisionClock)) return;
  throw new ActivityScheduleToCloseTimeoutError(
    activityName,
    now - budget.dispatchedAt,
    budget.budgetMs,
    // Only surface the projection (as elapsed-since-first-dispatch ms) when it (not
    // the actual clock) is the decider: a genuinely-elapsed budget at the top of the
    // loop has no meaningful projection.
    projectedNextDispatchClock !== undefined && now - budget.dispatchedAt < budget.budgetMs
      ? projectedNextDispatchClock - budget.dispatchedAt
      : undefined,
  );
}
