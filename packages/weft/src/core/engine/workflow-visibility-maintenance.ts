/**
 * Decides whether a workflow state write has to keep the workflow visibility
 * indexes (`wf-idx-*`) in sync.
 *
 * The indexes only narrow the candidate set for `engine.list()` and
 * `engine.aggregate()` (and, under `ownership: 'workflow-lease'`, the ownerless
 * reclaim scan). `list` and `aggregate` consult them only once the backfill
 * has advanced the `wf-idx-meta:version` watermark to `current`; until then
 * they take the full-scan path, so every index row a runtime write produced
 * while the watermark was `stale` was pure write amplification: four extra
 * SQLite puts plus a manifest encode on every start, and the mirror image on
 * every terminal transition. On the workflow-start admission benchmark that
 * alone cost roughly 40% of the throughput.
 *
 * A write therefore maintains the indexes only when something can read them
 * or is about to:
 *
 * - `ownership: 'workflow-lease'` always maintains: the reclaim scan enumerates
 *   `wf-idx-status:running:` regardless of the watermark.
 * - The engine was created with `maintainWorkflowVisibilityIndexes: true`. An
 *   engine that keeps writing while the backfill runs needs it: the backfill
 *   scans `wf:` once, so a workflow that changes after the scan passed it must
 *   already be indexed by the write that changed it. The decision is fixed for
 *   the engine's lifetime, so there is no window in which a write assembled
 *   under one answer commits under another.
 * - The watermark is `current`: the indexes are live and must stay exact.
 *
 * Every other write skips the indexes.
 *
 * The watermark half of the decision is read from storage and cached for
 * {@link WORKFLOW_VISIBILITY_WATERMARK_CACHE_TTL_MS}. The write paths every
 * workflow passes through (start, completion, retention purge, failure and
 * termination, tag and attribute updates, delayed-start launch) `await`
 * {@link refreshWorkflowVisibilityMaintenance} before they assemble operations.
 * The occasional paths (fork, resume, checkpoint retry) do not refresh: they
 * use the last decision while it is fresh and maintain when it is missing or
 * expired. That is the safe direction, so the worst case is a few index rows on
 * a database whose indexes are not live, which the next backfill discards when
 * it rebuilds from empty.
 *
 * @module core/engine/workflow-visibility-maintenance
 */

import type { BatchOperation } from '../../storage/interface.ts';
import type { WorkflowState } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import {
  WORKFLOW_VISIBILITY_WATERMARK_CACHE_TTL_MS,
  buildWorkflowVisibilityIndexTransition,
  getWorkflowVisibilityWatermark,
} from './workflow-indexes.ts';

/** The cached answer to "must state writes maintain the visibility indexes right now?". */
export type WorkflowVisibilityMaintenanceDecision = {
  maintain: boolean;
  /** Wall-clock millisecond after which the decision must be re-read. */
  expiresAt: number;
};

/**
 * Whether the visibility indexes are maintained by this write. Synchronous so
 * the many operation builders that assemble batches do not have to become
 * async; the async callers keep the decision fresh through
 * {@link refreshWorkflowVisibilityMaintenance}.
 */
export function shouldMaintainWorkflowVisibilityIndexes(internals: EngineInternals): boolean {
  if (maintainsRegardlessOfWatermark(internals)) {
    return true;
  }
  const decision = internals.workflowVisibilityMaintenance;
  return decision === undefined || Date.now() >= decision.expiresAt || decision.maintain;
}

/**
 * Re-read the maintenance decision when the cached one is missing or older
 * than {@link WORKFLOW_VISIBILITY_WATERMARK_CACHE_TTL_MS}. Returns `undefined`
 * (nothing to await) on the common path where the cached decision is fresh, so
 * the start hot path pays no extra microtask tick for it.
 */
export function refreshWorkflowVisibilityMaintenance(
  internals: EngineInternals,
): Promise<void> | undefined {
  if (maintainsRegardlessOfWatermark(internals)) {
    return undefined;
  }
  const decision = internals.workflowVisibilityMaintenance;
  if (decision !== undefined && Date.now() < decision.expiresAt) {
    return undefined;
  }
  const inFlight = internals.workflowVisibilityMaintenanceRefresh;
  if (inFlight !== undefined) {
    return inFlight;
  }
  const refresh = readWorkflowVisibilityMaintenance(internals).finally(() => {
    internals.workflowVisibilityMaintenanceRefresh = undefined;
  });
  internals.workflowVisibilityMaintenanceRefresh = refresh;
  return refresh;
}

function maintainsRegardlessOfWatermark(internals: EngineInternals): boolean {
  return (
    internals.options.ownershipMode === 'workflow-lease' ||
    internals.options.maintainWorkflowVisibilityIndexes
  );
}

async function readWorkflowVisibilityMaintenance(internals: EngineInternals): Promise<void> {
  const readAt = Date.now();
  const watermark = await getWorkflowVisibilityWatermark(internals.storage);
  internals.workflowVisibilityMaintenance = {
    maintain: watermark === 'current',
    // Anchored to when the read STARTED, so a decision never outlives the cache
    // window by the read latency.
    expiresAt: readAt + WORKFLOW_VISIBILITY_WATERMARK_CACHE_TTL_MS,
  };
}

/**
 * The visibility-index operations for a workflow state transition, or none
 * when this write does not maintain the indexes. `previousState` is `null` for
 * a workflow being created and `nextState` is `null` for one being purged.
 */
export function visibilityIndexOperations(
  internals: EngineInternals,
  previousState: WorkflowState | null,
  nextState: WorkflowState | null,
): BatchOperation[] {
  return shouldMaintainWorkflowVisibilityIndexes(internals)
    ? buildWorkflowVisibilityIndexTransition(previousState, nextState)
    : [];
}
