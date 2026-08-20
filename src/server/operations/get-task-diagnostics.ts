/**
 * `weft.tasks.diagnostics` operation + REST binding.
 *
 * Scans the durable task ledger (WFT-24 — previously the retired
 * `op:queued:`/`op:inflight:`/`op:resolved:`/`op:dead-letter:` keys, which
 * nothing has written since the WFT-22 ledger cutover) and live worker state
 * to identify queue pressure, stale in-flight work, retry storms, dead
 * letters, and worker capacity saturation. Results are intentionally bounded
 * and low-cardinality so operators can use them in a dashboard without
 * turning workflow or worker identifiers into metrics labels.
 *
 * The output schema's field names and `kind`/`state` vocabulary are
 * unchanged from the pre-ledger version — only the internal scan and
 * classification logic changed — so existing dashboards built against this
 * endpoint's shape keep working. `leased`, `completing`, and `cancelling`
 * ledger states are all reported as diagnostic `state: 'inflight'`: they
 * share the same lease-holder/heartbeat shape and the same operator
 * question ("is a worker still making progress on this attempt?"), so
 * exposing the ledger's more granular internal states here would add
 * distinctions operators cannot act on differently.
 *
 * Retry-storm detection (`kind: 'retry-storm'`) no longer covers `terminal`
 * records: `RemoteTaskTerminal` carries no `retryCount`/`requeueCount` (WFT-25
 * deliberately dropped attempt-count history once a task resolves), so
 * there is nothing left to detect a storm from once an attempt reaches a
 * disposition. The `resolved` value in the `state` enum is kept in the
 * output schema for backward compatibility but nothing produces it anymore.
 * `dead-lettered` diagnostics are unaffected — that is a distinct, separate
 * `kind`.
 *
 * Unlike the pre-ledger scan, the full ledger scan this operation performs
 * is one combined keyspace across every state (queued through terminal),
 * not separate per-state prefixes — there is no time-bounded history index
 * to limit how many terminal records get walked past on the way to
 * classifying the ones that still matter. Operators who dispatch high
 * volumes of tasks and want this scan to stay cheap should set
 * {@link ServeOptions.taskRetentionWindowMs} so adopted terminal records
 * are reaped rather than accumulating indefinitely.
 *
 * @module server/operations/get-task-diagnostics
 */

import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import type { WorkerRegistry } from '../../worker/registry.ts';
import { raiseFault } from '../operation-catalog/raise-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { commitTaskLedgerDelete } from '../runtime/task-ledger-runtime.ts';
import { canClearDeadLetteredTask } from '../task-ledger-transitions.ts';
import { decodeRemoteTaskRecord, type RemoteTaskRecord } from '../task-ledger.ts';
import type { TaskQueue } from '../task-queue.ts';
import {
  calculateExecutionLatencyMs,
  calculateHeartbeatAgeMs,
  calculateQueueLatencyMs,
} from '../task-state.ts';

const DEFAULT_STALE_QUEUED_AFTER_MS = 60_000;
const DEFAULT_STALE_HEARTBEAT_AFTER_MS = 60_000;
const DEFAULT_RETRY_STORM_MINIMUM_ATTEMPTS = 3;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

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
    lastRequeueReason: z.string().optional(),
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

const restOnlyTaskDiagnosticsTransports = {
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
  producibleFaults: ['NotFound'],
  discoverable: true,
  transports: restOnlyTaskDiagnosticsTransports,
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<ClearTaskDeadLetterOutput> => {
    const typedEngine = engine as Engine;
    const deleted = await commitTaskLedgerDelete(
      typedEngine.storage,
      input.operationId,
      canClearDeadLetteredTask,
      1,
    );
    if (!deleted.ok) {
      raiseFault(clearTaskDeadLetterOperation, {
        code: 'NotFound',
        message: `No dead-lettered task found for operation "${input.operationId}"`,
        data: { resource: 'task', identifier: input.operationId },
      });
    }
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
      // Nothing else about a finished attempt is diagnostically stuck.
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
    operationId: pathParams['operationId'] ?? '',
  }),
  success: { kind: 'json', status: 200 },
};
