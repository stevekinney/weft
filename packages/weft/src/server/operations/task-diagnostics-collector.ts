import {
  decodeRemoteTaskRecord,
  type RemoteTaskRecord,
} from '../../core/task-ledger/task-ledger.ts';
import type { Storage } from '../../storage/interface.ts';
import type { WorkerRegistry } from '../../worker/registry.ts';
import type { TaskQueue } from '../task-queue.ts';
import {
  calculateExecutionLatencyMs,
  calculateHeartbeatAgeMs,
  calculateQueueLatencyMs,
} from '../task-state.ts';
import type {
  GetTaskDiagnosticsInput,
  GetTaskDiagnosticsOutput,
  TaskDiagnosticItem,
  TaskDiagnosticKind,
  TaskDiagnosticsSummary,
} from './get-task-diagnostics.ts';
import { addCapacityDiagnostics } from './task-diagnostics-capacity.ts';

export async function collectTaskDiagnostics({
  engine,
  input,
  currentTime,
  registry,
  taskQueue,
}: {
  engine: { storage: Pick<Storage, 'scan'> };
  input: GetTaskDiagnosticsInput;
  currentTime: number;
  registry?: WorkerRegistry | undefined;
  taskQueue?: TaskQueue | undefined;
}): Promise<GetTaskDiagnosticsOutput> {
  const items: TaskDiagnosticItem[] = [];
  const summary: TaskDiagnosticsSummary = {
    stuckQueued: 0,
    staleInflight: 0,
    retryStorms: 0,
    allWorkersAtCapacity: 0,
    deadLettered: 0,
    delayed: 0,
    unadoptedTerminal: 0,
  };
  const relevantQueues = new Set<string>();

  const addItem = (item: TaskDiagnosticItem): void => {
    incrementSummary(summary, item.kind);
    if (items.length < input.limit) {
      items.push(item);
    }
  };

  for await (const [, value] of engine.storage.scan('task-ledger:')) {
    const decoded = decodeRemoteTaskRecord(value);
    if (decoded === null) continue;
    if (!matchesTaskRecordFilter(decoded, input)) continue;
    relevantQueues.add(decoded.queue);
    addRecordDiagnostics(decoded, input, currentTime, addItem);
  }

  addCapacityDiagnostics({
    registry,
    taskQueue,
    input,
    queues: relevantQueues,
    addItem,
  });

  return { items, summary, limit: input.limit };
}

function addRecordDiagnostics(
  decoded: RemoteTaskRecord,
  input: GetTaskDiagnosticsInput,
  currentTime: number,
  addItem: (item: TaskDiagnosticItem) => void,
): void {
  switch (decoded.state) {
    case 'queued':
      if (input.includeExpectedDelayed && decoded.availableAt > currentTime) {
        addDelayedDiagnostic(decoded, addItem);
      }
      if (decoded.availableAt <= currentTime) {
        addQueuedDiagnostics(decoded, input, currentTime, addItem);
      }
      addRetryStormDiagnostic(decoded, 'queued', input, addItem);
      return;
    case 'leased':
    case 'completing':
    case 'cancelling':
      addInflightDiagnostics(decoded, input, currentTime, addItem);
      addRetryStormDiagnostic(decoded, 'inflight', input, addItem);
      return;
    case 'terminal':
      // No RemoteTaskAttemptFields (retryCount/requeueCount) on terminal
      // records — WFT-25 deliberately did not carry attempt-count history
      // past resolution, so retry-storm detection cannot apply here.
      addUnadoptedTerminalDiagnostic(decoded, input, currentTime, addItem);
      return;
    case 'deadLettered':
      addDeadLetterDiagnostics(decoded, addItem);
      return;
    default: {
      // Exhaustiveness guard: adding a new RemoteTaskRecord state without a
      // case above must fail this typecheck.
      const exhaustive: never = decoded;
      void exhaustive;
    }
  }
}

function addDelayedDiagnostic(
  record: RemoteTaskRecord & { state: 'queued' },
  addItem: (item: TaskDiagnosticItem) => void,
): void {
  addItem({
    kind: 'delayed',
    state: 'queued',
    operationId: record.operationId,
    workflowId: record.workflowId,
    queue: record.queue,
    retryCount: record.retryCount,
    requeueCount: record.requeueCount,
    availableAt: record.availableAt,
    evidence: [`Task is delayed until ${record.availableAt} on queue "${record.queue}"`],
  });
}

function addUnadoptedTerminalDiagnostic(
  record: RemoteTaskRecord & { state: 'terminal' },
  input: GetTaskDiagnosticsInput,
  currentTime: number,
  addItem: (item: TaskDiagnosticItem) => void,
): void {
  if (record.adopted || record.terminalAt > currentTime - input.unadoptedAfterMs) return;
  addItem({
    kind: 'unadopted-terminal',
    state: 'resolved',
    operationId: record.operationId,
    workflowId: record.workflowId,
    queue: record.queue,
    terminalAt: record.terminalAt,
    adopted: false,
    evidence: [`Terminal task has remained unadopted for ${currentTime - record.terminalAt}ms`],
  });
}

function addQueuedDiagnostics(
  record: RemoteTaskRecord & { state: 'queued' },
  input: GetTaskDiagnosticsInput,
  currentTime: number,
  addItem: (item: TaskDiagnosticItem) => void,
): void {
  const queueLatencyMs = Math.max(0, currentTime - record.lastQueuedAt);
  if (queueLatencyMs < input.staleQueuedAfterMs) return;
  addItem({
    kind: 'stuck-queued',
    state: 'queued',
    operationId: record.operationId,
    workflowId: record.workflowId,
    activityName: record.activityName,
    queue: record.queue,
    retryCount: record.retryCount,
    requeueCount: record.requeueCount,
    queueLatencyMs,
    lastRequeueReason: record.lastRequeueReason,
    evidence: [
      `Task has waited ${queueLatencyMs}ms in queue "${record.queue}" without a worker claim`,
    ],
  });
}

function addInflightDiagnostics(
  record: RemoteTaskRecord & { state: 'leased' | 'completing' | 'cancelling' },
  input: GetTaskDiagnosticsInput,
  currentTime: number,
  addItem: (item: TaskDiagnosticItem) => void,
): void {
  const heartbeatAgeMs = calculateHeartbeatAgeMs(record, currentTime) ?? 0;
  if (heartbeatAgeMs < input.staleHeartbeatAfterMs) return;
  addItem({
    kind: 'stale-inflight',
    state: 'inflight',
    operationId: record.operationId,
    workflowId: record.workflowId,
    activityName: record.activityName,
    queue: record.queue,
    workerId: record.workerSessionId,
    retryCount: record.retryCount,
    requeueCount: record.requeueCount,
    queueLatencyMs: calculateQueueLatencyMs(record),
    executionLatencyMs: calculateExecutionLatencyMs(record, currentTime),
    heartbeatAgeMs,
    lastRequeueReason: record.lastRequeueReason,
    evidence: [
      `Worker "${record.workerSessionId}" has not sent a heartbeat for ${heartbeatAgeMs}ms on queue "${record.queue}"`,
    ],
  });
}

function addDeadLetterDiagnostics(
  record: RemoteTaskRecord & { state: 'deadLettered' },
  addItem: (item: TaskDiagnosticItem) => void,
): void {
  addItem({
    kind: 'dead-lettered',
    state: 'dead-lettered',
    operationId: record.operationId,
    workflowId: record.workflowId,
    activityName: record.activityName,
    queue: record.queue,
    retryCount: record.retryCount,
    requeueCount: record.requeueCount,
    lastRequeueReason: record.lastRequeueReason,
    deadLetteredAt: record.deadLetteredAt,
    deadLetterReason: 'result-resolution-storage-exhausted',
    storageError: record.persistenceFailureReason,
    evidence: [
      `Task result could not be durably persisted (${record.persistenceFailureReason}); reconciliation will not re-dispatch operation "${record.operationId}" until the dead-letter entry is cleared`,
    ],
  });
}

/**
 * Retry-storm detection only applies to `queued`, `leased`, `completing`,
 * and `cancelling` records — the only states carrying `RemoteTaskAttemptFields`
 * (`retryCount`/`requeueCount`). `terminal` records do not: WFT-25
 * deliberately did not carry attempt-count history past resolution.
 */
function addRetryStormDiagnostic(
  record: RemoteTaskRecord & { state: 'queued' | 'leased' | 'completing' | 'cancelling' },
  state: 'queued' | 'inflight',
  input: GetTaskDiagnosticsInput,
  addItem: (item: TaskDiagnosticItem) => void,
): void {
  const { retryCount, requeueCount } = record;
  if (
    retryCount < input.retryStormMinimumAttempts &&
    requeueCount < input.retryStormMinimumAttempts
  ) {
    return;
  }

  addItem({
    kind: 'retry-storm',
    state,
    operationId: record.operationId,
    workflowId: record.workflowId,
    activityName: record.activityName,
    queue: record.queue,
    workerId: 'workerSessionId' in record ? record.workerSessionId : undefined,
    retryCount,
    requeueCount,
    queueLatencyMs: calculateQueueLatencyMs(record),
    lastRequeueReason: record.lastRequeueReason,
    evidence: [
      `Task has ${retryCount} retries and ${requeueCount} requeues, meeting retry storm threshold ${input.retryStormMinimumAttempts}`,
    ],
  });
}

function matchesTaskRecordFilter(
  record: RemoteTaskRecord,
  input: GetTaskDiagnosticsInput,
): boolean {
  if (input.operationId !== undefined && record.operationId !== input.operationId) return false;
  if (input.workflowId !== undefined && record.workflowId !== input.workflowId) return false;
  if (input.queue !== undefined && record.queue !== input.queue) return false;
  return true;
}

function incrementSummary(summary: TaskDiagnosticsSummary, kind: TaskDiagnosticKind): void {
  switch (kind) {
    case 'stuck-queued':
      summary.stuckQueued += 1;
      return;
    case 'stale-inflight':
      summary.staleInflight += 1;
      return;
    case 'retry-storm':
      summary.retryStorms += 1;
      return;
    case 'all-workers-at-capacity':
      summary.allWorkersAtCapacity += 1;
      return;
    case 'dead-lettered':
      summary.deadLettered += 1;
      return;
    case 'delayed':
      summary.delayed += 1;
      return;
    case 'unadopted-terminal':
      summary.unadoptedTerminal += 1;
      return;
  }
}
