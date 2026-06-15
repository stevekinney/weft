import type { WorkflowLogRecord } from './types/workflow-log.ts';

export interface WorkerExecutionStrategyOptions {
  broadcastEvents?: boolean;
  workflowTurnTimeoutMs?: number;
  maxProtocolMessageBytes?: number;
  requireProtocolVersion?: boolean;
  discardOnCancel?: boolean;
  /**
   * The engine host's `EngineOptions.onLog` sink (#529). When present, the strategy
   * tells each worker (`hostHasLogSink: true` on `run`/`resume`) to forward `ctx.log`
   * records back as `log` protocol messages, which are delivered here instead of the
   * worker console. When absent, workers log to their own console (the default).
   */
  onLog?: (record: WorkflowLogRecord) => void;
  /**
   * Monotonic-enough wall clock (ms) for the forwarded-log abuse counter's flood
   * window (#545). Injected so tests advance time deterministically; defaults to
   * `Date.now` when omitted (the non-worker-construction path / direct tests).
   */
  getNow?: () => number;
  /**
   * Internal test seams for the forwarded-log abuse counter (#545). Not a public
   * engine option — the abuse thresholds are deliberately fixed and generous so honest
   * high-log workflows are never discarded. These exist only so unit tests can inject
   * small thresholds (and a controllable window) to exercise the discard paths without
   * sending thousands of messages; each falls back to its worker-protocol default.
   */
  forwardedLogFloodWindowMs?: number;
  /** See {@link WorkerExecutionStrategyOptions.forwardedLogFloodWindowMs} — internal test seam (#545). */
  forwardedLogFloodThreshold?: number;
  /** See {@link WorkerExecutionStrategyOptions.forwardedLogFloodWindowMs} — internal test seam (#545). */
  forwardedLogStrikeThreshold?: number;
}
