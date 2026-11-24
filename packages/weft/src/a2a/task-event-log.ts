/**
 * The durable event log behind a workflow agent's A2A tasks.
 *
 * Every status and artifact change of a task is one `StreamResponse` appended to the
 * task's own log, in the same conditional batch that saves the task record, so the
 * record always names the sequence of the last event it reflects: its cursor. A
 * subscriber that reads the record and then follows the log from that cursor sees
 * every later change exactly once and never one the record already contains.
 *
 * Records share the task store's keys and format (`createWeftA2ATaskStore` reads
 * them), scoped by namespace, tenant, and owner. Each task also has one owner record,
 * keyed by its identifier alone, naming the scope it belongs to, so a change the
 * engine reports with only a workflow identifier can be applied to the right task.
 * The owner record outlives its task: pruning keeps it, because the engine's start
 * idempotency mapping is permanent, and the record is what keeps another caller who
 * reuses the same key from recreating the task in their own scope.
 *
 * Live delivery is in-process: a commit notifies the followers of the same log object.
 * A follower that falls behind reads the gap back from storage. When another process
 * can commit to the same storage (an engine under an ownership lease), a log created
 * with `recheck` also has each idle follower re-read the task record on that interval
 * and replay any events another process appended. Storage has no change feed, so this
 * is the same wait-for-local-commit-or-poll shape as Weft's durable fleet feed.
 *
 * @module a2a/task-event-log
 */

import { Message, StreamResponse, Task } from '@a2a-js/sdk';

import type { BatchOperation, ConditionalBatchCondition, Storage } from "../embedded/storage/src/index.ts";
import type { A2AStreamTimerScheduler } from './sse-response.ts';
import {
  type A2ACallerScope,
  type A2ACompareAndSwapAttempt,
  decodeRecord,
  encodeRecord,
  scopedKey,
  taskEventPrefix,
  withCompareAndSwap,
  workflowTaskKey,
} from './store-support.ts';

/** One durable event: its sequence, its opaque cursor (the SSE `id`), and the event. */
export type TaskEventEntry = {
  readonly sequence: number;
  readonly cursor: string;
  readonly event: StreamResponse;
};

/** The durable binding of a continuation message to the wait it answered. */
type PendingContinuation = {
  readonly message: Message;
  readonly signalName: string;
  readonly sequence: number;
};

/** A task record and the sequence of the last event it reflects. */
export type StoredWorkflowTask = {
  readonly task: Task;
  readonly sequence: number;
  readonly pendingContinuations: readonly PendingContinuation[];
};

/** The identity a task's owner record keeps, enough to rebuild its caller scope. */
export type TaskOwner = {
  readonly tenant: string;
  readonly authenticated: boolean;
  readonly userName: string;
};

/** What a commit writes: the task's next state and the events that led to it. */
export type TaskMutation = {
  readonly task: Task;
  readonly events: readonly StreamResponse[];
  readonly pendingContinuations?: readonly PendingContinuation[];
};

/** The outcome of a commit: the task as stored afterwards and the events it appended. */
export type TaskCommit = {
  readonly stored: StoredWorkflowTask;
  readonly appended: readonly TaskEventEntry[];
};

export type TaskEventLog = {
  /** The task record, or `undefined` when the scope holds no task with this identifier. */
  read(scope: A2ACallerScope, taskId: string): Promise<StoredWorkflowTask | undefined>;
  /**
   * Store a new task with its first events and its owner record. Resolves `undefined`,
   * writing nothing, when the scope already holds a task with this identifier, and
   * `'foreign'`, writing nothing, when another owner's task has (or had) it. The same
   * owner may create a task again after its record was pruned.
   *
   * `alongside`, when given, plans more writes for the same conditional batch. It runs
   * inside each attempt, once the owner is known to be free, so a lost compare-and-swap
   * plans again from what is stored then. Its records commit with the task or not at
   * all: an outcome other than a commit, a failed batch, or a crash before the batch
   * leaves none of them behind.
   */
  create(
    scope: A2ACallerScope,
    owner: TaskOwner,
    mutation: TaskMutation,
    alongside?: () => Promise<A2ACompareAndSwapAttempt<unknown>>,
  ): Promise<TaskCommit | 'foreign' | undefined>;
  /**
   * Apply `mutate` to the stored task and append its events atomically. `mutate` may
   * run more than once, after a lost compare-and-swap, and returns `undefined` for no
   * change. Resolves `undefined` when the task does not exist.
   */
  commit(
    scope: A2ACallerScope,
    taskId: string,
    mutate: (stored: StoredWorkflowTask) => TaskMutation | undefined,
  ): Promise<TaskCommit | undefined>;
  /**
   * Every event after `afterSequence`, then each new one as it is committed. The
   * generator returns once `signal` aborts, even while it waits for a commit: a
   * generator's own `return()` cannot interrupt that wait, so the request that follows
   * the log passes the signal that ends with it.
   */
  follow(
    scope: A2ACallerScope,
    taskId: string,
    afterSequence: number,
    signal?: AbortSignal,
  ): AsyncGenerator<TaskEventEntry, void, undefined>;
  /** The owner a task's record names, or `undefined` for an identifier no task has. */
  findOwner(taskId: string): Promise<TaskOwner | undefined>;
};

/** Sequences are zero-padded in keys so a prefix scan returns them in order. */
const SEQUENCE_DIGITS = 16;

function eventKey(taskKey: string, sequence: number): string {
  return taskEventPrefix(taskKey) + String(sequence).padStart(SEQUENCE_DIGITS, '0');
}

/** The opaque cursor of the event with this sequence. */
export function taskEventCursor(sequence: number): string {
  return String(sequence);
}

function readPendingContinuation(entry: unknown): PendingContinuation {
  if (
    entry === null ||
    typeof entry !== 'object' ||
    !('signalName' in entry) ||
    typeof entry.signalName !== 'string' ||
    !('sequence' in entry) ||
    typeof entry.sequence !== 'number' ||
    !('message' in entry) ||
    typeof entry.message !== 'object' ||
    entry.message === null
  ) {
    throw new Error('Invalid stored workflow continuation');
  }
  return {
    message: Message.fromJSON(entry.message),
    signalName: entry.signalName,
    sequence: entry.sequence,
  };
}

function readStored(record: Record<string, unknown>): StoredWorkflowTask {
  const sequence = record['sequence'];
  const pending = record['pendingContinuations'];
  if (pending !== undefined && !Array.isArray(pending)) {
    throw new Error('Invalid stored workflow continuations');
  }
  return {
    task: Task.fromJSON(record['task']),
    sequence: typeof sequence === 'number' ? sequence : -1,
    pendingContinuations: pending?.map(readPendingContinuation) ?? [],
  };
}

function readOwner(record: Record<string, unknown>): TaskOwner | undefined {
  const { tenant, authenticated, userName } = record;
  if (
    typeof tenant !== 'string' ||
    typeof authenticated !== 'boolean' ||
    typeof userName !== 'string'
  ) {
    return undefined;
  }
  return { tenant, authenticated, userName };
}

/** Whether two owner records name the same caller. */
export function sameOwner(left: TaskOwner, right: TaskOwner): boolean {
  return (
    left.tenant === right.tenant &&
    left.authenticated === right.authenticated &&
    left.userName === right.userName
  );
}

function readEntry(key: string, bytes: Uint8Array): TaskEventEntry {
  const record = decodeRecord(key, bytes);
  const sequence = Number(record['sequence']);
  return {
    sequence,
    cursor: taskEventCursor(sequence),
    event: StreamResponse.fromJSON(record['event']),
  };
}

type EventListener = (entries: readonly TaskEventEntry[]) => void;

/** How an idle follower re-reads storage for events another process committed. */
export type TaskEventRecheck = {
  /** The time between re-reads, in milliseconds. */
  readonly intervalMs: number;
  /** Arms each re-read; returns a function that cancels it. */
  readonly schedule: A2AStreamTimerScheduler;
};

/**
 * Create the event log of one workflow agent over `storage`, under `namespace`.
 * `now` stamps each saved record, as the task store does. With `recheck`, a follower
 * waiting for a commit also re-reads storage on that interval; without it, only
 * commits through this log object wake a follower.
 */
export function createTaskEventLog(options: {
  readonly storage: Storage;
  readonly namespace: string;
  readonly now: () => number;
  readonly recheck?: TaskEventRecheck;
}): TaskEventLog {
  const { storage, namespace, now, recheck } = options;
  const listeners = new Map<string, Set<EventListener>>();

  function notify(key: string, entries: readonly TaskEventEntry[]): void {
    if (entries.length === 0) return;
    for (const listener of listeners.get(key) ?? []) listener(entries);
  }

  /**
   * The operations that save `mutation` after the event with `sequence`, and the
   * entries it appends.
   */
  function writeMutation(
    key: string,
    sequence: number,
    mutation: TaskMutation,
    previousContinuations: readonly PendingContinuation[] = [],
  ): { operations: BatchOperation[]; commit: TaskCommit } {
    const operations: BatchOperation[] = [];
    const appended: TaskEventEntry[] = [];
    let next = sequence;
    for (const event of mutation.events) {
      next += 1;
      appended.push({ sequence: next, cursor: taskEventCursor(next), event });
      operations.push({
        type: 'put',
        key: eventKey(key, next),
        value: encodeRecord({ sequence: next, event: StreamResponse.toJSON(event) }),
      });
    }
    const pendingContinuations = mutation.pendingContinuations ?? previousContinuations;
    operations.push({
      type: 'put',
      key,
      value: encodeRecord({
        task: Task.toJSON(mutation.task),
        savedAt: now(),
        sequence: next,
        ...(pendingContinuations.length === 0
          ? {}
          : {
              pendingContinuations: pendingContinuations.map((entry) => ({
                ...entry,
                message: Message.toJSON(entry.message),
              })),
            }),
      }),
    });
    return {
      operations,
      commit: { stored: { task: mutation.task, sequence: next, pendingContinuations }, appended },
    };
  }

  async function* replay(key: string, afterSequence: number): AsyncGenerator<TaskEventEntry> {
    const start = eventKey(key, afterSequence + 1);
    for await (const [entryKey, bytes] of storage.scan(taskEventPrefix(key))) {
      if (entryKey >= start) yield readEntry(entryKey, bytes);
    }
  }

  /**
   * Every event after `afterSequence`, read only when the task record names one. The
   * record is saved in the same batch as its events, so one read answers whether to
   * scan the log.
   */
  async function* storedAfter(key: string, afterSequence: number): AsyncGenerator<TaskEventEntry> {
    const bytes = await storage.get(key);
    if (bytes === null) return;
    const sequence = decodeRecord(key, bytes)['sequence'];
    if (typeof sequence === 'number' && sequence > afterSequence) {
      yield* replay(key, afterSequence);
    }
  }

  /**
   * Listen for this log's commits to `key`. `wait` resolves `'commit'` once a commit
   * queued entries in `pending`, `'recheck'` when a `recheck` re-read is due and none
   * did, and `'aborted'` once `signal` aborts.
   */
  function subscribe(
    key: string,
    signal: AbortSignal | undefined,
  ): {
    readonly pending: TaskEventEntry[];
    wait(): Promise<'commit' | 'recheck' | 'aborted'>;
    close(): void;
  } {
    const pending: TaskEventEntry[] = [];
    let wake: (() => void) | undefined;
    let cancelRecheck: (() => void) | undefined;
    let onAbort: (() => void) | undefined;
    const listener: EventListener = (entries) => {
      pending.push(...entries);
      wake?.();
    };
    const keyListeners = listeners.get(key) ?? new Set<EventListener>();
    keyListeners.add(listener);
    listeners.set(key, keyListeners);
    const settle = (): void => {
      wake = undefined;
      cancelRecheck?.();
      cancelRecheck = undefined;
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
      onAbort = undefined;
    };
    return {
      pending,
      async wait() {
        if (signal?.aborted === true) return 'aborted';
        const woken = await new Promise<'commit' | 'recheck' | 'aborted'>((resolve) => {
          wake = () => {
            resolve('commit');
          };
          if (signal !== undefined) {
            // Settled at once, so an aborted request leaves no re-read armed.
            onAbort = () => {
              settle();
              resolve('aborted');
            };
            signal.addEventListener('abort', onAbort, { once: true });
          }
          if (recheck !== undefined) {
            cancelRecheck = recheck.schedule(() => {
              resolve('recheck');
            }, recheck.intervalMs);
          }
        });
        settle();
        return woken === 'recheck' && pending.length > 0 ? 'commit' : woken;
      },
      close() {
        settle();
        keyListeners.delete(listener);
        if (keyListeners.size === 0) listeners.delete(key);
      },
    };
  }

  return {
    async read(scope, taskId) {
      const key = scopedKey('task', scope, taskId);
      const bytes = await storage.get(key);
      return bytes === null ? undefined : readStored(decodeRecord(key, bytes));
    },

    async create(scope, owner, mutation, alongside) {
      const key = scopedKey('task', scope, mutation.task.id);
      const ownerKey = workflowTaskKey(namespace, mutation.task.id);
      const created = await withCompareAndSwap<TaskCommit | 'foreign' | undefined>(
        storage,
        key,
        async () => {
          if ((await storage.get(key)) !== null) return { result: undefined };
          const existingOwner = await storage.get(ownerKey);
          if (existingOwner !== null) {
            const recorded = readOwner(decodeRecord(ownerKey, existingOwner));
            if (recorded === undefined || !sameOwner(recorded, owner)) {
              return { result: 'foreign' as const };
            }
          }
          const extra = await alongside?.();
          const { operations, commit } = writeMutation(key, -1, mutation);
          operations.push({ type: 'put', key: ownerKey, value: encodeRecord({ ...owner }) });
          const conditions: ConditionalBatchCondition[] = [
            { key, expectedValue: null },
            { key: ownerKey, expectedValue: existingOwner },
          ];
          if (extra !== undefined && 'operations' in extra) {
            conditions.push(...extra.conditions);
            operations.push(...extra.operations);
          }
          return { conditions, operations, result: commit };
        },
      );
      if (created !== undefined && created !== 'foreign') notify(key, created.appended);
      return created;
    },

    async commit(scope, taskId, mutate) {
      const key = scopedKey('task', scope, taskId);
      const committed = await withCompareAndSwap(storage, key, async () => {
        const current = await storage.get(key);
        if (current === null) return { result: undefined };
        const stored = readStored(decodeRecord(key, current));
        const mutation = mutate(stored);
        if (mutation === undefined) return { result: { stored, appended: [] } };
        const { operations, commit } = writeMutation(
          key,
          stored.sequence,
          mutation,
          stored.pendingContinuations,
        );
        return { conditions: [{ key, expectedValue: current }], operations, result: commit };
      });
      if (committed !== undefined) notify(key, committed.appended);
      return committed;
    },

    async *follow(scope, taskId, afterSequence, signal) {
      const key = scopedKey('task', scope, taskId);
      const subscription = subscribe(key, signal);
      let last = afterSequence;
      try {
        // Listening before replaying means no commit can fall between the two.
        for await (const entry of replay(key, last)) {
          last = entry.sequence;
          yield entry;
        }
        while (true) {
          const entry = subscription.pending.shift();
          let next: AsyncIterable<TaskEventEntry> | readonly TaskEventEntry[] = [];
          if (entry === undefined) {
            const woken = await subscription.wait();
            if (woken === 'aborted') return;
            // A due re-read looks for what another process committed, only in storage.
            if (woken === 'recheck') next = storedAfter(key, last);
          } else if (entry.sequence === last + 1) {
            next = [entry];
          } else if (entry.sequence > last + 1) {
            // Notifications of concurrent commits can arrive out of order; read the gap.
            next = replay(key, last);
          }
          for await (const delivered of next) {
            last = delivered.sequence;
            yield delivered;
          }
        }
      } finally {
        subscription.close();
      }
    },

    async findOwner(taskId) {
      const key = workflowTaskKey(namespace, taskId);
      const bytes = await storage.get(key);
      return bytes === null ? undefined : readOwner(decodeRecord(key, bytes));
    },
  };
}
