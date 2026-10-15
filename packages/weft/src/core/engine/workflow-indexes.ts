/**
 * Build the storage operations that keep the workflow visibility indexes in
 * sync with workflow state writes. Called from every state-mutation chokepoint
 * (start, status transition, attribute/tag updates, termination cleanup)
 * through `visibilityIndexOperations`, whenever the engine maintains the index.
 *
 * The index is a deterministic function of workflow state, so every write
 * derives the previous keys from the previous state, deletes the ones that
 * changed, and puts the new ones — no extra storage read and no per-workflow
 * bookkeeping row. When the next state is `null` the workflow is being removed
 * and every key derived from the previous state is dropped.
 *
 * @module core/engine/workflow-indexes
 */

import { KEYS, type BatchOperation, type Storage } from '../../storage/interface.ts';
import { decode } from '../codec.ts';
import type { WorkflowState } from '../types.ts';
import { WeftError } from '../weft-error.ts';
import type { EngineInternals } from './internals.ts';

/**
 * Bumped whenever the index layout or population rules change. The engine
 * compares this to the watermark stored at `wf-idx-meta:version` to decide
 * whether the indexes are trustworthy for query-time use. Version 2 dropped
 * the per-workflow manifest rows and bucketed `wf-idx-updated:` keys, so a
 * version-1 store reads as stale until the backfill rebuilds it.
 */
export const WORKFLOW_VISIBILITY_INDEX_VERSION = 2;

/**
 * Hard cap on the number of candidate workflow ids the engine will
 * materialize for a single `list` or `aggregate` query. Exceeding the cap
 * raises a {@link WorkflowListScanCapExceededError} — the operator should
 * narrow the filter or run the visibility-index backfill so a narrower
 * scan applies.
 */
export const MAX_LIST_SCAN_ROWS = 1_000_000;

/**
 * Thrown when `list`/`aggregate` would materialize more candidates than
 * {@link MAX_LIST_SCAN_ROWS} allows. Transport layers map this to an
 * `Unprocessable` fault.
 */
export class WorkflowListScanCapExceededError extends WeftError<'WorkflowListScanCapExceededError'> {
  readonly cap: number;

  constructor(cap: number) {
    super(
      'WorkflowListScanCapExceededError',
      `Listing workflows would exceed the scan cap of ${cap}. Narrow the filter or run the visibility-index backfill.`,
    );
    this.cap = cap;
  }
}

/**
 * Width of the `wf-idx-updated:` buckets. A workflow's `updatedAt` moves on
 * every state write, so an exact-timestamp key would cost a delete and a put
 * on each one; bucketing keeps the row in place for every write inside the
 * same minute, which covers the whole lifetime of a short workflow. Queries
 * widen their bounds to whole buckets and the list/aggregate post-filter
 * applies the exact range (`matchesListFilter`).
 */
export const WORKFLOW_VISIBILITY_UPDATED_BUCKET_MILLISECONDS = 60_000;

/** Start of the `wf-idx-updated:` bucket holding `updatedAt`. */
export function workflowVisibilityUpdatedBucket(updatedAt: number): number {
  return (
    Math.floor(updatedAt / WORKFLOW_VISIBILITY_UPDATED_BUCKET_MILLISECONDS) *
    WORKFLOW_VISIBILITY_UPDATED_BUCKET_MILLISECONDS
  );
}

/**
 * Compute the visibility-index keys a workflow should occupy given its
 * current state.
 */
export function deriveWorkflowVisibilityIndexKeys(state: WorkflowState): string[] {
  const keys: string[] = [
    KEYS.workflowVisibilityStatus(state.status, state.id),
    KEYS.workflowVisibilityType(state.type, state.id),
    KEYS.workflowVisibilityCreated(state.createdAt, state.id),
    KEYS.workflowVisibilityUpdated(workflowVisibilityUpdatedBucket(state.updatedAt), state.id),
  ];
  if (state.executionDeadline !== undefined) {
    keys.push(KEYS.workflowVisibilityDeadline(state.executionDeadline, state.id));
  }
  return keys;
}

/**
 * Build the batch operations that move a workflow's visibility-index rows
 * from the keys derived from `previousState` to the keys derived from
 * `nextState`. Pass `previousState = null` for a workflow that has no rows
 * yet (a create, or a backfill of an unindexed record) and `nextState = null`
 * to drop the workflow's index footprint entirely.
 *
 * The caller appends the returned operations to its own write batch so
 * storage commits the index update atomically with the state write it
 * accompanies.
 */
export function buildWorkflowVisibilityIndexTransition(
  previousState: WorkflowState | null,
  nextState: WorkflowState | null,
): BatchOperation[] {
  const previousKeys = previousState ? deriveWorkflowVisibilityIndexKeys(previousState) : [];
  const nextKeys = nextState ? deriveWorkflowVisibilityIndexKeys(nextState) : [];
  const operations: BatchOperation[] = [];
  for (const key of previousKeys) {
    if (!nextKeys.includes(key)) operations.push({ type: 'delete', key });
  }
  for (const key of nextKeys) {
    if (!previousKeys.includes(key)) {
      operations.push({ type: 'put', key, value: EMPTY_INDEX_VALUE });
    }
  }
  return operations;
}

/**
 * Index rows are presence-only — the workflow id lives in the key. Reuse a
 * shared zero-byte value to keep batches cheap.
 */
const EMPTY_INDEX_VALUE = new Uint8Array(0);

/**
 * Watermark recorded by the backfill once every workflow is indexed at the
 * current layout version. `engine.list()` and `engine.aggregate()` only
 * consult the new `wf-idx-*` rows when the watermark is `current`.
 */
export type WorkflowVisibilityWatermark = 'current' | 'stale';

export const WORKFLOW_VISIBILITY_WATERMARK_CACHE_TTL_MS = 1_000;

/**
 * Read the visibility-index watermark. Returns `'current'` when the
 * persisted version is at or above {@link WORKFLOW_VISIBILITY_INDEX_VERSION}.
 */
export async function getWorkflowVisibilityWatermark(
  storage: Storage,
): Promise<WorkflowVisibilityWatermark> {
  const bytes = await storage.get(KEYS.workflowVisibilityMetaVersion());
  if (!bytes) return 'stale';
  let payload: unknown;
  try {
    payload = decode(bytes);
  } catch {
    return 'stale';
  }
  if (typeof payload !== 'number') return 'stale';
  return payload >= WORKFLOW_VISIBILITY_INDEX_VERSION ? 'current' : 'stale';
}

/**
 * The index's build stamp (`wf-idx-meta:built-at`), or `null` when there is none. A backfill or
 * drop deletes the stamp in the same batch as the watermark, before it changes any index row, and
 * a publish writes a new stamp in the same batch as the watermark, so equal stamps read before and
 * after an index scan mean the scan saw one complete build. Callers check the watermark itself
 * first, through the query cache.
 */
export async function readWorkflowVisibilityBuild(storage: Storage): Promise<Uint8Array | null> {
  return storage.get(KEYS.workflowVisibilityMetaBuiltAt());
}

export function sameWorkflowVisibilityBuild(before: Uint8Array, after: Uint8Array | null): boolean {
  return (
    after !== null &&
    before.byteLength === after.byteLength &&
    before.every((byte, index) => byte === after[index])
  );
}

/**
 * Read the visibility-index watermark through the engine-local query cache.
 * The short freshness window avoids repeated metadata reads during bursts of
 * list/aggregate queries without pinning an external backfill or drop decision
 * until process restart.
 */
export async function getCachedWorkflowVisibilityWatermark(
  internals: EngineInternals,
): Promise<WorkflowVisibilityWatermark> {
  const cachedWatermark = internals.workflowVisibilityWatermark;
  const expiresAt = internals.workflowVisibilityWatermarkExpiresAt;
  const now = Date.now();
  if (cachedWatermark !== undefined && expiresAt !== undefined && now < expiresAt) {
    return cachedWatermark;
  }

  const watermark = await getWorkflowVisibilityWatermark(internals.storage);
  internals.workflowVisibilityWatermark = watermark;
  internals.workflowVisibilityWatermarkExpiresAt = now + WORKFLOW_VISIBILITY_WATERMARK_CACHE_TTL_MS;
  return watermark;
}
