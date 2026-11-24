/**
 * The engine's reads and shutdown flush of a run's persisted `ctx.log` lines (COR-1811), over the
 * {@link WorkflowLogStore} the host handed it in `EngineOptions.workflowLogs`.
 *
 * @module core/engine/workflow-logs
 */

import type { WorkflowLogsResult } from '../workflow-log-codec.ts';
import type { EngineInternals } from './internals.ts';

/**
 * The lines a run logged that are still kept, oldest first, and how many the per-run cap evicted.
 * `step` narrows the read to the lines logged before that durable step. An engine without a log
 * store keeps nothing and answers an empty result.
 */
export async function getWorkflowLogs(
  internals: EngineInternals,
  workflowId: string,
  options?: { readonly step?: number | undefined },
): Promise<WorkflowLogsResult> {
  // Construction normalizes a missing store to `null`; the loose check also narrows `undefined`.
  const store = internals.options.workflowLogs;
  if (store == null) return { lines: [], dropped: 0 };
  return store.read(workflowId, options);
}

/** Write the log store's buffered lines; a store that cannot write reports it and never throws. */
export async function flushWorkflowLogs(internals: EngineInternals): Promise<void> {
  await internals.options.workflowLogs?.flush();
}
