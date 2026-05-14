import type { ListFilter as CoreListFilter } from '../core/types.ts';

export type WorkflowStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed-out';

export type FailureCategory = 'application' | 'timeout' | 'cancellation' | 'resource' | 'system';

export interface TimeRange {
  gte?: number;
  gt?: number;
  lte?: number;
  lt?: number;
}

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
  tenantId?: string;
  executionDeadline?: number;
  failureCategory?: FailureCategory;
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
  status?: WorkflowStatus | WorkflowStatus[];
  type?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
  idPrefix?: string;
  createdAt?: TimeRange;
  updatedAt?: TimeRange;
  executionDeadline?: TimeRange;
  tenantId?: string | string[];
  failureCategory?: FailureCategory | FailureCategory[];
}

export type BulkWorkflowFilter = CoreListFilter;
export type BulkTagMutationOperation = 'add' | 'remove';

export type AggregateGroupBy =
  | 'status'
  | 'type'
  | 'tenant'
  | 'failureCategory'
  | { attribute: string };

export interface AggregateGroup {
  key: string | null;
  count: number;
}

export interface AggregateResult {
  total: number;
  groups: AggregateGroup[];
  truncated: boolean;
}

export type AggregateFilter = Omit<ListFilter, 'limit' | 'offset'>;

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
  BulkCancelResult,
  BulkDeleteResult,
  BulkOperationAuditEvent,
  BulkOperationDryRunResult,
  BulkOperationScopeSummary,
  BulkSignalResult,
  BulkTagResult,
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
