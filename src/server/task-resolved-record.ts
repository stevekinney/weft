import type { InflightRecord, ResolvedRecord, TaskResolutionReason } from './task-state.ts';

export function buildResolvedRecord(parameters: {
  operationId: string;
  status: 'completed' | 'failed';
  resolvedAt: number;
  normalizedRecord: InflightRecord | null;
  resolutionReason: TaskResolutionReason;
  value?: unknown;
  error?: string | undefined;
  queueLatencyMs?: number | undefined;
  executionLatencyMs?: number | undefined;
}): ResolvedRecord {
  const resolvedRecord: ResolvedRecord = {
    operationId: parameters.operationId,
    status: parameters.status,
    resolvedAt: parameters.resolvedAt,
  };
  if (parameters.value !== undefined) {
    resolvedRecord.value = parameters.value;
  }
  if (parameters.error !== undefined) {
    resolvedRecord.error = parameters.error;
  }

  const { normalizedRecord } = parameters;
  if (normalizedRecord === null) {
    return resolvedRecord;
  }

  return {
    ...resolvedRecord,
    activityName: normalizedRecord.activityName,
    queue: normalizedRecord.queue,
    workerId: normalizedRecord.workerId,
    attempt: normalizedRecord.attempt,
    visibilityTimeout: normalizedRecord.visibilityTimeout,
    ...(normalizedRecord.workflowId === undefined
      ? {}
      : { workflowId: normalizedRecord.workflowId }),
    firstQueuedAt: normalizedRecord.firstQueuedAt,
    lastQueuedAt: normalizedRecord.lastQueuedAt,
    lastDispatchedAt: normalizedRecord.lastDispatchedAt,
    startedAt: normalizedRecord.startedAt,
    completedAt: parameters.resolvedAt,
    lastHeartbeatAt: normalizedRecord.lastHeartbeatAt,
    retryCount: normalizedRecord.retryCount,
    requeueCount: normalizedRecord.requeueCount,
    lastRequeueReason: normalizedRecord.lastRequeueReason,
    resolutionReason: parameters.resolutionReason,
    queueLatencyMs: parameters.queueLatencyMs,
    executionLatencyMs: parameters.executionLatencyMs,
  };
}
