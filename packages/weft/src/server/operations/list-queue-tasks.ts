/**
 * `weft.task.queues.tasks` operation + REST binding.
 *
 * Lists the tasks of one queue that an operator can act on: the ones waiting for a worker, in the
 * order they arrived, and the ones that failed for good (dead letters), with how many of each the
 * queue holds. A task a worker is running, and one that finished, is neither: the first is in
 * flight and the second needs nothing. Failed tasks come first, since they are what needs a
 * person, then the waiting ones; a page continues from the `nextCursor` of the one before it.
 *
 * Reads the task ledger, so it costs one scan of it, as `weft.tasks.diagnostics` does.
 *
 * @module server/operations/list-queue-tasks
 */

import type { Storage } from "../../embedded/storage/src/index.ts";
import { z } from 'zod';

import { defineOperation } from "../../embedded/backchannel/src/index.ts";
import { invalidParamsFault, type UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import {
  decodeRemoteTaskRecord,
  type RemoteTaskRecord,
} from '../../core/task-ledger/task-ledger.ts';
import { shapeWeftOperationFaultAsJson } from '../weft-operation-fault.ts';
import { requireOperationStorage } from './operation-helpers.ts';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const queueTaskStatusSchema = z.enum(['waiting', 'failed']);

const listQueueTasksInput = z.object({
  queue: z.string().min(1).describe('Name of the task queue whose tasks to list.'),
  status: z
    .enum(['all', 'waiting', 'failed'])
    .default('all')
    .describe(
      'Which tasks to list: `waiting` for those queued for a worker, `failed` for those that failed for good, or `all` for both, failed first; default `all`.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe('Maximum number of tasks to return, 1 to 100; default 25.'),
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe('The `nextCursor` of the previous page; omit it for the first page.'),
});

const queueTaskSchema = z
  .object({
    operationId: z.string(),
    status: queueTaskStatusSchema,
    workflowId: z.string().optional(),
    workflowType: z.string(),
    activityName: z.string(),
    attempt: z.number().int().nonnegative(),
    at: z.number().describe('When it first queued (waiting) or failed for good (failed).'),
    error: z.string().optional(),
    persistenceFailureReason: z.string().optional(),
  })
  .strict();

const listQueueTasksOutput = z
  .object({
    queue: z.string(),
    counts: z.object({
      waiting: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }),
    items: z.array(queueTaskSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type ListQueueTasksInput = z.infer<typeof listQueueTasksInput>;
export type ListQueueTasksOutput = z.infer<typeof listQueueTasksOutput>;
/** One task `weft.task.queues.tasks` lists. */
export type QueueTask = z.infer<typeof queueTaskSchema>;

/** Failed tasks sort before waiting ones. */
const RANK = { failed: 0, waiting: 1 } as const;

type Keyed = { readonly rank: number; readonly task: QueueTask };

function compareKeyed(left: Keyed, right: Keyed): number {
  return (
    left.rank - right.rank ||
    left.task.at - right.task.at ||
    Number(left.task.operationId > right.task.operationId) -
      Number(left.task.operationId < right.task.operationId)
  );
}

function cursorOf(item: Keyed): string {
  return `${item.rank}.${item.task.at}.${item.task.operationId}`;
}

function parseCursor(cursor: string): Keyed {
  const match = /^([01])\.(\d+)\.(.+)$/su.exec(cursor);
  if (match === null) throw invalidParamsFault('The cursor is not one this operation returned.');
  const [, rank, at, operationId] = match;
  return {
    rank: Number(rank),
    // The sentinel is compared by position only, so its other fields are never read.
    task: {
      operationId: operationId ?? '',
      status: 'waiting',
      workflowType: '',
      activityName: '',
      attempt: 0,
      at: Number(at),
    },
  };
}

/** The listed task a ledger record is, or `undefined` for a record that is neither waiting nor failed. */
function keyedTaskOf(record: RemoteTaskRecord): Keyed | undefined {
  const common = {
    operationId: record.operationId,
    ...(record.workflowId === undefined ? {} : { workflowId: record.workflowId }),
    workflowType: record.workflowType,
    activityName: record.activityName,
  };
  if (record.state === 'queued') {
    return {
      rank: RANK.waiting,
      task: { ...common, status: 'waiting', attempt: record.attempt, at: record.firstQueuedAt },
    };
  }
  if (record.state !== 'deadLettered') return undefined;
  return {
    rank: RANK.failed,
    task: {
      ...common,
      status: 'failed',
      attempt: record.attempt,
      at: record.deadLetteredAt,
      ...(record.error === undefined ? {} : { error: record.error }),
      persistenceFailureReason: record.persistenceFailureReason,
    },
  };
}

/** The page of `wanted` that follows `input.cursor`, and the cursor of the page after it. */
function pageOf(
  wanted: Keyed[],
  input: ListQueueTasksInput,
): { items: QueueTask[]; nextCursor: string | null } {
  wanted.sort(compareKeyed);
  const after = input.cursor === undefined ? undefined : parseCursor(input.cursor);
  const remaining =
    after === undefined ? wanted : wanted.filter((item) => compareKeyed(item, after) > 0);
  const page = remaining.slice(0, input.limit);
  const last = page.at(-1);
  return {
    items: page.map((item) => item.task),
    nextCursor: last !== undefined && remaining.length > page.length ? cursorOf(last) : null,
  };
}

/**
 * Reads one page of `input.queue`'s tasks from the ledger. Exported for tests; the operation calls
 * it with the engine's storage.
 */
export async function collectQueueTasks(
  storage: Pick<Storage, 'scan'>,
  input: ListQueueTasksInput,
): Promise<ListQueueTasksOutput> {
  const counts = { waiting: 0, failed: 0 };
  const wanted: Keyed[] = [];
  for await (const [, value] of storage.scan('task-ledger:')) {
    const record = decodeRemoteTaskRecord(value);
    if (record === null || record.queue !== input.queue) continue;
    const keyed = keyedTaskOf(record);
    if (keyed === undefined) continue;
    counts[keyed.task.status] += 1;
    if (input.status === 'all' || input.status === keyed.task.status) wanted.push(keyed);
  }
  const { items, nextCursor } = pageOf(wanted, input);
  return { queue: input.queue, counts, items, nextCursor };
}

/** The `weft.task.queues.tasks` operation: the tasks of one queue an operator can act on. */
export const listQueueTasksOperation = defineOperation({
  name: 'weft.task.queues.tasks',
  mcpExposable: false,
  summary: 'List the waiting and failed-for-good tasks of one task queue',
  description:
    'List the tasks of one queue that wait for a worker, oldest first, and the ones that failed ' +
    'for good, with how many of each the queue holds. Failed tasks come first. Page with ' +
    '`cursor`. Read-only.',
  destructive: false,
  tags: ['System'],
  inputSchema: listQueueTasksInput,
  outputSchema: listQueueTasksOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['system:read'] } },
  producibleFaults: ['InvalidParams'],
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host: engine }): Promise<ListQueueTasksOutput> =>
    collectQueueTasks(requireOperationStorage(engine, ['scan']), input),
});

/** `GET /v1/task-queues/:queue/tasks`, taking `status`, `limit` and `cursor` as query parameters. */
export const listQueueTasksRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/task-queues/:queue/tasks',
  pathParamNames: ['queue'],
  operationName: 'weft.task.queues.tasks',
  inputSources: {
    queue: { kind: 'path', pathParam: 'queue' },
    status: { kind: 'query', queryParam: 'status' },
    limit: { kind: 'query', queryParam: 'limit' },
    cursor: { kind: 'query', queryParam: 'cursor' },
  },
  extractInput: async (request, pathParams) => {
    const url = new URL(request.url);
    const limit = url.searchParams.get('limit');
    return {
      queue: pathParams['queue'] ?? '',
      status: url.searchParams.get('status') ?? undefined,
      limit: limit === null || limit.length === 0 ? undefined : Number(limit),
      cursor: url.searchParams.get('cursor') ?? undefined,
    };
  },
  success: { kind: 'json', status: 200 },
  shapeFault: shapeWeftOperationFaultAsJson,
};
