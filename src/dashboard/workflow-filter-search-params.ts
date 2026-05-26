import type { ListFilter, TimeRange } from './api-client-types.ts';

function appendOptionalSearchParam(
  params: URLSearchParams,
  key: string,
  value: string | number | undefined,
): void {
  if (value !== undefined) params.set(key, String(value));
}

function appendRepeatedSearchParam(
  params: URLSearchParams,
  key: string,
  values: readonly string[] | undefined,
): void {
  if (values === undefined) return;

  for (const value of values) params.append(key, value);
}

function appendScalarOrRepeatedSearchParam(
  params: URLSearchParams,
  key: string,
  value: string | readonly string[] | undefined,
): void {
  if (value === undefined) return;

  if (Array.isArray(value)) {
    appendRepeatedSearchParam(params, key, value);
    return;
  }

  params.set(key, String(value));
}

function appendTimeRangeParams(
  params: URLSearchParams,
  prefix: 'created_at' | 'updated_at' | 'execution_deadline',
  range: TimeRange | undefined,
): void {
  if (range === undefined) return;

  appendOptionalSearchParam(params, `${prefix}_gte`, range.gte);
  appendOptionalSearchParam(params, `${prefix}_gt`, range.gt);
  appendOptionalSearchParam(params, `${prefix}_lte`, range.lte);
  appendOptionalSearchParam(params, `${prefix}_lt`, range.lt);
}

export function buildWorkflowFilterSearchParams(filter: ListFilter | undefined): URLSearchParams {
  const params = new URLSearchParams();
  if (filter === undefined) return params;

  appendScalarOrRepeatedSearchParam(params, 'status', filter.status);
  appendOptionalSearchParam(params, 'type', filter.type);
  appendRepeatedSearchParam(params, 'tag', filter.tags);
  appendOptionalSearchParam(params, 'id_prefix', filter.idPrefix);
  appendScalarOrRepeatedSearchParam(params, 'failure_category', filter.failureCategory);
  appendTimeRangeParams(params, 'created_at', filter.createdAt);
  appendTimeRangeParams(params, 'updated_at', filter.updatedAt);
  appendTimeRangeParams(params, 'execution_deadline', filter.executionDeadline);

  return params;
}
