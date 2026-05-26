/**
 * Build the storage operations that keep the workflow visibility indexes in
 * sync with workflow state writes. Called from every state-mutation chokepoint
 * (start, status transition, attribute/tag updates, termination cleanup).
 *
 * The runtime path mirrors the backfill path: read the per-workflow manifest
 * to learn which index keys are currently occupied, delete them, write the
 * new index keys derived from `nextState`, and persist the new manifest. When
 * `nextState` is `null` the workflow is being removed and we simply drop the
 * manifest and every key it lists.
 *
 * @module core/engine/workflow-indexes
 */

import { KEYS, type BatchOperation, type Storage } from '../../storage/interface.ts';
import { decode, encode } from '../codec.ts';
import type { WorkflowState } from '../types.ts';
import { WeftError } from '../weft-error.ts';

/**
 * Bumped whenever the index layout or population rules change. The engine
 * compares this to the watermark stored at `wf-idx-meta:version` to decide
 * whether the indexes are trustworthy for query-time use.
 */
export const WORKFLOW_VISIBILITY_INDEX_VERSION = 1;

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
 * Per-workflow manifest payload — the exact set of visibility-index keys
 * this workflow occupies right now. Decoded from the
 * `wf-idx-manifest:{id}` storage entry.
 */
export type WorkflowVisibilityManifest = {
  /** Schema version that wrote this manifest. */
  version: number;
  /** Sorted list of index keys this workflow currently owns. */
  keys: string[];
};

/**
 * Compute the visibility-index keys a workflow should occupy given its
 * current state. Returns a deterministic, sorted list so manifests compare
 * stably across runs.
 */
export function deriveWorkflowVisibilityIndexKeys(state: WorkflowState): string[] {
  const keys: string[] = [
    KEYS.workflowVisibilityStatus(state.status, state.id),
    KEYS.workflowVisibilityType(state.type, state.id),
    KEYS.workflowVisibilityCreated(state.createdAt, state.id),
    KEYS.workflowVisibilityUpdated(state.updatedAt, state.id),
  ];
  if (state.tenant !== undefined) {
    keys.push(KEYS.workflowVisibilityTenant(state.tenant.id, state.id));
  }
  if (state.executionDeadline !== undefined) {
    keys.push(KEYS.workflowVisibilityDeadline(state.executionDeadline, state.id));
  }
  return keys.toSorted();
}

/**
 * Decode a manifest payload read from storage. Returns `null` for missing or
 * malformed values so callers fall back to the "treat as empty" path — the
 * derived diff still produces the right set of inserts.
 */
export function decodeWorkflowVisibilityManifest(
  bytes: Uint8Array | null,
): WorkflowVisibilityManifest | null {
  if (!bytes) return null;
  let payload: unknown;
  try {
    payload = decode(bytes);
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const candidate = payload as { version?: unknown; keys?: unknown };
  if (typeof candidate.version !== 'number') return null;
  if (!Array.isArray(candidate.keys)) return null;
  const keys: string[] = [];
  for (const entry of candidate.keys) {
    if (typeof entry !== 'string') return null;
    keys.push(entry);
  }
  return { version: candidate.version, keys };
}

/**
 * Result of {@link buildWorkflowVisibilityIndexOperations}. `nextManifestKeys`
 * is `null` when the workflow is being removed (delete manifest + all keys).
 */
export type WorkflowVisibilityIndexUpdate = {
  batchOps: BatchOperation[];
  nextManifestKeys: string[] | null;
};

/**
 * Build the batch operations required to transition a workflow's visibility
 * indexes from `currentManifest` (whatever the storage currently records) to
 * the keys derived from `nextState`. Pass `nextState = null` to drop the
 * workflow's index footprint entirely.
 *
 * The caller is responsible for appending the returned `batchOps` to its own
 * write batch so storage commits the index update atomically with the state
 * write it accompanies.
 */
export function buildWorkflowVisibilityIndexOperations(
  workflowId: string,
  currentManifest: WorkflowVisibilityManifest | null,
  nextState: WorkflowState | null,
): WorkflowVisibilityIndexUpdate {
  return buildWorkflowVisibilityIndexOperationsInternal(
    workflowId,
    currentManifest?.keys ?? [],
    currentManifest !== null,
    nextState,
  );
}

/**
 * Variant of {@link buildWorkflowVisibilityIndexOperations} that derives the
 * previous index keys directly from `previousState` instead of from a stored
 * manifest. Use this on every runtime state-transition write — it avoids an
 * extra storage round-trip per write and is always correct because the index
 * is a deterministic function of state.
 *
 * The manifest-based variant remains the right choice for backfill, which
 * may need to delete rows produced by a different schema version.
 */
export function buildWorkflowVisibilityIndexTransition(
  workflowId: string,
  previousState: WorkflowState | null,
  nextState: WorkflowState | null,
): WorkflowVisibilityIndexUpdate {
  const previousKeys = previousState ? deriveWorkflowVisibilityIndexKeys(previousState) : [];
  const hadManifest = previousState !== null;
  return buildWorkflowVisibilityIndexOperationsInternal(
    workflowId,
    previousKeys,
    hadManifest,
    nextState,
  );
}

function buildWorkflowVisibilityIndexOperationsInternal(
  workflowId: string,
  previousKeys: readonly string[],
  hadPriorManifest: boolean,
  nextState: WorkflowState | null,
): WorkflowVisibilityIndexUpdate {
  const manifestKey = KEYS.workflowVisibilityManifest(workflowId);

  if (nextState === null) {
    const batchOps: BatchOperation[] = [];
    for (const key of previousKeys) {
      batchOps.push({ type: 'delete', key });
    }
    if (hadPriorManifest) {
      batchOps.push({ type: 'delete', key: manifestKey });
    }
    return { batchOps, nextManifestKeys: null };
  }

  const nextKeys = deriveWorkflowVisibilityIndexKeys(nextState);
  const previousSet = new Set(previousKeys);
  const nextSet = new Set(nextKeys);

  const batchOps: BatchOperation[] = [];
  for (const key of previousKeys) {
    if (!nextSet.has(key)) batchOps.push({ type: 'delete', key });
  }
  for (const key of nextKeys) {
    if (!previousSet.has(key)) {
      batchOps.push({ type: 'put', key, value: EMPTY_INDEX_VALUE });
    }
  }
  // Always rewrite the manifest — even when keys are unchanged, the version
  // field gives backfill an unambiguous "managed by current schema" marker.
  const manifestPayload: WorkflowVisibilityManifest = {
    version: WORKFLOW_VISIBILITY_INDEX_VERSION,
    keys: nextKeys,
  };
  batchOps.push({ type: 'put', key: manifestKey, value: encode(manifestPayload) });
  return { batchOps, nextManifestKeys: nextKeys };
}

/**
 * Index rows are presence-only — the workflow id lives in the key. Reuse a
 * shared zero-byte value to keep batches cheap.
 */
const EMPTY_INDEX_VALUE = new Uint8Array(0);

/**
 * Watermark recorded by the backfill once every workflow has a manifest at
 * the current schema version. `engine.list()` and `engine.aggregate()` only
 * consult the new `wf-idx-*` rows when the watermark is `current`.
 */
export type WorkflowVisibilityWatermark = 'current' | 'stale';

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
