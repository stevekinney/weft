import {
  searchAttributeName,
  type ListFilter,
  type ReviewListFilter,
  type TimeRange,
} from '../core/types.ts';

function appendStatusFilters(params: URLSearchParams, status: ListFilter['status']): void {
  if (status === undefined) {
    return;
  }

  const statuses = (Array.isArray(status) ? status : [status]).filter(Boolean);
  for (const value of statuses) {
    params.append('status', value);
  }
}

function appendTagFilters(params: URLSearchParams, tags: ListFilter['tags']): void {
  if (tags === undefined) {
    return;
  }

  for (const tag of tags) {
    params.append('tag', tag);
  }
}

function appendAttributeFilters(
  params: URLSearchParams,
  attributes: ListFilter['attributes'],
): void {
  if (attributes === undefined) {
    return;
  }

  for (const attribute of attributes) {
    const key = searchAttributeName(attribute.key);

    if (attribute.value !== undefined) {
      params.set(`attr.${key}`, String(attribute.value));
    }
    if (attribute.gt !== undefined) {
      params.set(`attr.${key}.gt`, String(attribute.gt));
    }
    if (attribute.lt !== undefined) {
      params.set(`attr.${key}.lt`, String(attribute.lt));
    }
    if (attribute.gte !== undefined) {
      params.set(`attr.${key}.gte`, String(attribute.gte));
    }
    if (attribute.lte !== undefined) {
      params.set(`attr.${key}.lte`, String(attribute.lte));
    }
  }
}

function appendFailureCategoryFilters(
  params: URLSearchParams,
  failureCategory: ListFilter['failureCategory'],
): void {
  if (failureCategory === undefined) {
    return;
  }

  const categories = (Array.isArray(failureCategory) ? failureCategory : [failureCategory]).filter(
    Boolean,
  );
  for (const value of categories) {
    params.append('failure_category', value);
  }
}

function appendTimeRange(
  params: URLSearchParams,
  prefix: 'created_at' | 'updated_at' | 'execution_deadline',
  range: TimeRange | undefined,
): void {
  if (range === undefined) {
    return;
  }

  if (range.gte !== undefined) params.set(`${prefix}_gte`, String(range.gte));
  if (range.gt !== undefined) params.set(`${prefix}_gt`, String(range.gt));
  if (range.lte !== undefined) params.set(`${prefix}_lte`, String(range.lte));
  if (range.lt !== undefined) params.set(`${prefix}_lt`, String(range.lt));
}

function appendOptionalSearchParameter(
  params: URLSearchParams,
  key:
    | 'type'
    | 'schedule_id'
    | 'parent_workflow_id'
    | 'parent_workflow_execution_token'
    | 'id_prefix'
    | 'failed_step'
    | 'retrying'
    | 'limit'
    | 'offset',
  value: string | number | boolean | undefined,
): void {
  if (value !== undefined) params.set(key, String(value));
}

export function buildWorkflowListSearchParams(filter: ListFilter = {}): URLSearchParams {
  const params = new URLSearchParams();

  appendStatusFilters(params, filter.status);
  appendOptionalSearchParameter(params, 'type', filter.type);
  appendOptionalSearchParameter(params, 'schedule_id', filter.scheduleId);
  appendOptionalSearchParameter(params, 'parent_workflow_id', filter.parentWorkflowId);
  appendOptionalSearchParameter(
    params,
    'parent_workflow_execution_token',
    filter.parentWorkflowExecutionToken,
  );
  appendTagFilters(params, filter.tags);
  appendOptionalSearchParameter(params, 'id_prefix', filter.idPrefix);
  appendFailureCategoryFilters(params, filter.failureCategory);
  appendOptionalSearchParameter(params, 'failed_step', filter.failedStep);
  appendOptionalSearchParameter(params, 'retrying', filter.retrying);
  appendTimeRange(params, 'created_at', filter.createdAt);
  appendTimeRange(params, 'updated_at', filter.updatedAt);
  appendTimeRange(params, 'execution_deadline', filter.executionDeadline);
  appendOptionalSearchParameter(params, 'limit', filter.limit);
  appendOptionalSearchParameter(params, 'offset', filter.offset);
  appendAttributeFilters(params, filter.attributes);

  return params;
}

export function buildReviewListSearchParams(filter?: ReviewListFilter): URLSearchParams {
  const params = new URLSearchParams();

  if (filter?.status !== undefined) {
    params.set('status', filter.status);
  }
  if (filter?.workflowId !== undefined) {
    params.set('workflowId', filter.workflowId);
  }
  if (filter?.reviewType !== undefined) {
    params.set('reviewType', filter.reviewType);
  }

  return params;
}
