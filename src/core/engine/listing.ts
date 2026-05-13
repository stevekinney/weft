import { KEYS } from '../../storage/interface.ts';
import { decode, encode } from '../codec.ts';
import { isFailureCategory, normalizeListFilter } from '../list-filter-validation.ts';
import { buildIndexOperations, validateAttributeType } from '../search-attributes.ts';
import type {
  FailureCategory,
  ListFilter,
  ListOptions,
  PaginatedResult,
  SearchAttributeValue,
  WorkflowState,
  WorkflowSummary,
} from '../types.ts';
import { normalizeWorkflowTags } from '../workflow-tags.ts';
import { mutateWorkflowTags, validateAttributeValueSizes } from './attributes-tags.ts';
import type { EngineInternals } from './internals.ts';
import { resolveListCandidateIds } from './list-candidate-resolution.ts';
import { matchesListFilter, paginateWorkflowSummaries } from './state-utilities.ts';
import { decodeWorkflowState, normalizeBulkFilterNumber } from './validation.ts';
import { MAX_LIST_SCAN_ROWS, WorkflowListScanCapExceededError } from './workflow-indexes.ts';
import {
  isTopLevelWorkflowStateKey,
  streamMatchingWorkflowStates,
} from './workflow-state-stream.ts';

export const BULK_OPERATION_BATCH_SIZE = 1000;

/** List workflow summaries that match a filter, using indexes when available. */
// oxlint-disable-next-line complexity -- ID:core-engine-list-complexity
export async function list(
  internals: EngineInternals,
  filter?: ListFilter,
  options?: ListOptions,
): Promise<PaginatedResult<WorkflowSummary>> {
  // Validate the filter the same way `engine.aggregate()` does, so in-process
  // callers receive the same diagnostics as REST / JSON-RPC clients instead of
  // silently getting an empty page for malformed input.
  const normalizedFilter = filter === undefined ? undefined : normalizeListFilter(filter);
  const normalizedTagFilters = normalizeWorkflowTags(normalizedFilter?.tags);
  const constrainedIds = await resolveListCandidateIds(
    internals,
    normalizedFilter,
    normalizedTagFilters,
  );

  const items: WorkflowSummary[] = [];

  if (constrainedIds !== null) {
    const orderedIds = [...constrainedIds];
    if (orderedIds.length > MAX_LIST_SCAN_ROWS) {
      throw new WorkflowListScanCapExceededError(MAX_LIST_SCAN_ROWS);
    }
    // Bounded concurrency so a large constrained set does not fan out
    // millions of parallel `storage.get` calls or hold every state's bytes
    // in memory at once. Stays within the existing scan cap; the chunk
    // size matches `workflow-state-stream`'s attribute fan-out.
    const chunkSize = 64;
    for (let start = 0; start < orderedIds.length; start += chunkSize) {
      const chunkIds = orderedIds.slice(start, start + chunkSize);
      const chunkBytes = await Promise.all(
        chunkIds.map((workflowId) => internals.storage.get(KEYS.workflow(workflowId))),
      );
      for (const stateBytes of chunkBytes) {
        if (!stateBytes) continue;
        const state = decodeWorkflowState(stateBytes);
        if (!matchesListFilter(state, normalizedFilter, constrainedIds, normalizedTagFilters))
          continue;
        const attributeBytes = shouldReadFailureCategoryAttribute(state, options)
          ? await internals.storage.get(KEYS.attribute(state.id))
          : null;
        items.push(summaryFromState(state, failureCategoryFromAttributeBytes(attributeBytes)));
      }
    }
    return paginateWorkflowSummaries(sortSummariesByCreatedAtDescending(items), normalizedFilter);
  }

  let scanned = 0;
  for await (const [key, value] of internals.storage.scan('wf:')) {
    if (!isTopLevelWorkflowStateKey(key)) continue;

    scanned += 1;
    if (scanned > MAX_LIST_SCAN_ROWS) {
      throw new WorkflowListScanCapExceededError(MAX_LIST_SCAN_ROWS);
    }

    const state = decodeWorkflowState(value);
    if (!matchesListFilter(state, normalizedFilter, constrainedIds, normalizedTagFilters)) continue;

    const attributeBytes = shouldReadFailureCategoryAttribute(state, options)
      ? await internals.storage.get(KEYS.attribute(state.id))
      : null;
    items.push(summaryFromState(state, failureCategoryFromAttributeBytes(attributeBytes)));
  }

  return paginateWorkflowSummaries(sortSummariesByCreatedAtDescending(items), normalizedFilter);
}

function shouldReadFailureCategoryAttribute(
  state: WorkflowState,
  options: ListOptions | undefined,
): boolean {
  return (
    options?.includeFailureCategory === true &&
    state.status === 'failed' &&
    (state.failureCategory === undefined || state.failureCategory === null)
  );
}

function failureCategoryFromAttributeBytes(
  attributeBytes: Uint8Array | null,
): FailureCategory | undefined {
  if (attributeBytes === null) return undefined;

  const attributes = decode(attributeBytes);
  if (!isRecord(attributes)) return undefined;

  const value = attributes['failureCategory'];
  return isFailureCategory(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function summaryFromState(
  state: WorkflowState,
  attributeFailureCategory?: FailureCategory,
): WorkflowSummary {
  const failureCategory = state.failureCategory ?? attributeFailureCategory;
  return {
    id: state.id,
    type: state.type,
    status: state.status,
    ...(state.tags !== undefined && { tags: state.tags }),
    ...(state.tenant !== undefined && { tenant: state.tenant }),
    version: state.version,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    ...(state.tenant?.id !== undefined && { tenantId: state.tenant.id }),
    ...(state.executionDeadline !== undefined && { executionDeadline: state.executionDeadline }),
    ...(failureCategory !== undefined && failureCategory !== null && { failureCategory }),
  };
}

/**
 * Stable canonical ordering: `createdAt` descending with `id` ascending as
 * the tiebreaker. Applied after the constrained-id intersection and before
 * pagination slices the page out.
 */
function sortSummariesByCreatedAtDescending(items: WorkflowSummary[]): WorkflowSummary[] {
  return items.toSorted((left, right) => {
    if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt;
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  });
}

/** Stream decoded workflow states that match a list filter. */
export async function* streamWorkflowStates(
  internals: EngineInternals,
  filter?: ListFilter,
): AsyncGenerator<WorkflowState> {
  yield* streamMatchingWorkflowStates(internals, filter);
}

/** Stream decoded workflow states in fixed-size batches for bulk operations. */
// oxlint-disable-next-line complexity -- ID:core-engine-line-3045-complexity
export async function* streamWorkflowStateBatches(
  internals: EngineInternals,
  filter?: ListFilter,
): AsyncGenerator<WorkflowState[]> {
  let remainingOffset = normalizeBulkFilterNumber(filter?.offset, 'offset') ?? 0;
  let remainingLimit = normalizeBulkFilterNumber(filter?.limit, 'limit');

  if (remainingLimit === 0) {
    return;
  }

  let batch: WorkflowState[] = [];

  for await (const state of streamWorkflowStates(internals, filter)) {
    if (remainingOffset > 0) {
      remainingOffset -= 1;
      continue;
    }

    batch.push(state);

    if (remainingLimit !== undefined) {
      remainingLimit -= 1;
    }

    if (batch.length === BULK_OPERATION_BATCH_SIZE) {
      yield batch;
      batch = [];
    }

    if (remainingLimit === 0) {
      break;
    }
  }

  if (batch.length > 0) {
    yield batch;
  }
}

/** Retrieve search attributes for a workflow. */
export async function getAttributes(
  internals: EngineInternals,
  workflowId: string,
): Promise<Record<string, SearchAttributeValue> | null> {
  const bytes = await internals.storage.get(KEYS.attribute(workflowId));
  if (!bytes) return null;
  return decode(bytes) as Record<string, SearchAttributeValue>;
}

/** Merge search attributes into a workflow's existing attributes, updating the index. */
export async function setAttributes(
  internals: EngineInternals,
  workflowId: string,
  attributes: Record<string, SearchAttributeValue>,
): Promise<void> {
  // Validate against the registration's schema if one exists
  const stateBytes = await internals.storage.get(KEYS.workflow(workflowId));
  if (stateBytes) {
    const state = decodeWorkflowState(stateBytes);
    const registration = internals.registrations.get(state.type);
    if (registration?.searchAttributes) {
      const schema = registration.searchAttributes;
      for (const [key, value] of Object.entries(attributes)) {
        if (!(key in schema)) {
          throw new Error(
            `Unknown search attribute "${key}". Registered attributes: ${Object.keys(schema).join(', ')}`,
          );
        }
        validateAttributeType(key, value, schema[key]!);
      }
    }
  }

  validateAttributeValueSizes(attributes);

  const existingBytes = await internals.storage.get(KEYS.attribute(workflowId));
  const existing: Record<string, SearchAttributeValue> = existingBytes
    ? (decode(existingBytes) as Record<string, SearchAttributeValue>)
    : {};

  const merged: Record<string, SearchAttributeValue> = { ...existing, ...attributes };

  const indexOperations = buildIndexOperations(workflowId, existing, merged);

  const operations = [
    { type: 'put' as const, key: KEYS.attribute(workflowId), value: encode(merged) },
    ...indexOperations,
  ];

  await internals.storage.batch(operations);
}

/** Add one or more tags to a workflow. */
export async function addTags(
  internals: EngineInternals,
  workflowId: string,
  ...tags: string[]
): Promise<void> {
  await mutateWorkflowTags(internals, workflowId, tags, 'add');
}

/** Remove one or more tags from a workflow. */
export async function removeTags(
  internals: EngineInternals,
  workflowId: string,
  ...tags: string[]
): Promise<void> {
  await mutateWorkflowTags(internals, workflowId, tags, 'remove');
}
