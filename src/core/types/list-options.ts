import type { FailureCategory, WorkflowStatus } from './identity.ts';
import type { SearchAttributeHandle, SearchAttributeValue } from './search-attributes.ts';

// ---------------------------------------------------------------------------
// List/filter options
// ---------------------------------------------------------------------------

/**
 * Numeric half-open range bound, used by visibility filters that match a
 * stored numeric field (timestamps, deadlines). Provide at least one of the
 * four bounds. `gt`/`gte` are mutually exclusive on the lower side; `lt`/`lte`
 * are mutually exclusive on the upper side.
 */
export interface TimeRange {
  gte?: number;
  lte?: number;
  gt?: number;
  lt?: number;
}

/**
 * Filter passed to {@link Engine.list} (and equivalent visibility transports)
 * to narrow which {@link WorkflowSummary} entries are returned. Every field
 * is optional; combining fields applies them as AND.
 *
 * @example
 * ```ts
 * import { Engine, type ListFilter } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * const filter: ListFilter = {
 *   status: ['running', 'failed'],
 *   createdAt: { gte: Date.now() - 60_000 },
 * };
 *
 * const page = await engine.list(filter);
 * ```
 */
export interface ListFilter {
  /** Match workflows whose {@link WorkflowState.status} is one of the listed values. */
  status?: WorkflowStatus | WorkflowStatus[];
  /**
   * Match workflows by registered workflow type (e.g. `'order-fulfillment'`).
   *
   * @example
   * ```ts
   * import type { ListFilter } from '@lostgradient/weft';
   * const filter: ListFilter = { type: 'order-fulfillment' };
   * ```
   */
  type?: string;
  /** Match workflow runs launched by this recurring schedule. */
  scheduleId?: string;
  /** Match workflows that carry every listed tag. */
  tags?: string[];
  /** Filter on indexed search attributes (equality, string any-of, or range). */
  attributes?: readonly AttributeFilter[];
  /** Maximum number of summaries to return. Server enforces an upper bound. */
  limit?: number;
  /** Number of summaries to skip before returning results. */
  offset?: number;
  /**
   * Workflow id prefix. Restricted to `[A-Za-z0-9_-]+`; values containing
   * other characters are rejected during validation. Matches by raw
   * `state.id.startsWith(idPrefix)` after candidate enumeration.
   */
  idPrefix?: string;
  /** Range filter on `WorkflowState.createdAt` (ms epoch). */
  createdAt?: TimeRange;
  /** Range filter on `WorkflowState.updatedAt` (ms epoch). */
  updatedAt?: TimeRange;
  /** Range filter on `WorkflowState.executionDeadline` (ms epoch). */
  executionDeadline?: TimeRange;
  /**
   * Match by the workflow's `failureCategory`. The engine uses the
   * `failureCategory` search-attribute index to narrow candidate workflow IDs,
   * then still verifies the loaded `WorkflowState.failureCategory` so state
   * remains authoritative when index entries are stale.
   */
  failureCategory?: FailureCategory | FailureCategory[];
}

/**
 * Projection options for {@link Engine.list}. These options do not change
 * which workflows match the list filter; they only control optional summary
 * fields that may require additional storage reads.
 *
 * @example Include failure categories projected from search attributes
 * ```ts
 * import { Engine, type ListOptions } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * const options: ListOptions = { includeFailureCategory: true };
 * const page = await engine.list({ status: 'failed' }, options);
 * void page;
 * ```
 */
export interface ListOptions {
  /**
   * Populate `WorkflowSummary.failureCategory` for failed workflows from the
   * stored `failureCategory` search attribute when the workflow state itself
   * does not carry a category. Defaults to `false`.
   */
  includeFailureCategory?: boolean;
}

export type AttributeFilterKey = string | SearchAttributeHandle;

export type AttributeFilterScalarValue = Exclude<SearchAttributeValue, string[]>;

export type AttributeFilterValue<TKey extends AttributeFilterKey> =
  TKey extends SearchAttributeHandle<infer TValue>
    ? TValue extends string[]
      ? string
      : TValue
    : AttributeFilterScalarValue;

export type AttributeFilterAnyOfValue<TKey extends AttributeFilterKey> =
  TKey extends SearchAttributeHandle<infer TValue>
    ? TValue extends string[]
      ? string[]
      : TValue extends AttributeFilterScalarValue
        ? TValue[]
        : never
    : AttributeFilterScalarValue[];

export type AttributeRangeValue<TKey extends AttributeFilterKey> =
  TKey extends SearchAttributeHandle<infer TValue>
    ? Extract<TValue, Date | number>
    : AttributeFilterScalarValue;

export type AttributeFilter<TKey extends AttributeFilterKey = AttributeFilterKey> =
  TKey extends SearchAttributeHandle
    ?
        | {
            key: TKey;
            value?: AttributeFilterValue<TKey> | AttributeFilterAnyOfValue<TKey>;
            gt?: never;
            lt?: never;
            gte?: never;
            lte?: never;
          }
        | {
            key: TKey;
            value?: never;
            gt?: AttributeRangeValue<TKey>;
            lt?: AttributeRangeValue<TKey>;
            gte?: AttributeRangeValue<TKey>;
            lte?: AttributeRangeValue<TKey>;
          }
    : {
        key: TKey;
        /**
         * Match a single indexed scalar value, or provide a scalar array to match
         * any listed value for the same attribute.
         */
        value?: AttributeFilterScalarValue | AttributeFilterScalarValue[];
        gt?: AttributeRangeValue<TKey>;
        lt?: AttributeRangeValue<TKey>;
        gte?: AttributeRangeValue<TKey>;
        lte?: AttributeRangeValue<TKey>;
      };

export type AttributeFilterList<TAttributeKeys extends readonly AttributeFilterKey[]> = {
  readonly [TIndex in keyof TAttributeKeys]: AttributeFilter<TAttributeKeys[TIndex]>;
};

export type TypedListFilter<TAttributeKeys extends readonly AttributeFilterKey[]> = Omit<
  ListFilter,
  'attributes'
> & {
  attributes?: AttributeFilterList<TAttributeKeys>;
};

// ---------------------------------------------------------------------------
// Paginated result
// ---------------------------------------------------------------------------

/**
 * Generic paginated response envelope returned by list operations such as
 * {@link Engine.list} and `engine.listSchedules`. `total` is the full count
 * matching the filter; `items` is the current page slice. `items.length` is
 * bounded by `limit`; the consumer reaches the end of the result set when
 * `offset + items.length >= total`.
 */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}
