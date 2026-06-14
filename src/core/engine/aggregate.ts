/**
 * `engine.aggregate()` — group-by counts over a {@link ListFilter}.
 * Shares the candidate-resolution path with `engine.list()` so the
 * watermark gate, scan cap, and indexed narrowing behave identically.
 *
 * @module core/engine/aggregate
 */

import { KEYS } from '../../storage/interface.ts';
import {
  AGGREGATE_DEFAULT_LIMIT,
  AggregateDistinctKeyCapExceededError,
  MAX_AGGREGATE_DISTINCT_KEYS,
  normalizeAggregateOptions,
  type AggregateGroupBy,
  type AggregateOptions,
} from '../aggregate-validation.ts';
import { normalizeListFilter } from '../list-filter-validation.ts';
import type { ListFilter, SearchAttributeValue, WorkflowState } from '../types.ts';
import { WeftError } from '../weft-error.ts';
import { normalizeWorkflowTags } from '../workflow-tags.ts';
import { CONSTRAINED_ID_CHUNK_SIZE } from './candidate-read-batching.ts';
import type { EngineInternals } from './internals.ts';
import { resolveListCandidateIds } from './list-candidate-resolution.ts';
import {
  readSearchAttributesForFilter,
  readSearchAttributesForStates,
} from './search-attribute-records.ts';
import { decodeSearchAttributeRecord, matchesListFilter } from './state-utilities.ts';
import { decodeWorkflowState } from './validation.ts';
import { MAX_LIST_SCAN_ROWS, WorkflowListScanCapExceededError } from './workflow-indexes.ts';
import { isTopLevelWorkflowStateKey } from './workflow-state-stream.ts';

/** One group in an {@link AggregateResult}. `key === null` collects workflows missing the dimension. */
export type AggregateGroup = {
  key: string | null;
  count: number;
};

/**
 * Result of `engine.aggregate()`. `total` is the count of candidates that
 * passed filtering; `groups` is sorted by `count desc, key asc` and
 * truncated to the caller's `limit`. `truncated` is `true` when there
 * were more groups than `limit` allowed.
 */
export type AggregateResult = {
  total: number;
  groups: AggregateGroup[];
  truncated: boolean;
};

type AggregateExecutionOptions = {
  distinctKeyCap?: number;
};

const ATTRIBUTE_VALUE_TO_KEY = (value: SearchAttributeValue | undefined): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.join(',');
  return String(value);
};

/**
 * Thrown when an aggregate `groupBy: { attribute }` references a search
 * attribute that no registration declares. Maps to an `Unprocessable`
 * fault at the operation boundary.
 */
export class UnknownAggregateAttributeError extends WeftError<'UnknownAggregateAttributeError'> {
  readonly attribute: string;

  constructor(attribute: string) {
    super(
      'UnknownAggregateAttributeError',
      `Unknown search attribute "${attribute}". Aggregate groupBy requires a declared attribute.`,
    );
    this.attribute = attribute;
  }
}

/**
 * Validate an attribute-name `groupBy` against the engine's
 * `SearchAttributeSchema` (when configured). Runs before any storage
 * access so unknown attributes fail fast with a validation error.
 */
function validateAttributeDimension(internals: EngineInternals, attributeName: string): void {
  // When at least one registration declares a search-attribute schema, the
  // requested attribute must be declared somewhere — otherwise the result
  // would always be all-null and silently mislead the caller.
  let anySchemaDeclared = false;
  let attributeFound = false;
  for (const registration of internals.registrations.values()) {
    if (registration.searchAttributes !== undefined) {
      anySchemaDeclared = true;
      if (attributeName in registration.searchAttributes) {
        attributeFound = true;
        break;
      }
    }
  }
  if (anySchemaDeclared && !attributeFound) {
    throw new UnknownAggregateAttributeError(attributeName);
  }
}

type AggregateValidatedInput = {
  normalizedFilter: ListFilter;
  groupBy: AggregateGroupBy;
  requestedLimit: number;
  distinctKeyCap: number;
};

/**
 * Phase 1 — re-validate the filter and options so in-process callers
 * receive the same diagnostics as REST/JSON-RPC clients, and so unknown
 * search-attribute dimensions fail fast before any storage access.
 */
function validateAggregateInputs(
  internals: EngineInternals,
  filter: ListFilter | undefined,
  options: AggregateOptions,
  executionOptions: AggregateExecutionOptions,
): AggregateValidatedInput {
  const normalizedFilter = normalizeListFilter({ ...filter, limit: undefined, offset: undefined });
  const normalizedOptions = normalizeAggregateOptions(options);
  const { groupBy } = normalizedOptions;
  if (typeof groupBy === 'object') {
    validateAttributeDimension(internals, groupBy.attribute);
  }
  return {
    normalizedFilter,
    groupBy,
    requestedLimit: normalizedOptions.limit ?? AGGREGATE_DEFAULT_LIMIT,
    distinctKeyCap: executionOptions.distinctKeyCap ?? MAX_AGGREGATE_DISTINCT_KEYS,
  };
}

type AggregateAccumulator = {
  counts: Map<string | null, number>;
  total: number;
};

/**
 * Phase — record one workflow under its dimension key, enforcing the
 * distinct-key cap before allocating a new bucket.
 */
function accumulateAggregateKey(
  key: string | null,
  distinctKeyCap: number,
  accumulator: AggregateAccumulator,
): void {
  const current = accumulator.counts.get(key);
  if (current === undefined) {
    if (accumulator.counts.size >= distinctKeyCap) {
      throw new AggregateDistinctKeyCapExceededError(distinctKeyCap);
    }
    accumulator.counts.set(key, 1);
  } else {
    accumulator.counts.set(key, current + 1);
  }
  accumulator.total += 1;
}

/**
 * Resolve dimension keys for a chunk of workflows. Structural groupings use
 * the already loaded state. Attribute groupings fan storage reads out in
 * bounded batches, matching the constrained-id list path.
 */
async function resolveDimensionKeys(
  internals: EngineInternals,
  states: readonly WorkflowState[],
  groupBy: AggregateGroupBy,
  searchAttributesByWorkflowId: ReadonlyMap<
    string,
    Record<string, SearchAttributeValue> | null
  > = new Map(),
): Promise<Array<string | null>> {
  if (groupBy === 'status') return states.map((state) => state.status);
  if (groupBy === 'type') return states.map((state) => state.type);
  // Read `failureCategory` from the loaded state so the aggregate buckets
  // every workflow under the same key the list-filter post-filter used.
  // The search-attribute store may be stale or absent for engine-managed
  // categories; `state.failureCategory` is the authoritative source.
  if (groupBy === 'failureCategory') return states.map((state) => state.failureCategory ?? null);

  return resolveAttributeDimensionKeys(internals, states, groupBy, searchAttributesByWorkflowId);
}

async function resolveAttributeDimensionKeys(
  internals: EngineInternals,
  states: readonly WorkflowState[],
  groupBy: Extract<AggregateGroupBy, { attribute: string }>,
  searchAttributesByWorkflowId: ReadonlyMap<string, Record<string, SearchAttributeValue> | null>,
): Promise<Array<string | null>> {
  const keys: Array<string | null> = [];
  for (let start = 0; start < states.length; start += CONSTRAINED_ID_CHUNK_SIZE) {
    const stateChunk = states.slice(start, start + CONSTRAINED_ID_CHUNK_SIZE);
    const statesNeedingReads = stateChunk.filter(
      (state) => !searchAttributesByWorkflowId.has(state.id),
    );
    const attributeBytesByWorkflowId = new Map<string, Uint8Array | null>();
    await Promise.all(
      statesNeedingReads.map(async (state) => {
        attributeBytesByWorkflowId.set(
          state.id,
          await internals.storage.get(KEYS.attribute(state.id)),
        );
      }),
    );
    for (const state of stateChunk) {
      const attributes = searchAttributesByWorkflowId.has(state.id)
        ? (searchAttributesByWorkflowId.get(state.id) ?? null)
        : decodeSearchAttributeRecord(attributeBytesByWorkflowId.get(state.id) ?? null);
      if (attributes === null) {
        keys.push(null);
        continue;
      }
      keys.push(ATTRIBUTE_VALUE_TO_KEY(attributes[groupBy.attribute]));
    }
  }
  return keys;
}

/** Phase — record a batch of workflows under their dimension keys. */
async function accumulateAggregateStates(
  internals: EngineInternals,
  states: readonly WorkflowState[],
  groupBy: AggregateGroupBy,
  distinctKeyCap: number,
  accumulator: AggregateAccumulator,
  searchAttributesByWorkflowId?: ReadonlyMap<string, Record<string, SearchAttributeValue> | null>,
): Promise<void> {
  const dimensionKeys = await resolveDimensionKeys(
    internals,
    states,
    groupBy,
    searchAttributesByWorkflowId,
  );
  for (const key of dimensionKeys) {
    accumulateAggregateKey(key, distinctKeyCap, accumulator);
  }
}

/** Phase — drain a constrained candidate-id set through the accumulator. */
async function accumulateFromConstrainedIds(
  internals: EngineInternals,
  constrainedIds: Set<string>,
  normalizedFilter: ListFilter,
  normalizedTagFilters: readonly string[] | undefined,
  groupBy: AggregateGroupBy,
  distinctKeyCap: number,
  accumulator: AggregateAccumulator,
): Promise<void> {
  const orderedIds = [...constrainedIds];
  if (orderedIds.length > MAX_LIST_SCAN_ROWS) {
    throw new WorkflowListScanCapExceededError(MAX_LIST_SCAN_ROWS);
  }

  for (let start = 0; start < orderedIds.length; start += CONSTRAINED_ID_CHUNK_SIZE) {
    const idChunk = orderedIds.slice(start, start + CONSTRAINED_ID_CHUNK_SIZE);
    const stateBytesChunk = await Promise.all(
      idChunk.map((workflowId) => internals.storage.get(KEYS.workflow(workflowId))),
    );
    const searchAttributesByWorkflowId = await readSearchAttributesForStates(
      internals,
      stateBytesChunk,
      normalizedFilter,
    );
    const matchingStates: WorkflowState[] = [];
    for (const stateBytes of stateBytesChunk) {
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
    await accumulateAggregateStates(
      internals,
      matchingStates,
      groupBy,
      distinctKeyCap,
      accumulator,
      searchAttributesByWorkflowId,
    );
  }
}

/** Phase — full `wf:` prefix scan with scan-cap enforcement. */
async function accumulateFromFullScan(
  internals: EngineInternals,
  normalizedFilter: ListFilter,
  normalizedTagFilters: readonly string[] | undefined,
  groupBy: AggregateGroupBy,
  distinctKeyCap: number,
  accumulator: AggregateAccumulator,
): Promise<void> {
  let scanned = 0;
  let matchingStates: WorkflowState[] = [];
  let matchingSearchAttributesByWorkflowId = new Map<
    string,
    Record<string, SearchAttributeValue> | null
  >();
  for await (const [storageKey, value] of internals.storage.scan('wf:')) {
    if (!isTopLevelWorkflowStateKey(storageKey)) continue;
    scanned += 1;
    if (scanned > MAX_LIST_SCAN_ROWS) {
      throw new WorkflowListScanCapExceededError(MAX_LIST_SCAN_ROWS);
    }
    const state = decodeWorkflowState(value);
    const searchAttributes = await readSearchAttributesForFilter(
      internals,
      state.id,
      normalizedFilter,
    );
    if (!matchesListFilter(state, normalizedFilter, null, normalizedTagFilters, searchAttributes)) {
      continue;
    }
    matchingStates.push(state);
    if (searchAttributes !== null) {
      matchingSearchAttributesByWorkflowId.set(state.id, searchAttributes);
    }
    if (matchingStates.length === CONSTRAINED_ID_CHUNK_SIZE) {
      await accumulateAggregateStates(
        internals,
        matchingStates,
        groupBy,
        distinctKeyCap,
        accumulator,
        matchingSearchAttributesByWorkflowId,
      );
      matchingStates = [];
      matchingSearchAttributesByWorkflowId = new Map();
    }
  }
  if (matchingStates.length > 0) {
    await accumulateAggregateStates(
      internals,
      matchingStates,
      groupBy,
      distinctKeyCap,
      accumulator,
      matchingSearchAttributesByWorkflowId,
    );
  }
}

/** Phase — sort the bucket map, truncate to the requested limit, and finalize the result. */
function finalizeAggregateResult(
  accumulator: AggregateAccumulator,
  requestedLimit: number,
): AggregateResult {
  const sortedGroups: AggregateGroup[] = [...accumulator.counts.entries()]
    .map(([groupKey, count]) => ({ key: groupKey, count }))
    .toSorted((left, right) => {
      if (left.count !== right.count) return right.count - left.count;
      const leftKey = left.key ?? '';
      const rightKey = right.key ?? '';
      if (leftKey < rightKey) return -1;
      if (leftKey > rightKey) return 1;
      return 0;
    });

  const truncated = sortedGroups.length > requestedLimit;
  const groups = truncated ? sortedGroups.slice(0, requestedLimit) : sortedGroups;
  return { total: accumulator.total, groups, truncated };
}

/**
 * Aggregate workflows by a single dimension. The filter shape matches
 * `engine.list()`; `limit` and `offset` on the filter are ignored
 * (aggregation always considers every candidate that passes the rest of
 * the filter). The aggregate `limit` bounds the returned groups instead.
 */
export async function aggregate(
  internals: EngineInternals,
  filter: ListFilter | undefined,
  options: AggregateOptions,
  executionOptions: AggregateExecutionOptions = {},
): Promise<AggregateResult> {
  const { normalizedFilter, groupBy, requestedLimit, distinctKeyCap } = validateAggregateInputs(
    internals,
    filter,
    options,
    executionOptions,
  );

  const normalizedTagFilters = normalizeWorkflowTags(normalizedFilter.tags);
  // The aggregate path resolves candidates exactly like `list()`. Reuse the
  // shared helper so the watermark gate, idPrefix scan, and new visibility
  // indexes apply consistently across both surfaces.
  const constrainedIds = await resolveListCandidateIds(
    internals,
    normalizedFilter,
    normalizedTagFilters,
  );

  const accumulator: AggregateAccumulator = { counts: new Map(), total: 0 };

  if (constrainedIds !== null) {
    await accumulateFromConstrainedIds(
      internals,
      constrainedIds,
      normalizedFilter,
      normalizedTagFilters,
      groupBy,
      distinctKeyCap,
      accumulator,
    );
  } else {
    await accumulateFromFullScan(
      internals,
      normalizedFilter,
      normalizedTagFilters,
      groupBy,
      distinctKeyCap,
      accumulator,
    );
  }

  return finalizeAggregateResult(accumulator, requestedLimit);
}

// Re-exports for callers that only need to discriminate result shape.
export type { AggregateGroupBy, AggregateOptions };
