import type { ScanOptions } from '../../storage/interface.ts';
import {
  KEYS,
  encodeStorageKeyComponent,
  tryDecodeStorageKeyComponent,
} from '../../storage/interface.ts';
import { failureCategorySearchValues, isFailureCategory } from '../failure-categories.ts';
import { encodeAttributeValue, searchAttributeName } from '../search-attributes.ts';
import type { AttributeFilter, ListFilter, WorkflowState } from '../types.ts';
import { normalizeWorkflowTags } from '../workflow-tags.ts';
import type { EngineInternals } from './internals.ts';
import { intersectIdentifierSets, matchesListFilter } from './state-utilities.ts';
import { decodeWorkflowState } from './validation.ts';

const ATTRIBUTE_SCAN_CONCURRENCY = 8;

/** Stream decoded workflow states that match a list filter. */
export async function* streamMatchingWorkflowStates(
  internals: EngineInternals,
  filter?: ListFilter,
): AsyncGenerator<WorkflowState> {
  const normalizedTagFilters = normalizeWorkflowTags(filter?.tags);
  const constrainedIds = await resolveConstrainedIds(internals, filter, normalizedTagFilters);

  if (constrainedIds !== null) {
    for (const workflowId of constrainedIds) {
      const state = await loadMatchingWorkflowState(
        internals,
        workflowId,
        filter,
        constrainedIds,
        normalizedTagFilters,
      );
      if (state === null) continue;
      yield state;
    }

    return;
  }

  for await (const [key, value] of internals.storage.scan('wf:')) {
    if (!isTopLevelWorkflowStateKey(key)) continue;

    const state = decodeWorkflowState(value);
    if (!matchesListFilter(state, filter, constrainedIds, normalizedTagFilters)) continue;
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
  if (!matchesListFilter(state, filter, constrainedIds, normalizedTagFilters)) return null;
  return state;
}

/** Resolve the indexed workflow IDs implied by tag and search-attribute filters. */
// oxlint-disable-next-line complexity -- ID:core-engine-resolve-constrained-ids-complexity
export async function resolveConstrainedIds(
  internals: EngineInternals,
  filter: ListFilter | undefined,
  normalizedTagFilters: readonly string[] | undefined,
): Promise<Set<string> | null> {
  const attributeFilters = filter?.attributes;
  const hasAttributeFilters = attributeFilters !== undefined && attributeFilters.length > 0;
  const hasTagFilters = normalizedTagFilters !== undefined && normalizedTagFilters.length > 0;

  if (!hasAttributeFilters && !hasTagFilters) {
    return null;
  }

  // Bound concurrency so a request with many attribute filters can't
  // saturate a connection-limited storage backend with N parallel scans.
  const queries: Array<() => Promise<Set<string>>> = [];
  if (normalizedTagFilters) {
    for (const tag of normalizedTagFilters) {
      queries.push(() => queryTagIndex(internals, tag));
    }
  }
  if (attributeFilters) {
    for (const attributeFilter of attributeFilters) {
      queries.push(() => queryAttributeIndex(internals, attributeFilter));
    }
  }

  const idSets: Array<Set<string> | undefined> = Array.from({ length: queries.length });
  const workerLimit = Math.max(1, Math.min(ATTRIBUTE_SCAN_CONCURRENCY, queries.length));
  let nextIndex = 0;
  const runWorker = async (): Promise<void> => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= queries.length) return;
      idSets[currentIndex] = await queries[currentIndex]!();
    }
  };
  const workers: Promise<void>[] = [];
  for (let workerIndex = 0; workerIndex < workerLimit; workerIndex += 1) {
    workers.push(runWorker());
  }
  await Promise.all(workers);

  const completedIdSets: Set<string>[] = [];
  for (const idSet of idSets) {
    if (idSet === undefined) {
      throw new Error('Attribute index query did not produce a workflow ID set.');
    }
    completedIdSets.push(idSet);
  }

  return intersectIdentifierSets(completedIdSets);
}

/** Query a single search-attribute index filter and return matching workflow IDs. */
// oxlint-disable-next-line complexity -- ID:core-engine-query-attribute-index-complexity
async function queryAttributeIndex(
  internals: EngineInternals,
  filter: AttributeFilter,
): Promise<Set<string>> {
  const ids = new Set<string>();
  const attributeName = searchAttributeName(filter.key);
  const prefix = `idx:${attributeName}:`;

  if (filter.value !== undefined) {
    const values =
      filter.key === 'failureCategory' && isFailureCategory(filter.value)
        ? failureCategorySearchValues(filter.value)
        : [filter.value];
    for (const value of values) {
      const encodedValue = encodeAttributeValue(value);
      const exactPrefix = `idx:${attributeName}:${encodedValue}:`;
      for await (const [key] of internals.storage.scan(exactPrefix)) {
        const workflowId = tryDecodeStorageKeyComponent(key.slice(exactPrefix.length));
        if (workflowId !== null) {
          ids.add(workflowId);
        }
      }
    }
  } else {
    const scanOptions: ScanOptions = {};
    if (filter.gte !== undefined) {
      scanOptions.gte = `idx:${attributeName}:${encodeAttributeValue(filter.gte)}:`;
    }
    if (filter.gt !== undefined) {
      scanOptions.gt = `idx:${attributeName}:${encodeAttributeValue(filter.gt)}:\xff`;
    }
    if (filter.lte !== undefined) {
      const encodedLte = encodeAttributeValue(filter.lte);
      scanOptions.lte = `idx:${attributeName}:${encodedLte}:\xff`;
    }
    if (filter.lt !== undefined) {
      scanOptions.lt = `idx:${attributeName}:${encodeAttributeValue(filter.lt)}:`;
    }

    for await (const [key] of internals.storage.scan(prefix, scanOptions)) {
      const afterPrefix = key.slice(prefix.length);
      const lastColon = afterPrefix.lastIndexOf(':');
      if (lastColon >= 0) {
        const workflowId = tryDecodeStorageKeyComponent(afterPrefix.slice(lastColon + 1));
        if (workflowId !== null) {
          ids.add(workflowId);
        }
      }
    }
  }

  return ids;
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
