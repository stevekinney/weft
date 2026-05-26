/**
 * Shared candidate-id resolver used by both `engine.list()` and
 * `engine.aggregate()`. Reads the visibility-index watermark once,
 * fans every supported filter dimension out to its query helper when
 * the watermark is current, and intersects the results with the
 * existing tag/attribute resolution.
 *
 * Returns `null` when no filter narrows the candidate set — the caller
 * falls back to a full `wf:` prefix scan with post-filtering.
 *
 * @module core/engine/list-candidate-resolution
 */

import type { FailureCategory, ListFilter } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { intersectIdentifierSets } from './state-utilities.ts';
import { getWorkflowVisibilityWatermark } from './workflow-indexes.ts';
import { queryAttributeIndex, resolveConstrainedIds } from './workflow-state-stream.ts';
import {
  queryWorkflowIdPrefixCandidates,
  queryWorkflowStatusIndex,
  queryWorkflowTimeRangeIndex,
  queryWorkflowTypeIndex,
} from './workflow-visibility-queries.ts';

/**
 * Discriminant over every `ListFilter` dimension that the visibility
 * indexes can narrow before the post-filter pass. `idPrefix` is here
 * because the primary-key scan is always available even when the
 * visibility watermark is stale — see {@link resolveListCandidateIds}.
 */
type ListFilterDimension =
  | 'status'
  | 'type'
  | 'createdAt'
  | 'updatedAt'
  | 'executionDeadline'
  | 'idPrefix';

type VisibilityQueryHelper<TDimension extends ListFilterDimension> = (
  internals: EngineInternals,
  value: NonNullable<ListFilter[TDimension]>,
) => Promise<Set<string>>;

function queryStatusDimension(
  internals: EngineInternals,
  value: NonNullable<ListFilter['status']>,
): Promise<Set<string>> {
  const statuses = Array.isArray(value) ? value : [value];
  return queryWorkflowStatusIndex(internals.storage, statuses);
}

function queryTypeDimension(
  internals: EngineInternals,
  value: NonNullable<ListFilter['type']>,
): Promise<Set<string>> {
  return queryWorkflowTypeIndex(internals.storage, value);
}

function queryCreatedAtDimension(
  internals: EngineInternals,
  value: NonNullable<ListFilter['createdAt']>,
): Promise<Set<string>> {
  return queryWorkflowTimeRangeIndex(internals.storage, 'created', value);
}

function queryUpdatedAtDimension(
  internals: EngineInternals,
  value: NonNullable<ListFilter['updatedAt']>,
): Promise<Set<string>> {
  return queryWorkflowTimeRangeIndex(internals.storage, 'updated', value);
}

function queryExecutionDeadlineDimension(
  internals: EngineInternals,
  value: NonNullable<ListFilter['executionDeadline']>,
): Promise<Set<string>> {
  return queryWorkflowTimeRangeIndex(internals.storage, 'deadline', value);
}

function queryIdPrefixDimension(
  internals: EngineInternals,
  value: NonNullable<ListFilter['idPrefix']>,
): Promise<Set<string>> {
  return queryWorkflowIdPrefixCandidates(internals.storage, value);
}

/**
 * Exhaustive table from each visibility-index-backed `ListFilter`
 * dimension to its query helper. `satisfies` keeps the mapping pinned to
 * the {@link ListFilterDimension} union — adding a new indexed dimension
 * forces a matching table entry at compile time.
 */
const LIST_FILTER_DIMENSION_QUERIES = {
  status: queryStatusDimension,
  type: queryTypeDimension,
  createdAt: queryCreatedAtDimension,
  updatedAt: queryUpdatedAtDimension,
  executionDeadline: queryExecutionDeadlineDimension,
  idPrefix: queryIdPrefixDimension,
} satisfies { [K in ListFilterDimension]: VisibilityQueryHelper<K> };

function collectVisibilityQueries(
  internals: EngineInternals,
  filter: ListFilter,
  dimensions: readonly ListFilterDimension[],
): Array<Promise<Set<string>>> {
  const queries: Array<Promise<Set<string>>> = [];
  for (const dimension of dimensions) {
    const value = filter[dimension];
    if (value === undefined) continue;
    // The `satisfies` clause on LIST_FILTER_DIMENSION_QUERIES guarantees
    // the helper at `dimension` accepts `NonNullable<ListFilter[dimension]>`.
    const query = LIST_FILTER_DIMENSION_QUERIES[dimension] as (
      internals: EngineInternals,
      value: unknown,
    ) => Promise<Set<string>>;
    queries.push(query(internals, value));
  }
  return queries;
}

export async function resolveListCandidateIds(
  internals: EngineInternals,
  filter: ListFilter | undefined,
  normalizedTagFilters: readonly string[] | undefined,
): Promise<Set<string> | null> {
  const [baseConstrainedIds, failureCategoryCandidateIds] = await Promise.all([
    resolveConstrainedIds(internals, filter, normalizedTagFilters),
    resolveFailureCategoryCandidateIds(internals, filter?.failureCategory),
  ]);

  const watermark = await getWorkflowVisibilityWatermark(internals.storage);

  if (watermark === 'stale') {
    // idPrefix is independent of the watermark — primary-key scan is always available.
    const queries =
      filter === undefined ? [] : collectVisibilityQueries(internals, filter, ['idPrefix']);
    const visibilitySets = await Promise.all(queries);
    return combineCandidateSets([
      baseConstrainedIds,
      failureCategoryCandidateIds,
      ...visibilitySets,
    ]);
  }

  const indexedDimensions: readonly ListFilterDimension[] = [
    'status',
    'type',
    'createdAt',
    'updatedAt',
    'executionDeadline',
    'idPrefix',
  ];
  const visibilityQueries =
    filter === undefined ? [] : collectVisibilityQueries(internals, filter, indexedDimensions);

  if (visibilityQueries.length === 0) {
    return combineCandidateSets([baseConstrainedIds, failureCategoryCandidateIds]);
  }

  const visibilitySets = await Promise.all(visibilityQueries);
  return combineCandidateSets([baseConstrainedIds, failureCategoryCandidateIds, ...visibilitySets]);
}

async function resolveFailureCategoryCandidateIds(
  internals: EngineInternals,
  failureCategory: FailureCategory | readonly FailureCategory[] | undefined,
): Promise<Set<string> | null> {
  if (failureCategory === undefined) return null;

  const categories = Array.isArray(failureCategory) ? failureCategory : [failureCategory];
  const categorySets = await Promise.all(
    categories.map((category) =>
      queryAttributeIndex(internals, { key: 'failureCategory', value: category }),
    ),
  );

  const ids = new Set<string>();
  for (const categorySet of categorySets) {
    for (const workflowId of categorySet) {
      ids.add(workflowId);
    }
  }
  return ids;
}

function combineCandidateSets(candidateSets: readonly (Set<string> | null)[]): Set<string> | null {
  const presentSets = candidateSets.filter((set): set is Set<string> => set !== null);
  if (presentSets.length === 0) return null;
  return intersectIdentifierSets(presentSets);
}
