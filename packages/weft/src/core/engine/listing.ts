import { KEYS } from '../../storage/interface.ts';
import { decode, encode } from '../codec.ts';
import { normalizeFailureCategory } from '../failure-categories.ts';
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
import { CONSTRAINED_ID_CHUNK_SIZE } from './candidate-read-batching.ts';
import type { EngineInternals } from './internals.ts';
import { resolveListCandidateIds } from './list-candidate-resolution.ts';
import {
  readSearchAttributesForFilter,
  readSearchAttributesForStates,
} from './search-attribute-records.ts';
import { matchesListFilter, paginateWorkflowSummaries } from './state-utilities.ts';
import { decodeWorkflowState, normalizeBulkFilterNumber } from './validation.ts';
import { MAX_LIST_SCAN_ROWS, WorkflowListScanCapExceededError } from './workflow-indexes.ts';
import {
  isTopLevelWorkflowStateKey,
  streamMatchingWorkflowStates,
} from './workflow-state-stream.ts';

export const BULK_OPERATION_BATCH_SIZE = 1000;

/** List workflow summaries that match a filter, using indexes when available. */
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

  const items =
    constrainedIds !== null
      ? await collectSummariesFromConstrainedIds(
          internals,
          constrainedIds,
          normalizedFilter,
          normalizedTagFilters,
          options,
        )
      : await collectSummariesFromFullScan(
          internals,
          normalizedFilter,
          normalizedTagFilters,
          options,
        );

  return paginateWorkflowSummaries(sortSummariesByCreatedAtDescending(items), normalizedFilter);
}

/**
 * Phase — drain a constrained candidate-id set into summaries. Bounded
 * concurrency keeps the indexed path from fanning out millions of parallel
 * `storage.get` calls or holding every state's bytes in memory at once.
 */
async function collectSummariesFromConstrainedIds(
  internals: EngineInternals,
  constrainedIds: Set<string>,
  normalizedFilter: ListFilter | undefined,
  normalizedTagFilters: readonly string[] | undefined,
  options: ListOptions | undefined,
): Promise<WorkflowSummary[]> {
  const orderedIds = [...constrainedIds];
  assertWorkflowListScanWithinCap(orderedIds.length);

  const items: WorkflowSummary[] = [];
  for (let start = 0; start < orderedIds.length; start += CONSTRAINED_ID_CHUNK_SIZE) {
    const chunkIds = orderedIds.slice(start, start + CONSTRAINED_ID_CHUNK_SIZE);
    const chunkBytes = await Promise.all(
      chunkIds.map((workflowId) => internals.storage.get(KEYS.workflow(workflowId))),
    );
    const searchAttributesByWorkflowId = await readSearchAttributesForStates(
      internals,
      chunkBytes,
      normalizedFilter,
    );
    const matchingStates: WorkflowState[] = [];
    for (const stateBytes of chunkBytes) {
      if (!stateBytes) continue;
      const state = decodeWorkflowState(stateBytes);
      if (
        !matchesListFilter(
          state,
          normalizedFilter,
          constrainedIds,
          normalizedTagFilters,
          searchAttributesByWorkflowId.get(state.id) ?? null,
        )
      ) {
        continue;
      }
      matchingStates.push(state);
    }
    items.push(...(await summariesFromStates(internals, matchingStates, options)));
  }
  return items;
}

/** Phase — full `wf:` prefix scan with scan-cap enforcement and lazy attribute reads. */
async function collectSummariesFromFullScan(
  internals: EngineInternals,
  normalizedFilter: ListFilter | undefined,
  normalizedTagFilters: readonly string[] | undefined,
  options: ListOptions | undefined,
): Promise<WorkflowSummary[]> {
  const items: WorkflowSummary[] = [];
  let scanned = 0;
  for await (const [key, value] of internals.storage.scan('wf:')) {
    if (!isTopLevelWorkflowStateKey(key)) continue;

    scanned += 1;
    assertWorkflowListScanWithinCap(scanned);

    const state = decodeWorkflowState(value);
    const searchAttributes = await readSearchAttributesForFilter(
      internals,
      state.id,
      normalizedFilter,
    );
    if (!matchesListFilter(state, normalizedFilter, null, normalizedTagFilters, searchAttributes)) {
      continue;
    }

    const attributeBytes = shouldReadFailureCategoryAttribute(state, options)
      ? await internals.storage.get(KEYS.attribute(state.id))
      : null;
    items.push(summaryFromState(state, failureCategoryFromAttributeBytes(attributeBytes)));
  }
  return items;
}

export function assertWorkflowListScanWithinCap(scannedRows: number): void {
  if (scannedRows > MAX_LIST_SCAN_ROWS) {
    throw new WorkflowListScanCapExceededError(MAX_LIST_SCAN_ROWS);
  }
}

async function summariesFromStates(
  internals: EngineInternals,
  states: readonly WorkflowState[],
  options: ListOptions | undefined,
): Promise<WorkflowSummary[]> {
  const attributeBytesByWorkflowId = new Map<string, Uint8Array | null>();
  await Promise.all(
    states.map(async (state) => {
      if (!shouldReadFailureCategoryAttribute(state, options)) return;
      attributeBytesByWorkflowId.set(
        state.id,
        await internals.storage.get(KEYS.attribute(state.id)),
      );
    }),
  );

  return states.map((state) =>
    summaryFromState(
      state,
      failureCategoryFromAttributeBytes(attributeBytesByWorkflowId.get(state.id) ?? null),
    ),
  );
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
  if (isFailureCategory(value)) return value;
  return normalizeFailureCategory(value);
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
    version: state.versionTuple.workflowVersion,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
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
export async function* streamWorkflowStateBatches(
  internals: EngineInternals,
  filter?: ListFilter,
): AsyncGenerator<WorkflowState[]> {
  const window = resolveBulkWorkflowStateBatchWindow(filter);

  if (isBulkWorkflowStateBatchWindowExhausted(window)) {
    return;
  }

  let batch: WorkflowState[] = [];

  for await (const state of streamWorkflowStates(internals, filter)) {
    if (skipWorkflowStateForBulkWindow(window)) continue;

    batch.push(state);
    consumeWorkflowStateFromBulkWindow(window);
    if (batch.length === BULK_OPERATION_BATCH_SIZE) {
      yield batch;
      batch = [];
    }

    if (isBulkWorkflowStateBatchWindowExhausted(window)) break;
  }

  if (batch.length > 0) {
    yield batch;
  }
}

type BulkWorkflowStateBatchWindow = {
  remainingOffset: number;
  remainingLimit: number | undefined;
};

function resolveBulkWorkflowStateBatchWindow(
  filter: ListFilter | undefined,
): BulkWorkflowStateBatchWindow {
  return {
    remainingOffset: normalizeBulkFilterNumber(filter?.offset, 'offset') ?? 0,
    remainingLimit: normalizeBulkFilterNumber(filter?.limit, 'limit'),
  };
}

function skipWorkflowStateForBulkWindow(window: BulkWorkflowStateBatchWindow): boolean {
  if (window.remainingOffset <= 0) return false;
  window.remainingOffset -= 1;
  return true;
}

function consumeWorkflowStateFromBulkWindow(window: BulkWorkflowStateBatchWindow): void {
  if (window.remainingLimit === undefined) return;
  window.remainingLimit -= 1;
}

function isBulkWorkflowStateBatchWindowExhausted(window: BulkWorkflowStateBatchWindow): boolean {
  return window.remainingLimit === 0;
}

/** Retrieve search attributes for a workflow. */
export async function getAttributes(
  internals: EngineInternals,
  workflowId: string,
): Promise<Record<string, SearchAttributeValue> | null> {
  const bytes = await internals.storage.get(KEYS.attribute(workflowId));
  if (!bytes) return null;
  const decoded = decode(bytes);
  if (!isRecord(decoded)) return null;
  return decoded as Record<string, SearchAttributeValue>;
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
