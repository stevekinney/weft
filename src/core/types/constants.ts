/**
 * Default checkpoint size (in bytes) above which the engine emits a
 * {@link CheckpointSizeWarningEvent}. Currently 64 KB. Override via
 * {@link EngineOptions.checkpointSizeWarningThreshold}.
 *
 * @example
 * ```ts
 * import { Engine, DEFAULT_CHECKPOINT_SIZE_WARNING_THRESHOLD } from '@lostgradient/weft';
 *
 * const engine = new Engine({
 *   checkpointSizeWarningThreshold: DEFAULT_CHECKPOINT_SIZE_WARNING_THRESHOLD * 2,
 * });
 * void engine;
 * ```
 */
export const DEFAULT_CHECKPOINT_SIZE_WARNING_THRESHOLD = 65_536; // 64KB

/**
 * Maximum allowed nesting depth for child workflow invocations before the
 * engine throws. Prevents unbounded recursion. Override via
 * {@link EngineOptions.maxNestingDepth}.
 *
 * @example
 * ```ts
 * import { Engine, DEFAULT_MAX_NESTING_DEPTH } from '@lostgradient/weft';
 *
 * const engine = new Engine({ maxNestingDepth: DEFAULT_MAX_NESTING_DEPTH + 5 });
 * void engine;
 * ```
 */
export const DEFAULT_MAX_NESTING_DEPTH = 10;

/**
 * Default durable-timer scheduler poll interval in milliseconds. The scheduler
 * scans for expired deadlines, delayed starts, and scheduled occurrences once
 * per interval. Override via {@link EngineOptions.schedulerPollIntervalMs} —
 * primarily useful for tests that need a fast, deterministic poll cycle.
 *
 * @example
 * ```ts
 * import { Engine, DEFAULT_POLL_INTERVAL_MS } from '@lostgradient/weft';
 *
 * // A test can shorten the poll cycle far below the 1000ms default.
 * const engine = new Engine({ schedulerPollIntervalMs: DEFAULT_POLL_INTERVAL_MS / 100 });
 * void engine;
 * ```
 */
export const DEFAULT_POLL_INTERVAL_MS = 1000;

/**
 * Default activity visibility timeout in milliseconds (30 seconds). The engine
 * marks an activity as failed if no heartbeat or result is received within this
 * window. Override per-activity via {@link ActivityDefinition.visibilityTimeout}
 * or per-call via {@link ActivityCallOptions.visibilityTimeout}.
 *
 * @example
 * ```ts
 * import { Engine, DEFAULT_VISIBILITY_TIMEOUT_MS, activity } from '@lostgradient/weft';
 *
 * const longTask = activity({
 *   name: 'longTask',
 *   visibilityTimeout: DEFAULT_VISIBILITY_TIMEOUT_MS * 4, // 2 minutes
 *   execute: async (input: unknown) => input,
 * });
 * const engine = new Engine();
 * void engine;
 * void longTask;
 * ```
 */
export const DEFAULT_VISIBILITY_TIMEOUT_MS = 30_000;

export const DEFAULT_RETENTION_SWEEP_INTERVAL_MS = 300_000;

export const DEFAULT_RETENTION_SWEEP_BATCH_SIZE = 1000;
