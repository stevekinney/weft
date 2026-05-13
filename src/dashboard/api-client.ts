/**
 * Typed fetch wrapper for the Weft REST API.
 *
 * Browser-only shapes are declared inline here, while shared contract
 * types are re-exported from core as type-only imports.
 *
 * @module dashboard/api-client
 */

import { buildScheduleListSearchParams } from '../client/schedule-list-search-params.ts';
import type {
  ScheduleFilter,
  ScheduleSummary,
  TenantQuotaUsage,
  WorkflowReplay,
  WorkflowTimelineEntry,
} from '../core/types.ts';

export type WorkflowStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed-out';

export interface WorkflowState {
  id: string;
  type: string;
  status: WorkflowStatus;
  tags?: string[];
  input: unknown;
  result?: unknown;
  error?: string;
  version: string;
  createdAt: number;
  updatedAt: number;
  executionDeadline?: number;
}

export interface WorkflowSummary {
  id: string;
  type: string;
  status: WorkflowStatus;
  tags?: string[];
  version: string;
  createdAt: number;
  updatedAt: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface RetentionPolicy {
  completed?: number;
  failed?: number;
  cancelled?: number;
  timedOut?: number;
}

export interface WorkflowTypeRetentionPolicy {
  type: string;
  source: 'engine' | 'workflow' | 'none';
  retention: RetentionPolicy | null;
}

export interface RetentionOverview {
  defaultRetention: RetentionPolicy | null;
  sweepIntervalMs: number;
  sweepBatchSize: number;
  nextSweepAt: number | null;
  workflowTypes: WorkflowTypeRetentionPolicy[];
}

export interface ListFilter {
  status?: WorkflowStatus;
  type?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
}

/** Routing strategy the server selects when assigning tasks to workers. */
export type WorkerRoutingPolicy = 'least-loaded' | 'round-robin' | 'fair-share';

/** Health state used by routing and drain controls for connected workers. */
export type WorkerHealth = 'active' | 'draining' | 'drained';

/** JSON-serializable capability metadata a remote worker reports at registration. */
export type WorkerCapabilities = Record<string, unknown>;

/** Scheduling strategy a task queue applies when ordering pending tasks. */
export type TaskQueueSchedulingPolicy = 'priority' | 'fifo' | 'lifo';

/** A single connected worker as reported by `GET /v1/workers`. */
export type WorkerSummary = {
  id: string;
  queue: string;
  activities: string[];
  concurrency: number;
  inFlight: number;
  availableCapacity: number;
  connectedAt: number;
  lastHeartbeatAt: number;
  heartbeatAgeMs: number;
  startedAt: number;
  capabilities: WorkerCapabilities;
  health: WorkerHealth;
  deploymentName?: string;
  buildId?: string;
  runtimeVersion?: string;
  gitSha?: string;
};

/** Per-deployment aggregate reported by `GET /v1/workers`. */
export type WorkerDeploymentSummary = {
  deploymentName: string | null;
  buildId: string | null;
  runtimeVersion: string | null;
  gitSha: string | null;
  health: WorkerHealth;
  workers: number;
  activeWorkers: number;
  drainingWorkers: number;
  drainedWorkers: number;
  inFlight: number;
  oldestStartedAt: number | null;
};

/** Response from worker/deployment drain mutation endpoints. */
export type WorkerDrainMutationResponse =
  | {
      target: 'worker';
      workerId: string;
      affectedWorkers: number;
      inFlight: number;
      health: WorkerHealth;
    }
  | {
      target: 'deployment';
      deploymentName: string;
      affectedWorkers: number;
      inFlight: number;
      health: WorkerHealth;
    };

/** Top-level response shape for `GET /v1/workers`. */
export type ListWorkersResponse = {
  items: WorkerSummary[];
  deployments: WorkerDeploymentSummary[];
  routingPolicy: WorkerRoutingPolicy;
};

/** Per-queue health as reported by `GET /v1/task-queues`. */
export type TaskQueueHealth = {
  queue: string;
  backlog: number;
  oldestEnqueuedAt: number | null;
  oldestQueuedAgeMs: number | null;
  waitingPollers: number;
  schedulingPolicy: TaskQueueSchedulingPolicy;
  inFlight: number;
  connectedWorkers: number;
};

/** Top-level response shape for `GET /v1/task-queues`. */
export type ListTaskQueuesResponse = {
  items: TaskQueueHealth[];
};

export type {
  ScheduleFilter,
  ScheduleSummary,
  TenantQuotaMetricUsage,
  TenantQuotaUsage,
  TenantWorkflowCreationRateUsage,
  WorkflowReplay,
  WorkflowTimelineEntry,
} from '../core/types.ts';

export interface WorkflowEvent {
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface ReviewRequest {
  reviewId: string;
  workflowId: string;
  artifact: unknown;
  reviewType: string;
  reviewers: string[];
  createdAt: number;
}

export interface ReviewDecision {
  decision: 'approved' | 'rejected' | 'needs-changes';
  reviewer: string;
  feedback?: string;
}

export type TaskDiagnosticKind =
  | 'stuck-queued'
  | 'stale-inflight'
  | 'retry-storm'
  | 'all-workers-at-capacity';

export interface TaskDiagnosticItem {
  kind: TaskDiagnosticKind;
  state: 'queued' | 'inflight' | 'resolved' | 'capacity';
  operationId?: string;
  workflowId?: string;
  activityName?: string;
  queue?: string;
  workerId?: string;
  retryCount: number;
  requeueCount: number;
  queueLatencyMs?: number;
  executionLatencyMs?: number;
  heartbeatAgeMs?: number;
  lastRequeueReason?: 'visibility-timeout' | 'worker-disconnect';
  resolutionReason?: string;
  evidence: string[];
}

export interface TaskDiagnosticsSummary {
  stuckQueued: number;
  staleInflight: number;
  retryStorms: number;
  allWorkersAtCapacity: number;
}

export interface TaskDiagnosticsResponse {
  items: TaskDiagnosticItem[];
  summary: TaskDiagnosticsSummary;
  limit: number;
}

export interface TaskDiagnosticsFilter {
  operationId?: string;
  workflowId?: string;
  queue?: string;
  staleQueuedAfterMs?: number;
  staleHeartbeatAfterMs?: number;
  retryStormMinimumAttempts?: number;
  limit?: number;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
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
  // oxlint-disable-next-line complexity -- ID:dashboard-api-client-list-workflows-complexity
  async listWorkflows(filter?: ListFilter): Promise<PaginatedResult<WorkflowSummary>> {
    const params = new URLSearchParams();

    if (filter?.status !== undefined) params.set('status', filter.status);
    if (filter?.type !== undefined) params.set('type', filter.type);
    if (filter?.tags !== undefined) {
      for (const tag of filter.tags) {
        params.append('tag', tag);
      }
    }
    if (filter?.limit !== undefined) params.set('limit', String(filter.limit));
    if (filter?.offset !== undefined) params.set('offset', String(filter.offset));

    const query = params.toString();
    const path = query ? `/workflows?${query}` : '/workflows';

    return request<PaginatedResult<WorkflowSummary>>(path);
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

  /** Get current quota usage versus configured limits for a tenant. */
  async getTenantQuotaUsage(tenantId: string): Promise<TenantQuotaUsage> {
    return request<TenantQuotaUsage>(`/tenants/${encodeURIComponent(tenantId)}/quota`);
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
