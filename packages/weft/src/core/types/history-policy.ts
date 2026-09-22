// ---------------------------------------------------------------------------
// History circuit-breaker policy
// ---------------------------------------------------------------------------

/**
 * Operator-configured upper bound on workflow history. Activation rehydrates a
 * workflow by replaying its event log, so cost is O(history); an unbounded log
 * (e.g. a runaway infinite-yield loop) can stall the shared single-process
 * engine for every workflow. `maxEvents` is a safety backstop: once a
 * workflow's durable event-log record count would exceed it, the engine forces
 * the workflow to a terminal `timed-out` state. Pass via
 * {@link EngineOptions.history}.
 *
 * Thresholds are operator config only — there are no baked-in defaults. Omit
 * the policy (or `maxEvents`) to disable the circuit breaker.
 *
 * @example
 * ```ts
 * import { Engine, type HistoryPolicy } from '@lostgradient/weft';
 *
 * const history: HistoryPolicy = { maxEvents: 100_000 };
 * const engine = new Engine({ history });
 * void engine;
 * ```
 */
export interface HistoryPolicy {
  /**
   * Maximum number of event-log records a workflow may accumulate. Exactly
   * `maxEvents` records are allowed; the record that would push the count to
   * `maxEvents + 1` trips the circuit breaker and the workflow is forced to
   * `timed-out`. Must be a positive safe integer. `0`, omitted, or `undefined`
   * disables enforcement.
   *
   * `maxEvents` counts the **lifetime** event-log sequence (`head.sequence + 1`),
   * which `retentionWindow` compaction never resets — compaction reclaims storage
   * but does not make a workflow semantically younger, so the circuit breaker
   * still fires on total lifetime events.
   */
  maxEvents?: number;
  /**
   * Event-log compaction window: keep **at most** the `retentionWindow` most
   * recent event-log records (measured against the head sequence) and truncate
   * older records behind a confirmed checkpoint to reclaim storage. The canonical
   * checkpoint already holds the compacted state, so truncation never affects
   * resume. `retentionWindow: 1` keeps only the head record. Must be a positive
   * safe integer. `0`, omitted, or `undefined` disables compaction.
   *
   * "At most", not "exactly": the compaction watermark only ever advances forward,
   * so raising `retentionWindow` after compaction has run does not restore
   * already-truncated history. Distinct from {@link maxEvents}: that is a
   * circuit-breaker backstop on lifetime count; this is storage reclamation. They
   * share validation mechanics only.
   */
  retentionWindow?: number;
}

/**
 * History policy after validation and normalisation. `maxEvents` is either a
 * positive safe integer (enforcement active) or `null` (disabled). Used
 * internally by the engine; callers configure via {@link HistoryPolicy}.
 */
export interface NormalizedHistoryPolicy {
  maxEvents: number | null;
  retentionWindow: number | null;
}

/**
 * Distinct reason a workflow reached a terminal state, beyond the status
 * itself. Two members today:
 *
 * - {@link HISTORY_CIRCUIT_BREAKER_REASON}: forced to `timed-out` by the
 *   history circuit breaker, as opposed to an ordinary deadline timeout
 *   (which carries no reason).
 * - {@link PREPARED_WORKFLOW_ABANDONED_REASON} (COR-75): a workflow
 *   `engine.prepare()`d but never launched, then explicitly abandoned via
 *   `handle.abandon()`. Recorded as `'cancelled'`, like any other
 *   cancellation, but distinguishable from an ordinary mid-run
 *   `engine.cancel()` — this run never began executing.
 *
 * If your code narrows or switches on this type exhaustively, widening it
 * with a new member is a source (not just source-compatible) change: add the
 * new case.
 *
 * @example
 * ```ts
 * import { HISTORY_CIRCUIT_BREAKER_REASON, type TerminationReason } from '@lostgradient/weft';
 *
 * const reason: TerminationReason = HISTORY_CIRCUIT_BREAKER_REASON;
 * void reason;
 * ```
 */
export type TerminationReason =
  typeof HISTORY_CIRCUIT_BREAKER_REASON | typeof PREPARED_WORKFLOW_ABANDONED_REASON;

/**
 * Value written to `WorkflowState.terminationReason` and
 * `WorkflowTimedOutEvent.reason` when the history circuit breaker fires. Compare
 * against it to tell circuit-breaker termination apart from a deadline timeout.
 *
 * @example
 * ```ts
 * import { Engine, HISTORY_CIRCUIT_BREAKER_REASON } from '@lostgradient/weft';
 *
 * const engine = new Engine({ history: { maxEvents: 100_000 } });
 * const state = await engine.get('some-workflow-id');
 * if (state?.terminationReason === HISTORY_CIRCUIT_BREAKER_REASON) {
 *   console.log('terminated by the history circuit breaker');
 * }
 * ```
 */
export const HISTORY_CIRCUIT_BREAKER_REASON = 'history-circuit-breaker';

/**
 * Value written to `WorkflowState.terminationReason` when a workflow
 * `engine.prepare()`d but never launched is explicitly abandoned via
 * `handle.abandon()` (COR-75). The workflow's status is `'cancelled'`, like
 * any other cancellation; compare against this value to tell "declined to
 * launch" apart from an ordinary mid-run `engine.cancel()`.
 *
 * @example
 * ```ts
 * import { Engine, PREPARED_WORKFLOW_ABANDONED_REASON } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * const state = await engine.get('some-workflow-id');
 * if (state?.terminationReason === PREPARED_WORKFLOW_ABANDONED_REASON) {
 *   console.log('this run was prepared but abandoned before it ever launched');
 * }
 * ```
 */
export const PREPARED_WORKFLOW_ABANDONED_REASON = 'prepared-workflow-abandoned';
