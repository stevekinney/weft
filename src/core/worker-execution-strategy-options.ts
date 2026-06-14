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
}
