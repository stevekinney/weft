import type { BatchOperation } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';

const EMPTY_VALUE = new Uint8Array(0);

/** Normalize workflow tags for stable storage, filtering, and rendering. */
export function normalizeWorkflowTags(tags: readonly string[] | undefined): string[] | undefined {
  if (!tags || tags.length === 0) {
    return undefined;
  }

  const normalized = [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))];
  normalized.sort((left, right) => left.localeCompare(right));

  return normalized.length > 0 ? normalized : undefined;
}

/** True when a decoded value is a string array suitable for workflow tags. */
export function isWorkflowTagArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((tag) => typeof tag === 'string');
}

/** Build the storage index delta for workflow tag changes. */
export function buildWorkflowTagIndexOperations(
  workflowId: string,
  previousTags: readonly string[] | undefined,
  nextTags: readonly string[] | undefined,
): BatchOperation[] {
  const operations: BatchOperation[] = [];
  const previous = new Set(previousTags ?? []);
  const next = new Set(nextTags ?? []);

  for (const tag of previous) {
    if (!next.has(tag)) {
      operations.push({
        type: 'delete',
        key: KEYS.tagIndex(tag, workflowId),
      });
    }
  }

  for (const tag of next) {
    if (!previous.has(tag)) {
      operations.push({
        type: 'put',
        key: KEYS.tagIndex(tag, workflowId),
        value: EMPTY_VALUE,
      });
    }
  }

  return operations;
}

/** Match a workflow's tags against an intersection-style filter. */
export function matchesWorkflowTagFilter(
  workflowTags: readonly string[] | undefined,
  filterTags: readonly string[] | undefined,
): boolean {
  if (!filterTags || filterTags.length === 0) {
    return true;
  }

  if (!workflowTags || workflowTags.length === 0) {
    return false;
  }

  const workflowTagSet = new Set(workflowTags);
  return filterTags.every((tag) => workflowTagSet.has(tag));
}
