/**
 * Query helpers that read the workflow visibility indexes laid down by
 * {@link buildWorkflowVisibilityIndexTransition} / backfill. Each helper
 * produces a `Set<string>` of candidate workflow ids; the caller
 * intersects sets across dimensions to narrow the slow-path scan.
 *
 * Every helper assumes the visibility-index watermark is `current` — the
 * caller checks {@link getWorkflowVisibilityWatermark} once per query and
 * uses the current full-scan correctness path when it is `stale`.
 *
 * @module core/engine/workflow-visibility-queries
 */

import {
  encodeStorageKeyComponent,
  tryDecodeStorageKeyComponent,
  type ScanOptions,
  type Storage,
} from '../../storage/interface.ts';
import type { FailureCategory, WorkflowStatus } from '../types/identity.ts';
import type { TimeRange } from '../types/list-options.ts';

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function sortableTimestamp(value: number): string {
  return String(value).padStart(16, '0');
}

async function collectWorkflowIdsFromIndex(
  storage: Storage,
  prefix: string,
  options?: ScanOptions,
): Promise<Set<string>> {
  const ids = new Set<string>();
  for await (const [key] of storage.scan(prefix, options)) {
    const encoded = key.slice(key.lastIndexOf(':') + 1);
    const workflowId = tryDecodeStorageKeyComponent(encoded);
    if (workflowId !== null) ids.add(workflowId);
  }
  return ids;
}

/**
 * Match every workflow whose `status` appears in `statuses`. Empty input
 * returns an empty set (intersection short-circuits to "no matches").
 */
export async function queryWorkflowStatusIndex(
  storage: Storage,
  statuses: readonly WorkflowStatus[],
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const status of statuses) {
    const prefix = `wf-idx-status:${encodeStorageKeyComponent(status)}:`;
    for (const id of await collectWorkflowIdsFromIndex(storage, prefix)) {
      ids.add(id);
    }
  }
  return ids;
}

/** Match every workflow with the given `type`. */
export async function queryWorkflowTypeIndex(storage: Storage, type: string): Promise<Set<string>> {
  const prefix = `wf-idx-type:${encodeStorageKeyComponent(type)}:`;
  return collectWorkflowIdsFromIndex(storage, prefix);
}

/**
 * Time-range scan over `wf-idx-{kind}:` (created, updated, or deadline).
 * Returns the candidate ids the engine post-filter will refine.
 */
export async function queryWorkflowTimeRangeIndex(
  storage: Storage,
  kind: 'created' | 'updated' | 'deadline',
  range: TimeRange,
): Promise<Set<string>> {
  const prefix = `wf-idx-${kind}:`;
  const scanOptions: ScanOptions = {};

  if (range.gte !== undefined && isFinitePositive(range.gte)) {
    scanOptions.gte = `${prefix}${sortableTimestamp(range.gte)}:`;
  }
  if (range.gt !== undefined && isFinitePositive(range.gt)) {
    // Skip the entire bucket for the lower bound by extending past its `:\xff`.
    scanOptions.gt = `${prefix}${sortableTimestamp(range.gt)}:\xff`;
  }
  if (range.lte !== undefined && isFinitePositive(range.lte)) {
    scanOptions.lte = `${prefix}${sortableTimestamp(range.lte)}:\xff`;
  }
  if (range.lt !== undefined && isFinitePositive(range.lt)) {
    scanOptions.lt = `${prefix}${sortableTimestamp(range.lt)}:`;
  }

  return collectWorkflowIdsFromIndex(storage, prefix, scanOptions);
}

/**
 * Enumerate candidate workflow ids whose raw id starts with `idPrefix`.
 * Uses the primary-key `wf:{enc(prefix)}` scan, which is sound because the
 * encoder is identity + concatenation-preserving on the validated safe
 * subset (see `src/storage/interface.test.ts`). The caller still re-checks
 * `state.id.startsWith(idPrefix)` as a defensive post-filter.
 */
export async function queryWorkflowIdPrefixCandidates(
  storage: Storage,
  idPrefix: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  const prefix = `wf:${encodeStorageKeyComponent(idPrefix)}`;
  for await (const [key] of storage.scan(prefix)) {
    const idPart = key.slice(3);
    if (idPart.includes(':')) continue; // skip non-top-level wf:{id}:... keys
    const workflowId = tryDecodeStorageKeyComponent(idPart);
    if (workflowId !== null) ids.add(workflowId);
  }
  return ids;
}

/**
 * Re-export for callers that only need the failure-category value type.
 * Keeps imports tidy at the call sites.
 */
export type { FailureCategory };
