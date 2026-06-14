/**
 * `weft.tasks.diagnostics` operation + REST binding.
 *
 * Scans durable task records and live worker state to identify queue pressure,
 * stale in-flight work, retry storms, and worker capacity saturation. Results
 * are intentionally bounded and low-cardinality so operators can use them in a
 * dashboard without turning workflow or worker identifiers into metrics labels.
 *
 * @module server/operations/get-task-diagnostics
 */

import { z } from 'zod';

import { decode } from '../../core/codec.ts';
import type { Engine } from '../../core/engine.ts';
import { KEYS } from '../../storage/interface.ts';
import type { WorkerRegistry } from '../../worker/registry.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import type { TaskQueue } from '../task-queue.ts';
import {
  calculateExecutionLatencyMs,
  calculateHeartbeatAgeMs,
  calculateQueueLatencyMs,
  clearDeadLetteredTaskRecord,
  isDeadLetteredTaskRecord,
  isInflightRecord,
  isQueuedRecord,
  isResolvedRecord,
  type DeadLetteredTaskRecord,
  type InflightRecord,
  type QueuedRecord,
  type ResolvedRecord,
  type TaskState,
} from '../task-state.ts';
import { shapeRestFault } from './operation-helpers.ts';

const DEFAULT_STALE_QUEUED_AFTER_MS = 60_000;
const DEFAULT_STALE_HEARTBEAT_AFTER_MS = 60_000;
const DEFAULT_RETRY_STORM_MINIMUM_ATTEMPTS = 3;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const RESOLVED_HISTORY_SCAN_LIMIT = 1_000;

const taskDiagnosticKindSchema = z.enum([
  'stuck-queued',
  'stale-inflight',
  'retry-storm',
  'all-workers-at-capacity',
  'dead-lettered',
]);

const taskDiagnosticItemSchema = z
  .object({
    kind: taskDiagnosticKindSchema,
    state: z.enum(['queued', 'inflight', 'resolved', 'capacity', 'dead-lettered']),
    operationId: z.string().optional(),
    workflowId: z.string().optional(),
    activityName: z.string().optional(),
    queue: z.string().optional(),
    workerId: z.string().optional(),
    retryCount: z.number().int().nonnegative(),
    requeueCount: z.number().int().nonnegative(),
    queueLatencyMs: z.number().nonnegative().optional(),
    executionLatencyMs: z.number().nonnegative().optional(),
    heartbeatAgeMs: z.number().nonnegative().optional(),
    lastRequeueReason: z.enum(['visibility-timeout', 'worker-disconnect']).optional(),
    resolutionReason: z.string().optional(),
    deadLetteredAt: z.number().nonnegative().optional(),
    deadLetterReason: z.literal('result-resolution-storage-exhausted').optional(),
    storageError: z.string().optional(),
    retryAttempts: z.number().int().nonnegative().optional(),
    evidence: z.array(z.string()),
  })
  .strict();

const taskDiagnosticsSummarySchema = z
  .object({
    stuckQueued: z.number().int().nonnegative(),
    staleInflight: z.number().int().nonnegative(),
    retryStorms: z.number().int().nonnegative(),
    allWorkersAtCapacity: z.number().int().nonnegative(),
    deadLettered: z.number().int().nonnegative(),
  })
  .strict();

const getTaskDiagnosticsOutput = z
  .object({
    items: z.array(taskDiagnosticItemSchema),
    summary: taskDiagnosticsSummarySchema,
    limit: z.number().int().min(1).max(MAX_LIMIT),
  })
  .strict();

const getTaskDiagnosticsInput = z.object({
  operationId: z.string().min(1).optional(),
  workflowId: z.string().min(1).optional(),
  queue: z.string().min(1).optional(),
  staleQueuedAfterMs: z.number().int().nonnegative().default(DEFAULT_STALE_QUEUED_AFTER_MS),
  staleHeartbeatAfterMs: z.number().int().nonnegative().default(DEFAULT_STALE_HEARTBEAT_AFTER_MS),
  retryStormMinimumAttempts: z.number().int().min(1).default(DEFAULT_RETRY_STORM_MINIMUM_ATTEMPTS),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

const clearTaskDeadLetterInput = z.object({
  operationId: z.string().min(1),
});

const okOutput = z.object({ ok: z.literal(true) }).strict();

export type GetTaskDiagnosticsInput = z.infer<typeof getTaskDiagnosticsInput>;

export type TaskDiagnosticKind = z.infer<typeof taskDiagnosticKindSchema>;

export type TaskDiagnosticItem = z.infer<typeof taskDiagnosticItemSchema>;

export type TaskDiagnosticsSummary = z.infer<typeof taskDiagnosticsSummarySchema>;

export type GetTaskDiagnosticsOutput = z.infer<typeof getTaskDiagnosticsOutput>;

export type ClearTaskDeadLetterInput = z.infer<typeof clearTaskDeadLetterInput>;

export type ClearTaskDeadLetterOutput = z.infer<typeof okOutput>;

interface GetTaskDiagnosticsOptions {
  registry?: WorkerRegistry | undefined;
  taskQueue?: TaskQueue | undefined;
  now?: (() => number) | undefined;
}

type TaskRecord = QueuedRecord | InflightRecord | ResolvedRecord;

type FilterableTaskRecord = {
  operationId: string;
  workflowId?: string | undefined;
  queue?: string | undefined;
};

const httpOnlyTaskDiagnosticsTransports = {
  http: true,
  jsonRpcHttp: false,
  jsonRpcWebSocket: false,
  jsonRpcStdio: false,
} as const;

export function createGetTaskDiagnosticsOperation(options: GetTaskDiagnosticsOptions = {}) {
  return defineOperation<GetTaskDiagnosticsInput, GetTaskDiagnosticsOutput>({
    name: 'weft.tasks.diagnostics',
    mcpExposable: false,
    summary: 'Get bounded task latency and stuck-work diagnostics',
    destructive: false,
    tags: ['Observability'],
    inputSchema: getTaskDiagnosticsInput,
    outputSchema: getTaskDiagnosticsOutput,
    access: {
      kind: 'scoped',
      scopes: { kind: 'anyOf', scopes: ['system:read'] },
    },
    producibleFaults: [],
    discoverable: true,
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ input, engine }): Promise<GetTaskDiagnosticsOutput> => {
      const currentTime = options.now?.() ?? Date.now();
      return collectTaskDiagnostics({
        engine: engine as Engine,
        input,
        currentTime,
        registry: options.registry,
        taskQueue: options.taskQueue,
      });
    },
  });
}

export const getTaskDiagnosticsOperation = createGetTaskDiagnosticsOperation();

export const clearTaskDeadLetterOperation = defineOperation<
  ClearTaskDeadLetterInput,
  ClearTaskDeadLetterOutput
>({
  name: 'weft.tasks.diagnostics.deadletters.clear',
  mcpExposable: false,
  summary: 'Clear a task-result dead-letter diagnostic entry',
  destructive: true,
  tags: ['Observability'],
  inputSchema: clearTaskDeadLetterInput,
  outputSchema: okOutput,
  access: {
    kind: 'scoped',
    scopes: { kind: 'anyOf', scopes: ['system:admin'] },
  },
  producibleFaults: [],
  discoverable: true,
  transports: httpOnlyTaskDiagnosticsTransports,
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<ClearTaskDeadLetterOutput> => {
    await clearDeadLetteredTaskRecord((engine as Engine).storage, input.operationId);
    return { ok: true };
  },
});

async function collectTaskDiagnostics({
  engine,
  input,
  currentTime,
  registry,
  taskQueue,
}: {
  engine: Engine;
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
  };
  const relevantQueues = new Set<string>();
  const deadLetteredOperationIds = new Set<string>();

  const addItem = (item: TaskDiagnosticItem): void => {
    incrementSummary(summary, item.kind);
    if (items.length < input.limit) {
      items.push(item);
    }
  };

  for await (const record of scanDeadLetterRecords(engine)) {
    if (!matchesTaskRecordFilter(record, input)) continue;
    deadLetteredOperationIds.add(record.operationId);
    if (record.queue !== undefined) relevantQueues.add(record.queue);
    addDeadLetterDiagnostics(record, addItem);
  }

  for await (const record of scanQueuedRecords(engine)) {
    if (!matchesTaskRecordFilter(record, input)) continue;
    relevantQueues.add(record.queue);
    addQueuedDiagnostics(record, input, currentTime, addItem);
  }

  for await (const record of scanInflightRecords(engine)) {
    if (!matchesTaskRecordFilter(record, input)) continue;
    if (deadLetteredOperationIds.has(record.operationId)) continue;
    relevantQueues.add(record.queue);
    addInflightDiagnostics(record, input, currentTime, addItem);
  }

  for await (const record of scanResolvedRecords(engine, input)) {
    if (!matchesTaskRecordFilter(record, input)) continue;
    if (record.queue !== undefined) relevantQueues.add(record.queue);
    addRetryStormDiagnostic(record, 'resolved', input, addItem);
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

async function* scanDeadLetterRecords(engine: Engine): AsyncIterable<DeadLetteredTaskRecord> {
  for await (const [, value] of engine.storage.scan(KEYS.operationDeadLetterPrefix())) {
    const decoded = decode(value);
    if (isDeadLetteredTaskRecord(decoded)) {
      yield decoded;
    }
  }
}

async function* scanQueuedRecords(engine: Engine): AsyncIterable<QueuedRecord> {
  for await (const [, value] of engine.storage.scan('op:queued:')) {
    const decoded = decode(value);
    if (isQueuedRecord(decoded)) {
      yield decoded;
    }
  }
}

async function* scanInflightRecords(engine: Engine): AsyncIterable<InflightRecord> {
  for await (const [, value] of engine.storage.scan('op:inflight:')) {
    const decoded = decode(value);
    if (isInflightRecord(decoded)) {
      yield decoded;
    }
  }
}

async function* scanResolvedRecords(
  engine: Engine,
  input: GetTaskDiagnosticsInput,
): AsyncIterable<ResolvedRecord> {
  if (input.operationId !== undefined) {
    const value = await engine.storage.get(KEYS.operationResolved(input.operationId));
    if (value === null) return;
    const decoded = decode(value);
    if (isResolvedRecord(decoded)) {
      yield decoded;
    }
    return;
  }

  // Resolved task records are historical and can grow without bound. Scan a
  // fixed recent-history window ordered by resolvedAt rather than operationId.
  for await (const [, value] of engine.storage.scan(KEYS.operationResolvedByTimePrefix(), {
    limit: RESOLVED_HISTORY_SCAN_LIMIT,
    reverse: true,
  })) {
    const decoded = decode(value);
    if (isResolvedRecord(decoded)) {
      yield decoded;
    }
  }
}

function addQueuedDiagnostics(
  record: QueuedRecord,
  input: GetTaskDiagnosticsInput,
  currentTime: number,
  addItem: (item: TaskDiagnosticItem) => void,
): void {
  const queuedAt = record.lastQueuedAt ?? record.queuedAt;
  const queueLatencyMs = Math.max(0, currentTime - queuedAt);
  if (queueLatencyMs >= input.staleQueuedAfterMs) {
    addItem({
      kind: 'stuck-queued',
      state: 'queued',
      operationId: record.operationId,
      workflowId: record.workflowId,
      activityName: record.activityName,
      queue: record.queue,
      retryCount: record.retryCount ?? Math.max(0, (record.attempt ?? 1) - 1),
      requeueCount: record.requeueCount ?? 0,
      queueLatencyMs,
      lastRequeueReason: record.lastRequeueReason,
      evidence: [
        `Task has waited ${queueLatencyMs}ms in queue "${record.queue}" without a worker claim`,
      ],
    });
  }

  addRetryStormDiagnostic(record, 'queued', input, addItem);
}

function addInflightDiagnostics(
  record: InflightRecord,
  input: GetTaskDiagnosticsInput,
  currentTime: number,
  addItem: (item: TaskDiagnosticItem) => void,
): void {
  const heartbeatAgeMs = calculateHeartbeatAgeMs(record, currentTime) ?? 0;
  if (heartbeatAgeMs >= input.staleHeartbeatAfterMs) {
    addItem({
      kind: 'stale-inflight',
      state: 'inflight',
      operationId: record.operationId,
      workflowId: record.workflowId,
      activityName: record.activityName,
      queue: record.queue,
      workerId: record.workerId,
      retryCount: record.retryCount ?? Math.max(0, (record.attempt ?? 1) - 1),
      requeueCount: record.requeueCount ?? 0,
      queueLatencyMs: calculateQueueLatencyMs(record),
      executionLatencyMs: calculateExecutionLatencyMs(record, currentTime),
      heartbeatAgeMs,
      lastRequeueReason: record.lastRequeueReason,
      evidence: [
        `Worker "${record.workerId}" has not sent a heartbeat for ${heartbeatAgeMs}ms on queue "${record.queue}"`,
      ],
    });
  }

  addRetryStormDiagnostic(record, 'inflight', input, addItem);
}

function addDeadLetterDiagnostics(
  record: DeadLetteredTaskRecord,
  addItem: (item: TaskDiagnosticItem) => void,
): void {
  addItem({
    kind: 'dead-lettered',
    state: 'dead-lettered',
    operationId: record.operationId,
    workflowId: record.workflowId,
    activityName: record.activityName,
    queue: record.queue,
    workerId: record.workerId,
    retryCount: record.retryCount ?? Math.max(0, (record.attempt ?? 1) - 1),
    requeueCount: record.requeueCount ?? 0,
    lastRequeueReason: record.lastRequeueReason,
    deadLetteredAt: record.deadLetteredAt,
    deadLetterReason: record.reason,
    storageError: record.errorMessage,
    retryAttempts: record.retryAttempts,
    evidence: [
      `Task result transition exhausted ${record.retryAttempts} storage attempts; reconciliation will not re-dispatch operation "${record.operationId}" until the dead-letter entry is cleared`,
    ],
  });
}

function addRetryStormDiagnostic(
  record: TaskRecord,
  state: TaskState,
  input: GetTaskDiagnosticsInput,
  addItem: (item: TaskDiagnosticItem) => void,
): void {
  const retryCount =
    record.retryCount ?? Math.max(0, ((record as { attempt?: number }).attempt ?? 1) - 1);
  const requeueCount = record.requeueCount ?? 0;
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
    activityName: 'activityName' in record ? record.activityName : undefined,
    queue: record.queue,
    workerId: 'workerId' in record ? record.workerId : undefined,
    retryCount,
    requeueCount,
    queueLatencyMs: calculateQueueLatencyMs(record),
    executionLatencyMs:
      'resolvedAt' in record ? calculateExecutionLatencyMs(record, record.resolvedAt) : undefined,
    lastRequeueReason: record.lastRequeueReason,
    resolutionReason: 'resolutionReason' in record ? record.resolutionReason : undefined,
    evidence: [
      `Task has ${retryCount} retries and ${requeueCount} requeues, meeting retry storm threshold ${input.retryStormMinimumAttempts}`,
    ],
  });
}

function addCapacityDiagnostics({
  registry,
  taskQueue,
  input,
  queues,
  addItem,
}: {
  registry?: WorkerRegistry | undefined;
  taskQueue?: TaskQueue | undefined;
  input: GetTaskDiagnosticsInput;
  queues: ReadonlySet<string>;
  addItem: (item: TaskDiagnosticItem) => void;
}): void {
  if (registry === undefined || taskQueue === undefined) return;

  const workersByQueue = groupWorkersByQueue(registry);
  const candidateQueues = selectCapacityDiagnosticQueues(input, queues, workersByQueue);

  for (const queue of candidateQueues) {
    const diagnostic = buildCapacityDiagnostic(queue, workersByQueue, taskQueue);
    if (diagnostic === null) continue;
    addItem(diagnostic);
  }
}

function groupWorkersByQueue(
  registry: WorkerRegistry,
): Map<string, ReturnType<WorkerRegistry['getAll']>> {
  const workersByQueue = new Map<string, ReturnType<WorkerRegistry['getAll']>>();
  for (const worker of registry.getAll()) {
    const workers = workersByQueue.get(worker.queue) ?? [];
    workers.push(worker);
    workersByQueue.set(worker.queue, workers);
  }
  return workersByQueue;
}

function selectCapacityDiagnosticQueues(
  input: GetTaskDiagnosticsInput,
  queues: ReadonlySet<string>,
  workersByQueue: ReadonlyMap<string, ReturnType<WorkerRegistry['getAll']>>,
): string[] {
  if (input.queue !== undefined) return [input.queue];
  if (queues.size > 0) return [...queues];
  if (input.operationId !== undefined || input.workflowId !== undefined) return [];
  return [...workersByQueue.keys()];
}

function buildCapacityDiagnostic(
  queue: string,
  workersByQueue: ReadonlyMap<string, ReturnType<WorkerRegistry['getAll']>>,
  taskQueue: TaskQueue,
): TaskDiagnosticItem | null {
  const workers = workersByQueue.get(queue) ?? [];
  const pendingCount = taskQueue.pendingCount(queue);
  if (workers.length === 0 || pendingCount === 0) return null;
  const totalCapacity = workers.reduce((sum, worker) => sum + worker.concurrency, 0);
  const totalInFlight = workers.reduce((sum, worker) => sum + worker.inFlight, 0);
  if (totalCapacity === 0 || totalInFlight < totalCapacity) return null;

  return {
    kind: 'all-workers-at-capacity',
    state: 'capacity',
    queue,
    retryCount: 0,
    requeueCount: 0,
    evidence: [
      `Queue "${queue}" has ${pendingCount} pending tasks and all ${workers.length} workers at capacity`,
    ],
  };
}

function matchesTaskRecordFilter(
  record: FilterableTaskRecord,
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
  }
}

function parseOptionalNumber(value: string | null): number | undefined {
  return value === null || value.length === 0 ? undefined : Number(value);
}

export const getTaskDiagnosticsRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/tasks/diagnostics',
  pathParamNames: [],
  operationName: 'weft.tasks.diagnostics',
  inputSources: {
    operationId: { kind: 'query', queryParam: 'operationId' },
    workflowId: { kind: 'query', queryParam: 'workflowId' },
    queue: { kind: 'query', queryParam: 'queue' },
    staleQueuedAfterMs: { kind: 'query', queryParam: 'staleQueuedAfterMs' },
    staleHeartbeatAfterMs: { kind: 'query', queryParam: 'staleHeartbeatAfterMs' },
    retryStormMinimumAttempts: { kind: 'query', queryParam: 'retryStormMinimumAttempts' },
    limit: { kind: 'query', queryParam: 'limit' },
  },
  extractInput: async (request) => {
    const url = new URL(request.url);
    return {
      operationId: url.searchParams.get('operationId') ?? undefined,
      workflowId: url.searchParams.get('workflowId') ?? undefined,
      queue: url.searchParams.get('queue') ?? undefined,
      staleQueuedAfterMs: parseOptionalNumber(url.searchParams.get('staleQueuedAfterMs')),
      staleHeartbeatAfterMs: parseOptionalNumber(url.searchParams.get('staleHeartbeatAfterMs')),
      retryStormMinimumAttempts: parseOptionalNumber(
        url.searchParams.get('retryStormMinimumAttempts'),
      ),
      limit: parseOptionalNumber(url.searchParams.get('limit')),
    };
  },
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: GetTaskDiagnosticsOutput) =>
    new Response(JSON.stringify(output), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  shapeFault: shapeRestFault,
};

export const clearTaskDeadLetterRestBinding: UnknownRestBinding = {
  method: 'DELETE',
  path: '/v1/tasks/diagnostics/dead-letter/:operationId',
  pathParamNames: ['operationId'],
  operationName: 'weft.tasks.diagnostics.deadletters.clear',
  inputSources: {
    operationId: { kind: 'path', pathParam: 'operationId' },
  },
  extractInput: async (_request, pathParams) => ({
    operationId: pathParams['operationId'],
  }),
  success: { kind: 'json', status: 200 },
  shapeSuccess: (output: ClearTaskDeadLetterOutput) =>
    new Response(JSON.stringify(output), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  shapeFault: shapeRestFault,
};
