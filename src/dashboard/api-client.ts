/**
 * Typed fetch wrapper for the Weft REST API.
 *
 * Browser-only shapes are re-exported from `api-client-types.ts`, while shared
 * contract types flow through core as type-only imports.
 *
 * @module dashboard/api-client
 */

import { buildScheduleListSearchParams } from '../client/schedule-list-search-params.ts';
import { WeftError } from '../core/weft-error.ts';
import type {
  AggregateFilter,
  AggregateGroupBy,
  AggregateResult,
  BulkCancelResult,
  BulkDeleteResult,
  BulkOperationDryRunResult,
  BulkSignalResult,
  BulkTagMutationOperation,
  BulkTagResult,
  BulkWorkflowFilter,
  ListFilter,
  ListTaskQueuesResponse,
  ListWorkersResponse,
  PaginatedResult,
  RetentionOverview,
  ReviewDecision,
  ReviewRequest,
  ScheduleFilter,
  ScheduleSummary,
  TaskDiagnosticsFilter,
  TaskDiagnosticsResponse,
  WorkerDrainMutationResponse,
  WorkflowEvent,
  WorkflowReplay,
  WorkflowState,
  WorkflowSummary,
  WorkflowTimelineEntry,
} from './api-client-types.ts';
import { buildWorkflowFilterSearchParams } from './workflow-filter-search-params.ts';
export type {
  AggregateFilter,
  AggregateGroup,
  AggregateGroupBy,
  AggregateResult,
  BulkCancelResult,
  BulkDeleteResult,
  BulkOperationAuditEvent,
  BulkOperationDryRunResult,
  BulkOperationScopeSummary,
  BulkSignalResult,
  BulkTagMutationOperation,
  BulkTagResult,
  BulkWorkflowFilter,
  FailureCategory,
  ListFilter,
  ListTaskQueuesResponse,
  ListWorkersResponse,
  PaginatedResult,
  RetentionOverview,
  RetentionPolicy,
  ReviewDecision,
  ReviewRequest,
  ScheduleFilter,
  ScheduleSummary,
  TaskDiagnosticItem,
  TaskDiagnosticKind,
  TaskDiagnosticsFilter,
  TaskDiagnosticsResponse,
  TaskDiagnosticsSummary,
  TaskQueueHealth,
  TaskQueueSchedulingPolicy,
  TimeRange,
  WorkerCapabilities,
  WorkerDeploymentSummary,
  WorkerDrainMutationResponse,
  WorkerHealth,
  WorkerRoutingPolicy,
  WorkerSummary,
  WorkflowEvent,
  WorkflowReplay,
  WorkflowState,
  WorkflowStatus,
  WorkflowSummary,
  WorkflowTimelineEntry,
  WorkflowTypeRetentionPolicy,
} from './api-client-types.ts';

export class ApiError extends WeftError<'ApiError'> {
  readonly status: number;

  constructor(status: number, message: string) {
    super('ApiError', message);
    this.status = status;
  }
}

const BASE_PATH = '/v1';

function setOptionalSearchParam(
  params: URLSearchParams,
  key: string,
  value: string | number | undefined,
): void {
  if (value !== undefined) params.set(key, String(value));
}

function buildTaskDiagnosticsSearchParams(filter?: TaskDiagnosticsFilter): URLSearchParams {
  const params = new URLSearchParams();
  setOptionalSearchParam(params, 'operationId', filter?.operationId);
  setOptionalSearchParam(params, 'workflowId', filter?.workflowId);
  setOptionalSearchParam(params, 'queue', filter?.queue);
  setOptionalSearchParam(params, 'staleQueuedAfterMs', filter?.staleQueuedAfterMs);
  setOptionalSearchParam(params, 'staleHeartbeatAfterMs', filter?.staleHeartbeatAfterMs);
  setOptionalSearchParam(params, 'retryStormMinimumAttempts', filter?.retryStormMinimumAttempts);
  setOptionalSearchParam(params, 'limit', filter?.limit);
  return params;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);

  if (options?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${BASE_PATH}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // Use statusText if body parsing fails
    }
    throw new ApiError(response.status, message);
  }

  // 204 No Content returns no body
  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export class ApiClient {
  /** List workflows with optional filtering. */
  async listWorkflows(filter?: ListFilter): Promise<PaginatedResult<WorkflowSummary>> {
    const params = buildWorkflowFilterSearchParams(filter);
    if (filter?.limit !== undefined) params.set('limit', String(filter.limit));
    if (filter?.offset !== undefined) params.set('offset', String(filter.offset));

    const query = params.toString();
    const path = query ? `/workflows?${query}` : '/workflows';

    return request<PaginatedResult<WorkflowSummary>>(path);
  }

  /**
   * Aggregate workflows by a single dimension. The filter shape matches
   * `listWorkflows` except `limit` and `offset` are not used; `limit`
   * caps the number of groups returned.
   */
  async aggregateWorkflows(
    filter: AggregateFilter | undefined,
    groupBy: AggregateGroupBy,
    limit?: number,
  ): Promise<AggregateResult> {
    const params = buildWorkflowFilterSearchParams(filter);
    if (typeof groupBy === 'string') {
      params.set('group_by', groupBy);
    } else {
      params.set('group_by', `attribute:${groupBy.attribute}`);
    }
    if (limit !== undefined) params.set('limit', String(limit));

    const query = params.toString();
    const path = query ? `/workflows/aggregate?${query}` : '/workflows/aggregate';
    return request<AggregateResult>(path);
  }

  /** Get the full state of a single workflow. */
  async getWorkflow(id: string): Promise<WorkflowState> {
    return request<WorkflowState>(`/workflows/${encodeURIComponent(id)}`);
  }

  /** Cancel a running workflow. */
  async cancelWorkflow(id: string): Promise<void> {
    return request<void>(`/workflows/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  /** Send a signal to a workflow. */
  async signalWorkflow(id: string, name: string, payload?: unknown): Promise<void> {
    return request<void>(
      `/workflows/${encodeURIComponent(id)}/signal/${encodeURIComponent(name)}`,
      {
        method: 'POST',
        body: JSON.stringify({ payload }),
      },
    );
  }

  /** Get the event history for a workflow. */
  async getWorkflowEvents(id: string): Promise<WorkflowEvent[]> {
    const response = await request<{ events: WorkflowEvent[] }>(
      `/workflows/${encodeURIComponent(id)}/events`,
    );
    return response.events;
  }

  /** Get the structured execution timeline for a workflow. */
  async getWorkflowTimeline(id: string): Promise<WorkflowTimelineEntry[]> {
    const response = await request<WorkflowTimelineEntry[] | null>(
      `/workflows/${encodeURIComponent(id)}/timeline`,
    );
    return response ?? [];
  }

  /** Get bounded task diagnostics for workflow detail and operator views. */
  async getTaskDiagnostics(filter?: TaskDiagnosticsFilter): Promise<TaskDiagnosticsResponse> {
    const query = buildTaskDiagnosticsSearchParams(filter).toString();
    const path = query ? `/tasks/diagnostics?${query}` : '/tasks/diagnostics';

    return request<TaskDiagnosticsResponse>(path);
  }

  /** Reconstruct workflow state at a historical checkpoint step. */
  async replayWorkflowTo(id: string, step: number): Promise<WorkflowReplay | null> {
    try {
      return await request<WorkflowReplay>(`/workflows/${encodeURIComponent(id)}/replay/${step}`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /** Get search attributes for a workflow. */
  async getWorkflowAttributes(id: string): Promise<Record<string, unknown>> {
    return request<Record<string, unknown>>(`/workflows/${encodeURIComponent(id)}/attributes`);
  }

  /** List all pending human review requests. */
  async listPendingReviews(): Promise<ReviewRequest[]> {
    const response = await request<{ items: ReviewRequest[] }>('/reviews');
    return response.items;
  }

  /** List recurring schedules with optional filtering. */
  async listSchedules(filter?: ScheduleFilter): Promise<PaginatedResult<ScheduleSummary>> {
    const params = buildScheduleListSearchParams(filter);
    const query = params.toString();
    const path = query ? `/schedules?${query}` : '/schedules';

    return request<PaginatedResult<ScheduleSummary>>(path);
  }

  /** Submit a decision for a pending review. */
  async submitReviewDecision(
    reviewId: string,
    workflowId: string,
    decision: ReviewDecision,
  ): Promise<void> {
    return request<void>(`/reviews/${encodeURIComponent(reviewId)}/decision`, {
      method: 'POST',
      body: JSON.stringify({ ...decision, workflowId }),
    });
  }

  /** Health check. */
  async checkHealth(): Promise<{ status: string }> {
    return request<{ status: string }>('/health');
  }
  /** Get retention policies and next sweep timing for the dashboard. */
  async getRetentionOverview(): Promise<RetentionOverview> {
    return request<RetentionOverview>('/retention');
  }
  /** Preview matching workflows before bulk cancellation. */
  async previewBulkCancelWorkflows(
    filter: BulkWorkflowFilter,
    requestId?: string,
  ): Promise<BulkOperationDryRunResult> {
    return request<BulkOperationDryRunResult>('/workflows/bulk/cancel', {
      method: 'POST',
      body: JSON.stringify({
        filter,
        dryRun: true,
        ...(requestId === undefined ? {} : { requestId }),
      }),
    });
  }

  /** Commit bulk cancellation with a confirmation token from a preview. */
  async commitBulkCancelWorkflows(
    filter: BulkWorkflowFilter,
    confirmationToken: string,
    requestId?: string,
  ): Promise<BulkCancelResult> {
    return request<BulkCancelResult>('/workflows/bulk/cancel', {
      method: 'POST',
      body: JSON.stringify({
        filter,
        confirmationToken,
        ...(requestId === undefined ? {} : { requestId }),
      }),
    });
  }

  /** Preview matching terminal workflows before bulk deletion. */
  async previewBulkDeleteWorkflows(
    filter: BulkWorkflowFilter,
    requestId?: string,
  ): Promise<BulkOperationDryRunResult> {
    return request<BulkOperationDryRunResult>('/workflows/bulk', {
      method: 'DELETE',
      body: JSON.stringify({
        filter,
        dryRun: true,
        ...(requestId === undefined ? {} : { requestId }),
      }),
    });
  }

  /** Commit bulk deletion with a confirmation token from a preview. */
  async commitBulkDeleteWorkflows(
    filter: BulkWorkflowFilter,
    confirmationToken: string,
    requestId?: string,
  ): Promise<BulkDeleteResult> {
    return request<BulkDeleteResult>('/workflows/bulk', {
      method: 'DELETE',
      body: JSON.stringify({
        filter,
        confirmationToken,
        ...(requestId === undefined ? {} : { requestId }),
      }),
    });
  }

  /** Preview matching workflows before sending a signal in bulk. */
  async previewBulkSignalWorkflows(
    filter: BulkWorkflowFilter,
    name: string,
    payload?: unknown,
    requestId?: string,
  ): Promise<BulkOperationDryRunResult> {
    return request<BulkOperationDryRunResult>('/workflows/bulk/signal', {
      method: 'POST',
      body: JSON.stringify({
        filter,
        name,
        ...(payload === undefined ? {} : { payload }),
        dryRun: true,
        ...(requestId === undefined ? {} : { requestId }),
      }),
    });
  }

  /** Commit a bulk signal with a confirmation token from a preview. */
  async commitBulkSignalWorkflows(
    filter: BulkWorkflowFilter,
    name: string,
    payload: unknown = undefined,
    confirmationToken: string,
    requestId?: string,
  ): Promise<BulkSignalResult> {
    return request<BulkSignalResult>('/workflows/bulk/signal', {
      method: 'POST',
      body: JSON.stringify({
        filter,
        name,
        ...(payload === undefined ? {} : { payload }),
        confirmationToken,
        ...(requestId === undefined ? {} : { requestId }),
      }),
    });
  }

  /** Preview matching workflows before adding or removing tags in bulk. */
  async previewBulkTagWorkflows(
    filter: BulkWorkflowFilter,
    tags: string[],
    operation: BulkTagMutationOperation,
    requestId?: string,
  ): Promise<BulkOperationDryRunResult> {
    return request<BulkOperationDryRunResult>('/workflows/bulk/tags', {
      method: 'PATCH',
      body: JSON.stringify({
        filter,
        tags,
        operation,
        dryRun: true,
        ...(requestId === undefined ? {} : { requestId }),
      }),
    });
  }

  /** Commit a bulk tag mutation with a confirmation token from a preview. */
  async commitBulkTagWorkflows(
    filter: BulkWorkflowFilter,
    tags: string[],
    operation: BulkTagMutationOperation,
    confirmationToken: string,
    requestId?: string,
  ): Promise<BulkTagResult> {
    return request<BulkTagResult>('/workflows/bulk/tags', {
      method: 'PATCH',
      body: JSON.stringify({
        filter,
        tags,
        operation,
        confirmationToken,
        ...(requestId === undefined ? {} : { requestId }),
      }),
    });
  }

  /** List connected workers with capacity, heartbeat, and routing policy. */
  async listWorkers(): Promise<ListWorkersResponse> {
    return request<ListWorkersResponse>('/workers');
  }

  /** Mark one connected worker as draining. */
  async drainWorker(workerId: string, reason?: string): Promise<WorkerDrainMutationResponse> {
    return request<WorkerDrainMutationResponse>(`/workers/${encodeURIComponent(workerId)}/drain`, {
      method: 'POST',
      body: JSON.stringify(reason === undefined ? {} : { reason }),
    });
  }

  /** Clear one worker's explicit drain marker. */
  async clearWorkerDrain(workerId: string): Promise<WorkerDrainMutationResponse> {
    return request<WorkerDrainMutationResponse>(`/workers/${encodeURIComponent(workerId)}/drain`, {
      method: 'DELETE',
    });
  }

  /** Mark every current and future worker for a deployment as draining. */
  async drainDeployment(
    deploymentName: string,
    reason?: string,
  ): Promise<WorkerDrainMutationResponse> {
    return request<WorkerDrainMutationResponse>(
      `/worker-deployments/${encodeURIComponent(deploymentName)}/drain`,
      {
        method: 'POST',
        body: JSON.stringify(reason === undefined ? {} : { reason }),
      },
    );
  }

  /** Clear the deployment-level drain marker. */
  async clearDeploymentDrain(deploymentName: string): Promise<WorkerDrainMutationResponse> {
    return request<WorkerDrainMutationResponse>(
      `/worker-deployments/${encodeURIComponent(deploymentName)}/drain`,
      { method: 'DELETE' },
    );
  }

  /** List per-queue health: backlog, oldest age, waiting pollers, in-flight. */
  async listTaskQueues(): Promise<ListTaskQueuesResponse> {
    return request<ListTaskQueuesResponse>('/task-queues');
  }
}
