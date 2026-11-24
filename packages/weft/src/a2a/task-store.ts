/**
 * `createWeftA2ATaskStore`: the A2A SDK's `TaskStore` over any Weft storage adapter
 * with conditional batches.
 *
 * Each task is one record, keyed by the store's namespace, the caller's tenant, the
 * caller's owner, and the task identifier, and serialized with the SDK's own
 * `Task.toJSON`, so a task saved by one caller is invisible to every other.
 *
 * Pruning a task also removes the push configurations stored for it under the same
 * namespace and scope, because once the task is gone no protocol route can reach
 * them, and their credentials must not outlive it.
 *
 * @module a2a/task-store
 */

import { type ListTasksRequest, type ListTasksResponse, Task, TaskState } from '@a2a-js/sdk';
import type { ServerCallContext, TaskStore } from '@a2a-js/sdk/server';

import { type BatchOperation, requireStorageCapability, type Storage } from "../embedded/storage/src/index.ts";
import { bytesEqual } from '../core/application-primitive-commit.ts';
import {
  type A2APageCursor,
  callerScope,
  compareIdentifiers,
  decodeRecord,
  encodeRecord,
  namespaceKeyPrefix,
  pageTokenBinding,
  paginate,
  resolvePageSize,
  scanRecords,
  scopedKey,
  siblingKey,
  taskEventPrefix,
  withCompareAndSwap,
} from './store-support.ts';

/** Terminal tasks are kept for thirty days after their last save unless told otherwise. */
export const DEFAULT_A2A_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Options for {@link createWeftA2ATaskStore}. */
export type WeftA2ATaskStoreOptions = {
  /** Any Weft storage adapter that reports `conditionalBatch`. */
  readonly storage: Storage;
  /** Separates one published agent's tasks from another's in shared storage. */
  readonly namespace: string;
  /**
   * How long a terminal task (completed, failed, canceled, or rejected) is kept after
   * its last save before {@link WeftA2ATaskStore.prune} removes it. Defaults to thirty
   * days.
   */
  readonly terminalRetentionMs?: number;
  /** The clock, in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
};

/** The SDK's `TaskStore`, plus retention pruning. */
export interface WeftA2ATaskStore extends TaskStore {
  /**
   * Remove every terminal task of this namespace, in every tenant and for every
   * owner, whose last save is older than `terminalRetentionMs`, together with every
   * push configuration (live or tombstoned) stored for it under this namespace.
   * Resolves with how many tasks it removed. A task saved again while the prune runs
   * is kept.
   */
  prune(): Promise<number>;
}

const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

type ListedTask = A2APageCursor & { readonly task: Task };

function statusSortKey(task: Task): number | null {
  const timestamp = task.status?.timestamp;
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * List order: status timestamp descending (tasks without one last), then task
 * identifier ascending.
 */
function compareListOrder(left: A2APageCursor, right: A2APageCursor): number {
  const leftKey = left.sortKey ?? Number.NEGATIVE_INFINITY;
  const rightKey = right.sortKey ?? Number.NEGATIVE_INFINITY;
  if (leftKey !== rightKey) return rightKey > leftKey ? 1 : -1;
  return compareIdentifiers(left.id, right.id);
}

function matchesFilters(entry: ListedTask, params: ListTasksRequest): boolean {
  if (params.contextId && entry.task.contextId !== params.contextId) return false;
  if (params.status && entry.task.status?.state !== params.status) return false;
  if (params.statusTimestampAfter) {
    const after = Date.parse(params.statusTimestampAfter);
    return entry.sortKey !== null && entry.sortKey >= after;
  }
  return true;
}

function project(task: Task, params: ListTasksRequest): Task {
  const { historyLength } = params;
  return {
    ...task,
    artifacts: params.includeArtifacts === true ? task.artifacts : [],
    history:
      historyLength === undefined
        ? task.history
        : historyLength <= 0
          ? []
          : task.history.slice(-historyLength),
  };
}

function readTask(record: Record<string, unknown>): Task {
  return Task.fromJSON(record['task']);
}

/**
 * Create an A2A `TaskStore` over a Weft storage adapter.
 *
 * Records are keyed by `ServerCallContext.tenant` (empty when absent), the caller's
 * `user` (`userName` when authenticated, one shared anonymous owner otherwise), and
 * `namespace`. `list` filters by `contextId`, `status`, and `statusTimestampAfter`
 * (inclusive), sorts by status timestamp descending with the task identifier
 * ascending as the tie-breaker, and pages with an opaque token bound to the caller
 * and the filter set.
 *
 * @throws {Error} When `storage` does not report `conditionalBatch`.
 */
export function createWeftA2ATaskStore(options: WeftA2ATaskStoreOptions): WeftA2ATaskStore {
  const { storage, namespace } = options;
  requireStorageCapability(storage, 'conditionalBatch', 'A2A task store');
  const now = options.now ?? Date.now;
  const terminalRetentionMs = options.terminalRetentionMs ?? DEFAULT_A2A_TERMINAL_RETENTION_MS;

  /**
   * Delete one expired task, its push configurations, and, for a workflow agent's
   * task, its durable events, conditioned on the task record it was judged by and on
   * the task's push head, which every push create and delete bumps. Resolves `false`,
   * deleting nothing, once the task has been saved again (or removed) since it was
   * judged.
   *
   * A workflow agent's owner record stays. The engine's start idempotency mapping is
   * permanent, so another caller who sends the same user and `messageId` after the
   * prune is handed the same workflow; the owner record is what refuses them.
   */
  async function pruneTask(key: string, judged: Uint8Array): Promise<boolean> {
    const headKey = siblingKey(key, 'task', 'push-head');
    const pushPrefix = `${siblingKey(key, 'task', 'push')}:`;
    return withCompareAndSwap(storage, key, async () => {
      const current = await storage.get(key);
      if (current === null || !bytesEqual(current, judged)) return { result: false };
      const head = await storage.get(headKey);
      const operations: BatchOperation[] = [{ type: 'delete', key }];
      if (head !== null) operations.push({ type: 'delete', key: headKey });
      for await (const [pushKey] of storage.scan(pushPrefix)) {
        operations.push({ type: 'delete', key: pushKey });
      }
      for await (const [eventKey] of storage.scan(taskEventPrefix(key))) {
        operations.push({ type: 'delete', key: eventKey });
      }
      return {
        conditions: [
          { key, expectedValue: judged },
          { key: headKey, expectedValue: head },
        ],
        operations,
        result: true,
      };
    });
  }

  return {
    async save(task: Task, context: ServerCallContext): Promise<void> {
      const key = scopedKey('task', callerScope(namespace, context), task.id);
      await withCompareAndSwap(storage, key, async () => {
        const current = await storage.get(key);
        // A record this release cannot read is never overwritten by an older format.
        const previous = current === null ? undefined : decodeRecord(key, current);
        // A workflow agent's task keeps the sequence of its last durable event.
        const sequence = previous?.['sequence'];
        const pendingContinuations = previous?.['pendingContinuations'];
        const value = encodeRecord({
          task: Task.toJSON(task),
          savedAt: now(),
          ...(typeof sequence === 'number' ? { sequence } : {}),
          ...(pendingContinuations === undefined ? {} : { pendingContinuations }),
        });
        return {
          conditions: [{ key, expectedValue: current }],
          operations: [{ type: 'put', key, value }],
          result: undefined,
        };
      });
    },

    async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
      const key = scopedKey('task', callerScope(namespace, context), taskId);
      const bytes = await storage.get(key);
      return bytes === null ? undefined : readTask(decodeRecord(key, bytes));
    },

    async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
      const pageSize = resolvePageSize(params.pageSize);
      const scope = callerScope(namespace, context);
      const binding = pageTokenBinding([
        'tasks',
        scope.namespace,
        scope.tenant,
        scope.owner,
        params.contextId || '',
        params.status || 0,
        params.statusTimestampAfter || '',
      ]);
      const records = await scanRecords(storage, `${scopedKey('task', scope)}:`);
      const matching = records
        .map(({ record }): ListedTask => {
          const task = readTask(record);
          return { task, id: task.id, sortKey: statusSortKey(task) };
        })
        .filter((entry) => matchesFilters(entry, params))
        .toSorted(compareListOrder);
      const { page, nextPageToken } = paginate(matching, {
        pageSize,
        pageToken: params.pageToken || '',
        binding,
        compare: compareListOrder,
      });
      return {
        tasks: page.map((entry) => project(entry.task, params)),
        nextPageToken,
        pageSize,
        totalSize: matching.length,
      };
    },

    async prune(): Promise<number> {
      const cutoff = now() - terminalRetentionMs;
      const records = await scanRecords(storage, namespaceKeyPrefix('task', namespace));
      const expired = records.filter(({ record }) => {
        const state = readTask(record).status?.state;
        return (
          state !== undefined && TERMINAL_STATES.has(state) && Number(record['savedAt']) < cutoff
        );
      });
      let removed = 0;
      for (const { key, bytes } of expired) {
        if (await pruneTask(key, bytes)) removed += 1;
      }
      return removed;
    },
  };
}
