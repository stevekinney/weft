import type { ScheduleFilter } from '../core/types.ts';

function appendScheduleStatusFilters(
  params: URLSearchParams,
  status: ScheduleFilter['status'],
): void {
  if (status === undefined) {
    return;
  }

  const statuses = (Array.isArray(status) ? status : [status]).filter(Boolean);
  for (const value of statuses) {
    params.append('status', value);
  }
}

/** Build query parameters for schedule list requests shared by all HTTP clients. */
export function buildScheduleListSearchParams(filter?: ScheduleFilter): URLSearchParams {
  const params = new URLSearchParams();

  appendScheduleStatusFilters(params, filter?.status);
  if (filter?.workflowType !== undefined) {
    params.set('workflowType', filter.workflowType);
  }
  if (filter?.limit !== undefined) {
    params.set('limit', String(filter.limit));
  }
  if (filter?.offset !== undefined) {
    params.set('offset', String(filter.offset));
  }

  return params;
}
