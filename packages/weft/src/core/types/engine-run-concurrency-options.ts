/**
 * The run-concurrency fields of `EngineOptions`, and what `engine.runConcurrency()` reports.
 *
 * @module core/types/engine-run-concurrency-options
 */

/**
 * {@link EngineOptions.runConcurrency}: how many top-level runs execute at once, and which runs
 * count toward it.
 *
 * @example
 * ```ts
 * import { Engine, type RunConcurrencyOptions } from '@lostgradient/weft';
 *
 * // At most four report runs at a time; every other workflow type runs uncounted.
 * const runConcurrency: RunConcurrencyOptions = {
 *   max: 4,
 *   counts: (workflowType) => workflowType.startsWith('report-'),
 * };
 * const engine = new Engine({ runConcurrency });
 * void engine;
 * ```
 */
export interface RunConcurrencyOptions {
  /** The most counted runs executing at once: a positive safe integer. */
  readonly max: number;
  /**
   * Whether a top-level run of `workflowType` counts toward {@link RunConcurrencyOptions.max}.
   * Omitted, every top-level run counts. A run that does not count is never held.
   */
  readonly counts?: ((workflowType: string) => boolean) | undefined;
}

/**
 * What `engine.runConcurrency()` reports: the cap, the counted runs this engine is executing, and
 * the counted starts waiting for one of them to end.
 */
export interface RunConcurrencySnapshot {
  /** {@link RunConcurrencyOptions.max}. */
  readonly max: number;
  /** The ids of the counted runs executing now, at most `max` unless recovery resumed more. */
  readonly running: readonly string[];
  /** The ids of the counted runs whose first turn waits for a slot, oldest first. */
  readonly waiting: readonly string[];
}

/** The run-concurrency fields of `EngineOptions`. */
export interface EngineRunConcurrencyOptions {
  /**
   * The most top-level runs this engine executes at the same time. A start past the cap is
   * committed as usual, but its first turn waits, in the order the starts arrived, until a counted
   * run ends or is suspended. A run recovered or resumed from storage takes a slot and is never held.
   * Child workflows are not counted, so a parent waiting on its children cannot hold up a child.
   * Omit for no cap. Inline execution only: construction refuses it in `worker` or `realm` mode.
   */
  runConcurrency?: RunConcurrencyOptions;
}
