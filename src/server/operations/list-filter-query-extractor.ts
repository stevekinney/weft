/**
 * Shared REST query-parameter extractor for the `ListFilter` shape. Both
 * `GET /v1/workflows` and `GET /v1/workflows/aggregate` accept the same
 * filter dimensions, so the parsing lives here to keep the two endpoints
 * in lock-step.
 *
 * @module server/operations/list-filter-query-extractor
 */

import type {
  AttributeFilter,
  FailureCategory,
  ListFilter,
  TimeRange,
  WorkflowStatus,
} from '../../core/types.ts';
import { parseAttributeFilters } from '../attribute-filters.ts';

/**
 * Discriminant over every `ListFilter` dimension that the REST surface
 * parses out of the query string. `limit`/`offset` live on pagination
 * helpers, not on the filter parser, so they are intentionally absent.
 */
type ListFilterDimension =
  | 'status'
  | 'type'
  | 'tags'
  | 'attributes'
  | 'idPrefix'
  | 'failureCategory'
  | 'createdAt'
  | 'updatedAt'
  | 'executionDeadline';

/** Parser for one `ListFilter` dimension. `undefined` means "not present in the query". */
type ListFilterQueryParser<TDimension extends ListFilterDimension> = (
  params: URLSearchParams,
) => ListFilter[TDimension] | undefined;

function parseStatus(params: URLSearchParams): ListFilter['status'] | undefined {
  const statuses = params.getAll('status') as WorkflowStatus[];
  if (statuses.length === 0) return undefined;
  if (statuses.length === 1) return statuses[0]!;
  return statuses;
}

function parseType(params: URLSearchParams): ListFilter['type'] | undefined {
  const type = params.get('type');
  return type === null ? undefined : type;
}

function parseTags(params: URLSearchParams): ListFilter['tags'] | undefined {
  const tags = params.getAll('tag');
  return tags.length > 0 ? tags : undefined;
}

function parseAttributes(params: URLSearchParams): ListFilter['attributes'] | undefined {
  const attributeFilters = parseAttributeFilters(params);
  if (attributeFilters.length === 0) return undefined;
  return attributeFilters.map((attribute) => ({
    key: attribute.key,
    ...(attribute.value === undefined ? {} : { value: attribute.value }),
    ...(attribute.gt === undefined ? {} : { gt: attribute.gt }),
    ...(attribute.lt === undefined ? {} : { lt: attribute.lt }),
    ...(attribute.gte === undefined ? {} : { gte: attribute.gte }),
    ...(attribute.lte === undefined ? {} : { lte: attribute.lte }),
  })) as readonly AttributeFilter[];
}

function parseIdPrefix(params: URLSearchParams): ListFilter['idPrefix'] | undefined {
  const idPrefix = params.get('id_prefix');
  return idPrefix === null ? undefined : idPrefix;
}

function parseFailureCategory(params: URLSearchParams): ListFilter['failureCategory'] | undefined {
  const categories = params.getAll('failure_category') as FailureCategory[];
  if (categories.length === 0) return undefined;
  if (categories.length === 1) return categories[0]!;
  return categories;
}

function parseCreatedAt(params: URLSearchParams): TimeRange | undefined {
  return extractTimeRangeFromQuery(params, 'created_at');
}

function parseUpdatedAt(params: URLSearchParams): TimeRange | undefined {
  return extractTimeRangeFromQuery(params, 'updated_at');
}

function parseExecutionDeadline(params: URLSearchParams): TimeRange | undefined {
  return extractTimeRangeFromQuery(params, 'execution_deadline');
}

/**
 * Exhaustive table from `ListFilter` dimension to its query-string parser.
 * The `satisfies` clause keeps the mapping in lock-step with the
 * {@link ListFilterDimension} union — adding a new dimension forces a
 * matching parser entry at compile time.
 */
const LIST_FILTER_QUERY_PARSERS = {
  status: parseStatus,
  type: parseType,
  tags: parseTags,
  attributes: parseAttributes,
  idPrefix: parseIdPrefix,
  failureCategory: parseFailureCategory,
  createdAt: parseCreatedAt,
  updatedAt: parseUpdatedAt,
  executionDeadline: parseExecutionDeadline,
} satisfies { [K in ListFilterDimension]: ListFilterQueryParser<K> };

/**
 * Extract every supported `ListFilter` dimension from a request URL's
 * query string. `limit` and `offset` are NOT extracted — callers that
 * support pagination layer them on top.
 */
export function extractListFilterFromQuery(url: URL): ListFilter {
  const params = url.searchParams;
  const filter: ListFilter = {};
  for (const [dimension, parse] of Object.entries(LIST_FILTER_QUERY_PARSERS) as Array<
    [ListFilterDimension, (params: URLSearchParams) => unknown]
  >) {
    const value = parse(params);
    if (value === undefined) continue;
    // Each parser is keyed by its own dimension, so the assignment is
    // type-safe by construction. The `as never` keeps the assignment
    // index-signature-safe without weakening the per-parser return type.
    (filter[dimension] as unknown) = value;
  }
  return filter;
}

/**
 * Parse one of the three `*_at` time-range filters from the query
 * string. The four bounds map to `{prefix}_gte`, `{prefix}_gt`,
 * `{prefix}_lte`, `{prefix}_lt`. Returns `undefined` when none of the
 * bounds were specified so the omitted-vs-empty distinction is preserved
 * for the downstream `normalizeListFilter` validation.
 */
export function extractTimeRangeFromQuery(
  params: URLSearchParams,
  prefix: 'created_at' | 'updated_at' | 'execution_deadline',
): TimeRange | undefined {
  const range: TimeRange = {};
  const gte = params.get(`${prefix}_gte`);
  if (gte !== null && Number.isFinite(Number(gte))) range.gte = Number(gte);
  const gt = params.get(`${prefix}_gt`);
  if (gt !== null && Number.isFinite(Number(gt))) range.gt = Number(gt);
  const lte = params.get(`${prefix}_lte`);
  if (lte !== null && Number.isFinite(Number(lte))) range.lte = Number(lte);
  const lt = params.get(`${prefix}_lt`);
  if (lt !== null && Number.isFinite(Number(lt))) range.lt = Number(lt);
  return Object.keys(range).length > 0 ? range : undefined;
}
