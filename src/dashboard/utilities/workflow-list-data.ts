import type {
  AggregateFilter,
  AggregateGroupBy,
  AggregateResult,
  ApiClient,
  FailureCategory,
  ListFilter,
  RetentionOverview,
  ScheduleSummary,
  TimeRange,
  WorkflowStatus,
  WorkflowSummary,
} from '../api-client.ts';

export interface WorkflowListFilters {
  status: WorkflowStatus | 'all';
  type: string;
  tags: string[];
  offset: number;
  idPrefix?: string;
  createdAt?: TimeRange;
  updatedAt?: TimeRange;
  executionDeadline?: TimeRange;
  failureCategory?: FailureCategory[];
}

export interface WorkflowListData {
  workflows: WorkflowSummary[];
  schedules: ScheduleSummary[];
  total: number;
  retentionOverview: RetentionOverview | null;
}

/**
 * Build the `ListFilter` shape sent to `apiClient.listWorkflows`.
 * Only round-trips fields that are actually set, mirroring the legacy
 * behavior so empty / whitespace inputs don't surface to the server.
 */
export function buildWorkflowListFilter(
  filters: WorkflowListFilters,
  pageSize: number,
): ListFilter {
  const listFilter: ListFilter = {
    limit: pageSize,
    offset: filters.offset,
  };

  if (filters.status !== 'all') listFilter.status = filters.status;
  if (filters.type.length > 0) listFilter.type = filters.type;
  if (filters.tags.length > 0) listFilter.tags = filters.tags;
  assignTimeRange(listFilter, 'createdAt', filters.createdAt);
  assignTimeRange(listFilter, 'updatedAt', filters.updatedAt);
  assignTimeRange(listFilter, 'executionDeadline', filters.executionDeadline);

  const idPrefix = filters.idPrefix;
  if (idPrefix !== undefined && idPrefix.length > 0) listFilter.idPrefix = idPrefix;

  const failureCategory = singleOrArray(filters.failureCategory);
  if (failureCategory !== undefined) listFilter.failureCategory = failureCategory;

  return listFilter;
}

function assignTimeRange(
  target: ListFilter,
  key: 'createdAt' | 'updatedAt' | 'executionDeadline',
  value: TimeRange | undefined,
): void {
  if (value !== undefined && hasTimeRangeBound(value)) target[key] = value;
}

function singleOrArray<T>(values: T[] | undefined): T | T[] | undefined {
  if (values === undefined || values.length === 0) return undefined;
  return values.length === 1 ? values[0]! : values;
}

function hasTimeRangeBound(range: TimeRange): boolean {
  return (
    range.gte !== undefined ||
    range.gt !== undefined ||
    range.lte !== undefined ||
    range.lt !== undefined
  );
}

export async function loadWorkflowListData(
  apiClient: Pick<ApiClient, 'listWorkflows' | 'listSchedules' | 'getRetentionOverview'>,
  filters: WorkflowListFilters,
  pageSize: number,
): Promise<WorkflowListData> {
  const listFilter = buildWorkflowListFilter(filters, pageSize);

  const workflowListPromise = apiClient.listWorkflows(listFilter);
  const schedulesPromise = apiClient.listSchedules({ limit: pageSize }).catch(() => ({
    items: [],
    total: 0,
    offset: 0,
    limit: pageSize,
  }));
  const retentionOverviewPromise = apiClient.getRetentionOverview().catch(() => null);

  const workflowList = await workflowListPromise;
  const schedules = await schedulesPromise;
  const retentionOverview = await retentionOverviewPromise;

  return {
    workflows: workflowList.items,
    schedules: schedules.items,
    total: workflowList.total,
    retentionOverview,
  };
}

/**
 * Call the aggregate endpoint with the same filter shape used by the
 * list view (sans pagination). The dashboard uses this to populate the
 * status-counts panel.
 */
export async function loadWorkflowAggregate(
  apiClient: Pick<ApiClient, 'aggregateWorkflows'>,
  filters: WorkflowListFilters,
  groupBy: AggregateGroupBy,
  limit?: number,
): Promise<AggregateResult> {
  // Aggregate intentionally omits limit + offset — the filter is the
  // population, the limit caps the returned groups.
  const { limit: _drop1, offset: _drop2, ...aggregateFilter } = buildWorkflowListFilter(filters, 0);
  void _drop1;
  void _drop2;
  return apiClient.aggregateWorkflows(aggregateFilter as AggregateFilter, groupBy, limit);
}
