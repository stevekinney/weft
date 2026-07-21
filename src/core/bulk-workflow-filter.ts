import { searchAttributeName } from './search-attributes.ts';
import type { ListFilter } from './types.ts';
import { normalizeWorkflowTags } from './workflow-tags.ts';

const ID_PREFIX_MIN_LENGTH = 3;

export const BULK_WORKFLOW_FILTER_ERROR_MESSAGE =
  'Field "filter" must include at least one of status, type, scheduleId, tags, attributes, idPrefix (≥3 chars), or failureCategory paired with status';

/**
 * Discriminant for the closed set of `ListFilter` dimensions that, on
 * their own, narrow a bulk operation to a scoped subset. `failureCategory`
 * and the three time-range fields are intentionally absent — they require
 * pairing with one of these scopes.
 */
type BulkFilterDimension = 'status' | 'type' | 'scheduleId' | 'tags' | 'attributes' | 'idPrefix';

type BulkFilterDimensionCheck = (filter: ListFilter) => boolean;

function hasScopedStatusFilter(filter: ListFilter): boolean {
  if (filter.status === undefined) return false;
  if (Array.isArray(filter.status)) return filter.status.length > 0;
  return filter.status.length > 0;
}

function hasScopedTypeFilter(filter: ListFilter): boolean {
  return filter.type !== undefined && filter.type.trim().length > 0;
}

function hasScopedScheduleFilter(filter: ListFilter): boolean {
  return filter.scheduleId !== undefined && filter.scheduleId.trim().length > 0;
}

function hasScopedTagsFilter(filter: ListFilter): boolean {
  return (normalizeWorkflowTags(filter.tags)?.length ?? 0) > 0;
}

function hasScopedAttributesFilter(filter: ListFilter): boolean {
  return (
    filter.attributes?.some((attribute) => searchAttributeName(attribute.key).trim().length > 0) ??
    false
  );
}

function hasScopedIdPrefix(filter: ListFilter): boolean {
  return filter.idPrefix !== undefined && filter.idPrefix.length >= ID_PREFIX_MIN_LENGTH;
}

/**
 * Exhaustive lookup of "does this single dimension narrow a bulk
 * operation to a safe subset?". Keyed by {@link BulkFilterDimension} so
 * adding a new bulk scope requires extending the union and the table
 * together — the `satisfies` keeps the mapping exhaustive at compile time.
 *
 * `failureCategory` is intentionally not a key here: setting the
 * attribute on a non-failed workflow is permitted by the engine, so
 * "delete every workflow whose failureCategory is X" would be a footgun.
 * Pairing `failureCategory` with `status` is covered by the `status` key.
 * Time ranges (`createdAt`, `updatedAt`, `executionDeadline`) are also
 * intentionally absent — they must be combined with one of the keys here.
 */
const BULK_FILTER_DIMENSION_CHECKS = {
  status: hasScopedStatusFilter,
  type: hasScopedTypeFilter,
  scheduleId: hasScopedScheduleFilter,
  tags: hasScopedTagsFilter,
  attributes: hasScopedAttributesFilter,
  idPrefix: hasScopedIdPrefix,
} satisfies Record<BulkFilterDimension, BulkFilterDimensionCheck>;

/**
 * Returns `true` when the filter narrows destructive bulk operations
 * to a scoped subset rather than every workflow on the engine.
 *
 * Valid scopes:
 * - `status` (non-empty after normalization).
 * - `type` (non-empty after trim).
 * - `scheduleId` (non-empty after trim).
 * - `tags` (at least one tag after normalization).
 * - `attributes` (at least one attribute predicate with a non-empty key).
 * - `idPrefix` (length ≥ 3 — short prefixes match too much to be a safe scope).
 * - `failureCategory` is **not** a valid scope on its own — it must be
 *   combined with a non-empty status filter. The engine doesn't enforce
 *   the "failureCategory implies failed status" invariant (the attribute
 *   could theoretically be set on a non-failed workflow), so deleting on
 *   the attribute alone would be a footgun.
 * - Time ranges (`createdAt`, `updatedAt`, `executionDeadline`) are
 *   **not** valid scopes on their own — they must combine with another
 *   dimension from the list above.
 */
export function hasScopedBulkWorkflowFilter(filter: ListFilter): boolean {
  return Object.values(BULK_FILTER_DIMENSION_CHECKS).some((check) => check(filter));
}

export function assertScopedBulkWorkflowFilter(filter: ListFilter): ListFilter {
  if (!hasScopedBulkWorkflowFilter(filter)) {
    throw new Error(BULK_WORKFLOW_FILTER_ERROR_MESSAGE);
  }

  return filter;
}
