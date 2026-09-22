/**
 * `weft.tasks.diagnostics` operation + REST binding.
 *
 * Scans the durable task ledger (WFT-24 — previously the retired
 * `op:queued:`/`op:inflight:`/`op:resolved:`/`op:dead-letter:` keys, which
 * nothing has written since the WFT-22 ledger cutover) and live worker state
 * to identify queue pressure, expected delayed attempts, stale in-flight
 * work, retry storms, elapsed terminal non-adoption, dead letters, and worker
 * capacity saturation. Results are intentionally bounded and low-cardinality
 * so operators can use them in a dashboard without turning workflow or worker
 * identifiers into metrics labels.
 *
 * `leased`, `completing`, and `cancelling` ledger states are all reported as
 * diagnostic `state: 'inflight'`: they share the same lease-holder/heartbeat
 * shape and the same operator question ("is a worker still making progress on
 * this attempt?"), so exposing the ledger's more granular internal states
 * here would add distinctions operators cannot act on differently. Terminal
 * records reported as `unadopted-terminal` use the coarse `resolved` state and
 * expose no attempt-count history.
 *
 * Retry-storm detection (`kind: 'retry-storm'`) no longer covers `terminal`
 * records: `RemoteTaskTerminal` carries no `retryCount`/`requeueCount` (WFT-25
 * deliberately dropped attempt-count history once a task resolves), so
 * there is nothing left to detect a storm from once an attempt reaches a
 * disposition. Terminal records are classified only by elapsed non-adoption;
 * that diagnostic does not claim an adoption attempt failed. `dead-lettered`
 * diagnostics remain a distinct kind for result-persistence exhaustion.
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

import type { WorkerRegistry } from '../../worker/registry.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import type { TaskQueue } from '../task-queue.ts';
import { requireOperationStorage } from './operation-helpers.ts';
import { collectTaskDiagnostics } from './task-diagnostics-collector.ts';

const DEFAULT_STALE_QUEUED_AFTER_MS = 60_000;
const DEFAULT_STALE_HEARTBEAT_AFTER_MS = 60_000;
const DEFAULT_RETRY_STORM_MINIMUM_ATTEMPTS = 3;
const DEFAULT_UNADOPTED_AFTER_MS = 60_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const taskDiagnosticKindSchema = z.enum([
  'stuck-queued',
  'stale-inflight',
  'retry-storm',
  'all-workers-at-capacity',
  'dead-lettered',
  'delayed',
  'unadopted-terminal',
]);

const existingTaskDiagnosticItemSchema = z
  .object({
    kind: z.enum([
      'stuck-queued',
      'stale-inflight',
      'retry-storm',
      'all-workers-at-capacity',
      'dead-lettered',
    ]),
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

const delayedTaskDiagnosticItemSchema = z
  .object({
    kind: z.literal('delayed'),
    state: z.literal('queued'),
    operationId: z.string(),
    workflowId: z.string().optional(),
    queue: z.string(),
    retryCount: z.number().int().nonnegative(),
    requeueCount: z.number().int().nonnegative(),
    availableAt: z.number().nonnegative(),
    evidence: z.array(z.string()),
  })
  .strict();

const unadoptedTerminalTaskDiagnosticItemSchema = z
  .object({
    kind: z.literal('unadopted-terminal'),
    state: z.literal('resolved'),
    operationId: z.string(),
    workflowId: z.string().optional(),
    queue: z.string(),
    terminalAt: z.number().nonnegative(),
    adopted: z.literal(false),
    evidence: z.array(z.string()),
  })
  .strict();

const taskDiagnosticItemSchema = z.union([
  existingTaskDiagnosticItemSchema,
  delayedTaskDiagnosticItemSchema,
  unadoptedTerminalTaskDiagnosticItemSchema,
]);

const taskDiagnosticsSummarySchema = z
  .object({
    stuckQueued: z.number().int().nonnegative(),
    staleInflight: z.number().int().nonnegative(),
    retryStorms: z.number().int().nonnegative(),
    allWorkersAtCapacity: z.number().int().nonnegative(),
    deadLettered: z.number().int().nonnegative(),
    delayed: z.number().int().nonnegative(),
    unadoptedTerminal: z.number().int().nonnegative(),
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
  includeExpectedDelayed: z.boolean().default(false),
  unadoptedAfterMs: z.number().int().nonnegative().default(DEFAULT_UNADOPTED_AFTER_MS),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

export type GetTaskDiagnosticsInput = z.infer<typeof getTaskDiagnosticsInput>;

export type TaskDiagnosticKind = z.infer<typeof taskDiagnosticKindSchema>;

export type TaskDiagnosticItem = z.infer<typeof taskDiagnosticItemSchema>;

export type TaskDiagnosticsSummary = z.infer<typeof taskDiagnosticsSummarySchema>;

export type GetTaskDiagnosticsOutput = z.infer<typeof getTaskDiagnosticsOutput>;

interface GetTaskDiagnosticsOptions {
  registry?: WorkerRegistry | undefined;
  taskQueue?: TaskQueue | undefined;
  now?: (() => number) | undefined;
}

export function createGetTaskDiagnosticsOperation(options: GetTaskDiagnosticsOptions = {}) {
  return defineOperation({
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
      const storage = requireOperationStorage(engine, ['scan']);
      return collectTaskDiagnostics({
        engine: { storage },
        input,
        currentTime,
        registry: options.registry,
        taskQueue: options.taskQueue,
      });
    },
  });
}

export const getTaskDiagnosticsOperation = createGetTaskDiagnosticsOperation();

function parseOptionalNumber(value: string | null): number | undefined {
  return value === null || value.length === 0 ? undefined : Number(value);
}

function parseOptionalBoolean(value: string | null): boolean | string | undefined {
  if (value === null || value.length === 0) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
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
    includeExpectedDelayed: { kind: 'query', queryParam: 'includeExpectedDelayed' },
    unadoptedAfterMs: { kind: 'query', queryParam: 'unadoptedAfterMs' },
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
      includeExpectedDelayed: parseOptionalBoolean(url.searchParams.get('includeExpectedDelayed')),
      unadoptedAfterMs: parseOptionalNumber(url.searchParams.get('unadoptedAfterMs')),
      limit: parseOptionalNumber(url.searchParams.get('limit')),
    };
  },
  success: { kind: 'json', status: 200 },
};
