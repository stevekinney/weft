import type { ScanOptions } from '../../storage/interface.ts';
import {
  KEYS,
  encodeStorageKeyComponent,
  tryDecodeStorageKeyComponent,
} from '../../storage/interface.ts';
import { failureCategorySearchValues, isFailureCategory } from '../failure-categories.ts';
import { encodeAttributeValue, searchAttributeName } from '../search-attributes.ts';
import type {
  AttributeFilter,
  AttributeFilterScalarValue,
  ListFilter,
  SearchAttributeValue,
  WorkflowState,
} from '../types.ts';
import { normalizeWorkflowTags } from '../workflow-tags.ts';
import { CONSTRAINED_ID_CHUNK_SIZE } from './candidate-read-batching.ts';
import type { EngineInternals } from './internals.ts';
import {
  attributeFilterExactValues,
  decodeSearchAttributeRecord,
  intersectIdentifierSets,
  listFilterHasAttributeFilters,
  matchesListFilter,
} from './state-utilities.ts';
import { decodeWorkflowState } from './validation.ts';
import { MAX_LIST_SCAN_ROWS, WorkflowListScanCapExceededError } from './workflow-indexes.ts';

const ATTRIBUTE_SCAN_CONCURRENCY = 8;

/** Stream decoded workflow states that match a list filter. */
export async function* streamMatchingWorkflowStates(
  internals: EngineInternals,
  filter?: ListFilter,
): AsyncGenerator<WorkflowState> {
  const normalizedTagFilters = normalizeWorkflowTags(filter?.tags);
  const constrainedIds = await resolveConstrainedIds(internals, filter, normalizedTagFilters);

  if (constrainedIds !== null) {
    const orderedIds = [...constrainedIds];
    for (let start = 0; start < orderedIds.length; start += CONSTRAINED_ID_CHUNK_SIZE) {
      const chunkIds = orderedIds.slice(start, start + CONSTRAINED_ID_CHUNK_SIZE);
      const chunkStates = await Promise.all(
        chunkIds.map((workflowId) =>
          loadMatchingWorkflowState(
            internals,
            workflowId,
            filter,
            constrainedIds,
            normalizedTagFilters,
          ),
        ),
      );
      for (const state of chunkStates) {
        if (state === null) continue;
        yield state;
      }
    }

    return;
  }

  for await (const [key, value] of internals.storage.scan('wf:')) {
    if (!isTopLevelWorkflowStateKey(key)) continue;

    const state = decodeWorkflowState(value);
    const searchAttributes = await readSearchAttributesForFilter(internals, state.id, filter);
    if (!matchesListFilter(state, filter, constrainedIds, normalizedTagFilters, searchAttributes)) {
      continue;
    }
    yield state;
  }
}

async function loadMatchingWorkflowState(
  internals: EngineInternals,
  workflowId: string,
  filter: ListFilter | undefined,
  constrainedIds: Set<string> | null,
  normalizedTagFilters: readonly string[] | undefined,
): Promise<WorkflowState | null> {
  const stateBytes = await internals.storage.get(KEYS.workflow(workflowId));
  if (!stateBytes) return null;

  const state = decodeWorkflowState(stateBytes);
  const searchAttributes = await readSearchAttributesForFilter(internals, workflowId, filter);
  if (!matchesListFilter(state, filter, constrainedIds, normalizedTagFilters, searchAttributes)) {
    return null;
  }
  return state;
}

async function readSearchAttributesForFilter(
  internals: EngineInternals,
  workflowId: string,
  filter: ListFilter | undefined,
): Promise<Record<string, SearchAttributeValue> | null> {
  if (!listFilterHasAttributeFilters(filter)) return null;
  return decodeSearchAttributeRecord(await internals.storage.get(KEYS.attribute(workflowId)));
}

/** Resolve indexed workflow IDs implied by schedule, tag, and search-attribute filters. */
export async function resolveConstrainedIds(
  internals: EngineInternals,
  filter: ListFilter | undefined,
  normalizedTagFilters: readonly string[] | undefined,
): Promise<Set<string> | null> {
  const attributeFilters = filter?.attributes;
  const hasAttributeFilters = attributeFilters !== undefined && attributeFilters.length > 0;
  const hasTagFilters = normalizedTagFilters !== undefined && normalizedTagFilters.length > 0;
  const hasScheduleFilter = filter?.scheduleId !== undefined;

  if (!hasAttributeFilters && !hasTagFilters && !hasScheduleFilter) {
    return null;
  }

  const queries = buildConstrainedIdQueries(
    internals,
    normalizedTagFilters,
    attributeFilters,
    filter?.scheduleId,
  );
  return intersectIdentifierSets(await runConstrainedIdQueries(queries));
}

/** Query a single search-attribute index filter and return matching workflow IDs. */
export async function queryAttributeIndex(
  internals: EngineInternals,
  filter: AttributeFilter,
): Promise<Set<string>> {
  const ids = new Set<string>();
  const attributeName = searchAttributeName(filter.key);
  const prefix = `idx:${attributeName}:`;

  if (filter.value !== undefined) {
    await collectExactAttributeMatches(internals, filter, attributeName, ids);
  } else {
    await collectRangeAttributeMatches(internals, filter, prefix, ids);
  }

  return ids;
}

function buildConstrainedIdQueries(
  internals: EngineInternals,
  normalizedTagFilters: readonly string[] | undefined,
  attributeFilters: readonly AttributeFilter[] | undefined,
  scheduleId: string | undefined,
): Array<() => Promise<Set<string>>> {
  return [
    ...(scheduleId === undefined ? [] : [() => queryScheduleRunIndex(internals, scheduleId)]),
    ...(normalizedTagFilters?.map((tag) => () => queryTagIndex(internals, tag)) ?? []),
    ...(attributeFilters?.map(
      (attributeFilter) => () => queryAttributeIndex(internals, attributeFilter),
    ) ?? []),
  ];
}

/** Resolve the durable reverse index from a schedule id to launched workflow ids. */
export async function queryScheduleRunIndex(
  internals: EngineInternals,
  scheduleId: string,
): Promise<Set<string>> {
  const workflowIds = new Set<string>();
  const prefix = KEYS.scheduleRunBySchedulePrefix(scheduleId);
  for await (const [key] of internals.storage.scan(prefix)) {
    if (workflowIds.size >= MAX_LIST_SCAN_ROWS) {
      throw new WorkflowListScanCapExceededError(MAX_LIST_SCAN_ROWS);
    }
    const encodedWorkflowId = key.slice(prefix.length);
    const workflowId = tryDecodeStorageKeyComponent(encodedWorkflowId);
    if (workflowId !== null) workflowIds.add(workflowId);
  }
  return workflowIds;
}

async function runConstrainedIdQueries(
  queries: Array<() => Promise<Set<string>>>,
): Promise<Set<string>[]> {
  const idSets: Array<Set<string> | undefined> = Array.from({ length: queries.length });
  let nextIndex = 0;
  const runWorker = async (): Promise<void> => {
    while (nextIndex < queries.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      idSets[currentIndex] = await queries[currentIndex]!();
    }
  };

  const workerLimit = Math.max(1, Math.min(ATTRIBUTE_SCAN_CONCURRENCY, queries.length));
  await Promise.all(Array.from({ length: workerLimit }, () => runWorker()));
  return idSets.map(requireConstrainedIdSet);
}

function requireConstrainedIdSet(idSet: Set<string> | undefined): Set<string> {
  if (idSet === undefined) {
    throw new Error('Attribute index query did not produce a workflow ID set.');
  }

  return idSet;
}

async function collectExactAttributeMatches(
  internals: EngineInternals,
  filter: AttributeFilter,
  attributeName: string,
  ids: Set<string>,
): Promise<void> {
  const exactValues = attributeFilterExactValues(filter);
  if (exactValues === null) return;

  const values: AttributeFilterScalarValue[] = [];
  for (const exactValue of exactValues) {
    if (filter.key === 'failureCategory' && isFailureCategory(exactValue)) {
      values.push(...failureCategorySearchValues(exactValue));
    } else {
      values.push(exactValue);
    }
  }

  for (const value of values) {
    const exactPrefix = `idx:${attributeName}:${encodeAttributeValue(value)}:`;
    for await (const [key] of internals.storage.scan(exactPrefix)) {
      addWorkflowIdFromIndexKey(ids, key.slice(exactPrefix.length));
    }
  }
}

async function collectRangeAttributeMatches(
  internals: EngineInternals,
  filter: AttributeFilter,
  prefix: string,
  ids: Set<string>,
): Promise<void> {
  for await (const [key] of internals.storage.scan(prefix, attributeRangeScanOptions(filter))) {
    const afterPrefix = key.slice(prefix.length);
    const lastColon = afterPrefix.lastIndexOf(':');
    if (lastColon >= 0) {
      addWorkflowIdFromIndexKey(ids, afterPrefix.slice(lastColon + 1));
    }
  }
}

function attributeRangeScanOptions(filter: AttributeFilter): ScanOptions {
  const scanOptions: ScanOptions = {};
  if (filter.gte !== undefined) {
    scanOptions.gte = `idx:${searchAttributeName(filter.key)}:${encodeAttributeValue(filter.gte)}:`;
  }
  if (filter.gt !== undefined) {
    scanOptions.gt = `idx:${searchAttributeName(filter.key)}:${encodeAttributeValue(filter.gt)}:\xff`;
  }
  if (filter.lte !== undefined) {
    scanOptions.lte = `idx:${searchAttributeName(filter.key)}:${encodeAttributeValue(filter.lte)}:\xff`;
  }
  if (filter.lt !== undefined) {
    scanOptions.lt = `idx:${searchAttributeName(filter.key)}:${encodeAttributeValue(filter.lt)}:`;
  }
  return scanOptions;
}

function addWorkflowIdFromIndexKey(ids: Set<string>, encodedWorkflowId: string): void {
  const workflowId = tryDecodeStorageKeyComponent(encodedWorkflowId);
  if (workflowId !== null) {
    ids.add(workflowId);
  }
}

/** Query the workflow tag index and return matching workflow IDs. */
async function queryTagIndex(internals: EngineInternals, tag: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const prefix = `tag:${encodeStorageKeyComponent(tag)}:`;

  for await (const [key] of internals.storage.scan(prefix)) {
    const workflowId = tryDecodeStorageKeyComponent(key.slice(prefix.length));
    if (workflowId !== null) {
      ids.add(workflowId);
    }
  }

  return ids;
}

export function isTopLevelWorkflowStateKey(key: string): boolean {
  const idPart = key.slice(3);
  return !idPart.includes(':');
}
