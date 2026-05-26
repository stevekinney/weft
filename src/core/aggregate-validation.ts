/**
 * Shared schema and normalizer for `engine.aggregate()` options — the
 * `groupBy` dimension and the optional `limit` on returned groups. Lives
 * in `core/` so in-process callers and the server operation share one
 * validation path.
 *
 * The list-filter portion of aggregate input is validated by
 * {@link normalizeListFilter} in `list-filter-validation.ts`; this module
 * covers only the aggregate-specific options.
 *
 * @module core/aggregate-validation
 */

import { z, type ZodIssue } from 'zod';

import { WeftError } from './weft-error.ts';

const attributeDimensionSchema = z.object({ attribute: z.string().min(1) }).strict();

const groupBySchema = z.union([
  z.literal('status'),
  z.literal('type'),
  z.literal('tenant'),
  z.literal('failureCategory'),
  attributeDimensionSchema,
]);

/**
 * Group-by dimension for `engine.aggregate()`. Either a fixed structural
 * dimension or an arbitrary search-attribute name.
 */
export type AggregateGroupBy =
  | 'status'
  | 'type'
  | 'tenant'
  | 'failureCategory'
  | { attribute: string };

/**
 * Validated options for `engine.aggregate()`. `limit` bounds the number
 * of groups returned; `undefined` means "use the engine default."
 */
export type AggregateOptions = {
  groupBy: AggregateGroupBy;
  limit?: number;
};

/**
 * Default and maximum bounds on the number of groups returned. Groups
 * over the requested limit set `truncated: true` on the response.
 */
export const AGGREGATE_DEFAULT_LIMIT = 1000;
export const AGGREGATE_MAX_LIMIT = 10_000;

/**
 * Hard cap on the number of distinct group keys the engine will
 * materialize for a single aggregate query. Exceeding it raises
 * {@link AggregateDistinctKeyCapExceededError}; transport layers map
 * the error to `Unprocessable`. The cap protects against an unbounded
 * group-by on a high-cardinality attribute exhausting memory; it is
 * never silently truncated because scan-order would bias which groups
 * "win."
 */
export const MAX_AGGREGATE_DISTINCT_KEYS = 100_000;

/**
 * Concrete object schema for {@link AggregateOptions}. Exported so the
 * server operation can `.extend()` it onto the list-filter schema.
 */
export const aggregateOptionsObjectSchema = z
  .object({
    groupBy: groupBySchema,
    limit: z.number().int().min(1).max(AGGREGATE_MAX_LIMIT).optional(),
  })
  .strict();

/** A flattened Zod issue suitable for cross-transport serialization. */
export type AggregateOptionsValidationIssue = {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
  readonly code: string;
};

function flattenIssue(issue: ZodIssue): AggregateOptionsValidationIssue {
  const path: Array<string | number> = [];
  for (const segment of issue.path) {
    if (typeof segment === 'string' || typeof segment === 'number') {
      path.push(segment);
    } else {
      path.push(String(segment));
    }
  }
  return { path, message: issue.message, code: issue.code };
}

/**
 * Thrown by {@link normalizeAggregateOptions} when input fails validation.
 * Carries flattened Zod issues so transport adapters can map directly to
 * the existing `InvalidParams` fault shape.
 */
export class AggregateOptionsValidationError extends WeftError<'AggregateOptionsValidationError'> {
  readonly issues: ReadonlyArray<AggregateOptionsValidationIssue>;

  constructor(issues: ReadonlyArray<AggregateOptionsValidationIssue>) {
    const summary = issues
      .map((issue) => {
        const path = issue.path.join('.');
        return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
      })
      .join('; ');
    super(
      'AggregateOptionsValidationError',
      summary.length > 0 ? summary : 'Invalid aggregate options',
    );
    this.issues = issues;
  }
}

/**
 * Thrown when an aggregate query would materialize more distinct group
 * keys than {@link MAX_AGGREGATE_DISTINCT_KEYS}. Caller is expected to
 * narrow the filter or pick a lower-cardinality `groupBy`.
 */
export class AggregateDistinctKeyCapExceededError extends WeftError<'AggregateDistinctKeyCapExceededError'> {
  readonly cap: number;

  constructor(cap: number) {
    super(
      'AggregateDistinctKeyCapExceededError',
      `Aggregate query would exceed the distinct-key cap of ${cap}. Narrow the filter or choose a lower-cardinality groupBy.`,
    );
    this.cap = cap;
  }
}

/**
 * Parse and validate aggregate options. Returns a typed copy on success;
 * throws {@link AggregateOptionsValidationError} on failure with
 * structured issues.
 */
export function normalizeAggregateOptions(input: unknown): AggregateOptions {
  const result = aggregateOptionsObjectSchema.safeParse(input ?? {});
  if (!result.success) {
    throw new AggregateOptionsValidationError(result.error.issues.map(flattenIssue));
  }
  const { groupBy, limit } = result.data;
  return { groupBy, ...(limit !== undefined && { limit }) };
}
