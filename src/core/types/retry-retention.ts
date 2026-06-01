// ---------------------------------------------------------------------------
// Duration: number (milliseconds) or human-readable string
// ---------------------------------------------------------------------------

/**
 * A length of time accepted across the engine API.
 *
 * Either a number of milliseconds (`5000`) or a human-readable string
 * (`'30s'`, `'5m'`, `'2h'`, `'1d'`). Supplies values for {@link RetryPolicy},
 * `ctx.sleep()`, retention windows, schedule timing, and timeouts.
 *
 * @example Use a Duration in a retry policy
 * ```ts
 * import type { Duration, RetryPolicy } from '@lostgradient/weft';
 *
 * const initialBackoff: Duration = '500ms';
 * const maxBackoff: Duration = '30s';
 *
 * const retry: RetryPolicy = {
 *   maxAttempts: 5,
 *   initialBackoff,
 *   backoffMultiplier: 2,
 *   maxBackoff,
 * };
 * void retry;
 * ```
 */
export type Duration = number | string;

// ---------------------------------------------------------------------------
// Workflow retention
// ---------------------------------------------------------------------------

/**
 * How long the engine retains workflows in each terminal state before the
 * retention sweep deletes them. All fields are optional {@link Duration}
 * values (milliseconds or strings like `'7d'`). Pass via
 * {@link EngineOptions.retention} for engine-wide defaults, or per-workflow
 * via the builder's `retention` option (or `WorkflowDefinition.retention`).
 *
 * @example
 * ```ts
 * import { Engine, type RetentionPolicy } from '@lostgradient/weft';
 *
 * const retention: RetentionPolicy = {
 *   completed: '7d',
 *   failed: '30d',
 *   cancelled: '3d',
 * };
 * const engine = new Engine({ retention });
 * void engine;
 * ```
 */
export interface RetentionPolicy {
  completed?: Duration;
  failed?: Duration;
  cancelled?: Duration;
  timedOut?: Duration;
}

/**
 * Retention policy after {@link Duration} values have been normalised to
 * milliseconds. Used internally by the engine's retention sweep; callers
 * configure retention via {@link RetentionPolicy} which accepts human-readable
 * strings like `'7d'`.
 */
export interface NormalizedRetentionPolicy {
  completed?: number;
  failed?: number;
  cancelled?: number;
  timedOut?: number;
}

// ---------------------------------------------------------------------------
// Retry policy for activities
// ---------------------------------------------------------------------------

/**
 * Exponential-backoff retry policy for activities.
 *
 * Pass on `ActivityDefinition.retry` (set per-activity) or via the engine
 * default policy. Backoff between attempts grows by `backoffMultiplier` and
 * caps at `maxBackoff`. Errors whose `name` (or message) matches an entry in
 * `nonRetryableErrors` skip the retry loop and fail fast.
 *
 * @example Configure a retry policy on an activity
 * ```ts
 * import { activity, type RetryPolicy } from '@lostgradient/weft';
 *
 * const retry: RetryPolicy = {
 *   maxAttempts: 5,
 *   initialBackoff: '500ms',
 *   backoffMultiplier: 2,
 *   maxBackoff: '30s',
 *   nonRetryableErrors: ['ValidationError'],
 * };
 *
 * const fetchUser = activity({
 *   name: 'fetchUser',
 *   retry,
 *   execute: async (input: unknown) => {
 *     return { id: input as string };
 *   },
 * });
 * void fetchUser;
 * ```
 */
export interface RetryPolicy {
  maxAttempts: number;
  initialBackoff: Duration;
  backoffMultiplier: number;
  maxBackoff: Duration;
  nonRetryableErrors?: string[];
}

/**
 * Retention policy entry for a specific workflow type, as reported by
 * `engine.getRetentionOverview`. `source` indicates whether the policy
 * came from the engine-level default, a per-workflow registration, or is
 * absent entirely (`'none'`).
 *
 * @example
 * ```ts
 * import { workflow, Engine, type WorkflowTypeRetentionPolicy } from '@lostgradient/weft';
 *
 * const engine = new Engine({ retention: { completed: '7d' } });
 * engine.register(workflow({ name: 'ping' }).execute(async function* () { return 'pong'; }));
 * const overview = await engine.getRetentionOverview();
 * const policy: WorkflowTypeRetentionPolicy = overview.workflowTypes[0]!;
 * console.log(policy.source); // 'engine'
 * ```
 */
export interface WorkflowTypeRetentionPolicy {
  type: string;
  source: 'engine' | 'workflow' | 'none';
  retention: NormalizedRetentionPolicy | null;
}

/**
 * Summary of the engine's retention configuration, returned by
 * `engine.getRetentionOverview()`. Lists the default retention policy,
 * sweep schedule, and per-workflow-type overrides so operators can
 * audit what cleanup behaviour is active.
 *
 * @example
 * ```ts
 * import { Engine, type RetentionOverview } from '@lostgradient/weft';
 *
 * const engine = new Engine({ retention: { completed: '7d' } });
 * const overview: RetentionOverview = await engine.getRetentionOverview();
 * console.log(overview.sweepIntervalMs);
 * console.log(overview.workflowTypes.length);
 * ```
 */
export interface RetentionOverview {
  defaultRetention: NormalizedRetentionPolicy | null;
  sweepIntervalMs: number;
  sweepBatchSize: number;
  nextSweepAt: number | null;
  workflowTypes: WorkflowTypeRetentionPolicy[];
}

// ---------------------------------------------------------------------------
// Default constants
// ---------------------------------------------------------------------------

/**
 * Built-in retry policy applied to all activities that do not specify their
 * own. Retries up to 3 times with 1 s initial backoff, doubling on each
 * attempt and capping at 30 s. Override per-activity via
 * {@link ActivityDefinition.retry} or per-call via {@link ActivityCallOptions.retry}.
 *
 * @example
 * ```ts
 * import { DEFAULT_RETRY_POLICY, type RetryPolicy } from '@lostgradient/weft';
 *
 * // Extend the default policy with a custom non-retryable error list:
 * const policy: RetryPolicy = {
 *   ...DEFAULT_RETRY_POLICY,
 *   nonRetryableErrors: ['ValidationError'],
 * };
 * void policy;
 * ```
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialBackoff: 1000,
  backoffMultiplier: 2,
  maxBackoff: 30_000,
};
