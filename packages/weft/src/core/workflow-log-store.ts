/**
 * The persisted `ctx.log` lines of a workflow run (COR-1811): a bounded, buffered sink that writes
 * the lines the engine emits, a reader that serves them per run and per step, and a retention pass
 * that drops the lines of finished runs that went quiet.
 *
 * The sink is the host's `EngineOptions.onLog`; the engine is handed the same store through
 * `EngineOptions.workflowLogs`, which is how `Engine.getLogs` reads (after flushing the buffered
 * tail), how a shutdown flushes, and how a purge removes a run's lines with the run.
 *
 * Bounds, all documented on {@link WorkflowLogStoreOptions}: a run keeps at most
 * `maximumLinesPerRun` lines (500 by default), evicting the oldest and counting each in
 * {@link WorkflowLogsResult.dropped}; a line's message and attributes together are held to
 * `maximumLineBytes` (2 KiB by default): a long message is cut with a visible marker, and
 * attributes that do not fit beside it are dropped.
 *
 * Redaction (COR-1988): a line's attributes are redacted before they are measured and stored, with
 * the redactor the timeline summaries use (`sanitizeDebugValueForDisplay`): a value under a
 * key that names a secret outright (`card`, `cvv`, `ssn`, `pin`, `password`, `secret`, `apiKey`,
 * ...) is replaced whatever its type, a string, object or array under a looser key (`token`,
 * `session`, `auth`) is replaced (a number or a boolean there passes, so `inputTokens: 12` stays
 * readable), and a bearer token, JSON Web Token or card number is replaced wherever it appears. A secret is therefore never persisted. The message is
 * not redacted, and the host's own `onLog` sinks that wrap this one still see the original record.
 * Attributes the redactor cannot turn into a record are dropped and the line is marked
 * `truncated`.
 *
 * Durability: the sink is asynchronous. A line is buffered in memory and written in a batch on the
 * next turn, on {@link WorkflowLogStore.flush}, and on engine shutdown (`shutdown()` or `await using`;
 * a synchronous `using` disposal cannot await storage, so it flushes nothing). A crash can lose the lines
 * of the turn that had not been written yet; that is accepted. A write that fails drops its batch
 * and reports to {@link WorkflowLogStoreOptions.onError}; a log must never fail the run it describes.
 *
 * The store assumes one writer per run, which Weft's one-engine-per-store rule already guarantees:
 * each write reads the run's counter record, extends it, and writes it back with the lines.
 *
 * @module core/workflow-log-store
 */

import {
  storageConditionalBatch,
  tryDecodeStorageKeyComponent,
  type BatchOperation,
  type Storage,
} from "../embedded/storage/src/index.ts";

import { KEYS } from '../storage/keys.ts';
import { decode } from './codec.ts';
import { isRecord, sanitizeDebugValueForDisplay } from './debug-output.ts';
import type { WorkflowLogRecord } from './types/workflow-log.ts';
import {
  DEFAULT_MAXIMUM_LOG_LINES_PER_RUN,
  DEFAULT_MAXIMUM_LOG_LINE_BYTES,
  ENCODER,
  MAXIMUM_LOG_LINES_PER_RUN_LIMIT,
  cutMessage,
  decodeCounter,
  decodeLine,
  isNonNegativeInteger,
  sequenceOfKey,
  serializeAttributes,
  type Counter,
  type PendingLine,
  type WorkflowLogLine,
  type WorkflowLogsResult,
} from './workflow-log-codec.ts';

/** The most batch operations one storage write carries when the eviction is large. */
const EVICTION_CHUNK = 2000;

/** The workflow statuses after which a run writes no more lines. */
const FINISHED_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);

/**
 * Options for {@link createWorkflowLogStore}.
 *
 * @example
 * ```ts
 * import { createWorkflowLogStore } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/storage';
 *
 * const store = createWorkflowLogStore(new MemoryStorage(), { maximumLinesPerRun: 100 });
 * void store;
 * ```
 */
export interface WorkflowLogStoreOptions {
  /**
   * How many lines a run keeps; past it the oldest line is evicted and counted as dropped.
   * A function is read on every write, so a host can change the cap while the engine runs; one that
   * answers `undefined` gets the default. Never more than {@link MAXIMUM_LOG_LINES_PER_RUN_LIMIT}.
   * Default {@link DEFAULT_MAXIMUM_LOG_LINES_PER_RUN}.
   */
  readonly maximumLinesPerRun?: number | (() => number | undefined);
  /**
   * How many UTF-8 bytes a whole line may take, its message plus its serialized attributes. A
   * longer message is cut and marked; attributes that do not fit in what the message leaves are
   * dropped (the line reports `truncated`). Default {@link DEFAULT_MAXIMUM_LOG_LINE_BYTES}.
   */
  readonly maximumLineBytes?: number;
  /** The clock the retention pass measures a run's last write against. Default `Date.now`. */
  readonly getNow?: () => number;
  /** Told about a write or prune that failed. The failed batch is dropped; the run is unaffected. */
  readonly onError?: (error: unknown) => void;
}

/**
 * A persisted-log sink, reader, and retention pass over one storage backend.
 *
 * @example
 * ```ts
 * import { createWorkflowLogStore } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/storage';
 *
 * const store = createWorkflowLogStore(new MemoryStorage());
 * store.sink({
 *   level: 'info',
 *   message: 'started',
 *   workflowId: 'run-1',
 *   workflowType: 'order',
 *   timestamp: 1,
 *   step: 0,
 * });
 * await store.flush();
 * console.log((await store.read('run-1')).lines.length); // 1
 * ```
 */
export interface WorkflowLogStore {
  /** Buffer one record for writing. Pass it as `EngineOptions.onLog`. Never throws. */
  readonly sink: (record: WorkflowLogRecord) => void;
  /** Resolve once every buffered line has been written (or its batch dropped and reported). */
  flush(): Promise<void>;
  /**
   * Read a run's kept lines, oldest first, after flushing the buffered tail. `step` narrows the
   * read to the lines logged before that durable step; leave it out for every line.
   */
  read(
    workflowId: string,
    options?: { readonly step?: number | undefined },
  ): Promise<WorkflowLogsResult>;
  /**
   * Remove the lines of every run that has finished (its workflow record is terminal, or gone)
   * and wrote its last line more than `olderThan` milliseconds ago, and answer how many runs
   * that was. A run that is still active (running, pending, suspended, or parked on a signal, a
   * review, or a timer) keeps its lines whatever their age. A finished run whose record still
   * exists keeps its counter, with `first` moved up to `next` and the removed lines added to
   * `dropped`, so a sequence is never reused; a run whose record is gone loses both.
   */
  prune(options: { readonly olderThan: number }): Promise<{ readonly runs: number }>;
}

/**
 * The attributes with every secret replaced, ready to be measured and stored. The redactor labels
 * the values it cannot read rather than throwing, so a failure here means the attributes are not a
 * record once redacted (or the redactor itself threw): they are dropped and `failed` marks the
 * line `truncated`, so a secret is never stored for want of being understood.
 */
function redactAttributes(attributes: Record<string, unknown> | undefined): {
  readonly attributes: Record<string, unknown> | undefined;
  readonly failed: boolean;
} {
  if (attributes === undefined) return { attributes: undefined, failed: false };
  try {
    const redacted = sanitizeDebugValueForDisplay(attributes);
    if (isRecord(redacted)) return { attributes: redacted, failed: false };
  } catch {
    // Falls through to the drop below.
  }
  return { attributes: undefined, failed: true };
}

/** One run's buffer: the lines waiting for a write, and those the in-memory bound already shed. */
interface RunBuffer {
  lines: PendingLine[];
  shed: number;
}

/**
 * Create the {@link WorkflowLogStore} over `storage`: the same backend the engine uses, because
 * the engine reads and purges through it.
 *
 * @example
 * ```ts
 * import { Engine, createWorkflowLogStore } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/storage';
 *
 * const storage = new MemoryStorage();
 * const logs = createWorkflowLogStore(storage);
 * const engine = new Engine({ storage, onLog: logs.sink, workflowLogs: logs });
 * void engine;
 * ```
 */
export function createWorkflowLogStore(
  storage: Storage,
  options: WorkflowLogStoreOptions = {},
): WorkflowLogStore {
  const getNow = options.getNow ?? Date.now;
  const maximumLineBytes =
    typeof options.maximumLineBytes === 'number' &&
    Number.isSafeInteger(options.maximumLineBytes) &&
    options.maximumLineBytes > 0
      ? options.maximumLineBytes
      : DEFAULT_MAXIMUM_LOG_LINE_BYTES;
  const buffers = new Map<string, RunBuffer>();
  let chain: Promise<void> = Promise.resolve();
  let scheduled = false;

  const maximumLines = (): number => {
    const configured = options.maximumLinesPerRun;
    const value = typeof configured === 'function' ? configured() : configured;
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? Math.min(value, MAXIMUM_LOG_LINES_PER_RUN_LIMIT)
      : DEFAULT_MAXIMUM_LOG_LINES_PER_RUN;
  };

  const report = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // A reporter must not break the log lane either.
    }
  };

  const loadCounter = async (workflowId: string): Promise<Counter> =>
    decodeCounter(await storage.get(KEYS.workflowLogCounter(workflowId))) ?? {
      next: 0,
      first: 0,
      dropped: 0,
      updatedAt: 0,
    };

  /** Write one run's buffered lines and evict what the cap no longer allows. */
  const writeRun = async (workflowId: string, buffer: RunBuffer): Promise<void> => {
    const cap = maximumLines();
    const counter = await loadCounter(workflowId);
    // What the counter record says before the final batch commits: only the evictions that
    // earlier batches already made, so a failure of the final batch leaves a count that matches
    // the lines that are really gone.
    const committed: Counter = { ...counter };
    // A batch longer than the cap would only be evicted again: keep its newest lines.
    const overflow = Math.max(0, buffer.lines.length - cap);
    const lines = buffer.lines.slice(overflow);
    counter.dropped += buffer.shed + overflow;
    const operations: BatchOperation[] = [];
    for (const line of lines) {
      operations.push({
        type: 'put',
        key: KEYS.workflowLog(workflowId, counter.next),
        value: ENCODER.encode(
          JSON.stringify({
            step: line.step,
            level: line.level,
            message: line.message,
            timestamp: line.timestamp,
            workflowType: line.workflowType,
            truncated: line.truncated,
            ...(line.attributes !== undefined && { attributes: JSON.parse(line.attributes) }),
          }),
        ),
      });
      counter.next += 1;
    }
    // The lines the cap no longer allows, oldest first. All but the last EVICTION_CHUNK go in
    // batches of their own, each moving the counter past what it removed; the rest ride the batch
    // that writes the new lines and finishes the counter, so a crash between batches loses no line
    // without counting it.
    const evictBelow = Math.max(counter.first, counter.next - cap);
    const evicted = evictBelow - counter.first;
    const leading = Math.max(0, evicted - EVICTION_CHUNK);
    for (let start = counter.first; start < counter.first + leading; start += EVICTION_CHUNK) {
      const chunk: BatchOperation[] = [];
      const stop = Math.min(counter.first + leading, start + EVICTION_CHUNK);
      for (let sequence = start; sequence < stop; sequence++) {
        chunk.push({ type: 'delete', key: KEYS.workflowLog(workflowId, sequence) });
      }
      committed.first = stop;
      committed.dropped += stop - start;
      chunk.push({
        type: 'put',
        key: KEYS.workflowLogCounter(workflowId),
        value: ENCODER.encode(JSON.stringify(committed)),
      });
      await storage.batch(chunk);
    }
    for (let sequence = counter.first + leading; sequence < evictBelow; sequence++) {
      operations.push({ type: 'delete', key: KEYS.workflowLog(workflowId, sequence) });
    }
    counter.first = evictBelow;
    counter.dropped += evicted;
    counter.updatedAt = getNow();
    operations.push({
      type: 'put',
      key: KEYS.workflowLogCounter(workflowId),
      value: ENCODER.encode(JSON.stringify(counter)),
    });
    await storage.batch(operations);
  };

  /** Write every run's buffer. Runs only inside {@link enqueue}, so two writes never overlap. */
  const drain = async (): Promise<void> => {
    scheduled = false;
    // A snapshot: a line logged while a run's write is in flight starts the next drain, so a
    // workflow that logs on every step cannot keep this one (and everything queued behind it) going.
    const pending = Array.from(buffers);
    buffers.clear();
    for (const [workflowId, buffer] of pending) {
      try {
        await writeRun(workflowId, buffer);
      } catch (error) {
        report(error);
      }
    }
  };

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = chain.then(work);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      void enqueue(drain);
    });
  };

  const flush = (): Promise<void> => enqueue(drain);

  const sink = (record: WorkflowLogRecord): void => {
    // A call a continued run repeats in front of the operation it was parked on: already stored.
    if (record.replayed === true) return;
    try {
      const message = cutMessage(record.message, maximumLineBytes);
      // The whole line is held to the cap: the attributes get what the (cut) message leaves.
      const redacted = redactAttributes(record.attributes);
      const attributes = serializeAttributes(
        redacted.attributes,
        Math.max(0, maximumLineBytes - ENCODER.encode(message.text).byteLength),
      );
      const line: PendingLine = {
        step: isNonNegativeInteger(record.step) ? record.step : null,
        level: record.level,
        message: message.text,
        timestamp: record.timestamp,
        workflowType: record.workflowType,
        ...(attributes.json !== undefined && { attributes: attributes.json }),
        truncated: message.cut || attributes.dropped || redacted.failed,
      };
      const buffer = buffers.get(record.workflowId) ?? { lines: [], shed: 0 };
      buffers.set(record.workflowId, buffer);
      buffer.lines.push(line);
      // The buffer is bounded by the cap too, so a run that logs without yielding cannot grow it.
      const cap = maximumLines();
      if (buffer.lines.length > cap) {
        buffer.shed += buffer.lines.length - cap;
        buffer.lines.splice(0, buffer.lines.length - cap);
      }
      schedule();
    } catch (error) {
      report(error);
    }
  };

  const read: WorkflowLogStore['read'] = async (workflowId, readOptions) => {
    await flush();
    const prefix = KEYS.workflowLogPrefix(workflowId);
    const lines: WorkflowLogLine[] = [];
    for await (const [key, bytes] of storage.scan(prefix)) {
      const sequence = sequenceOfKey(prefix, key);
      if (sequence === undefined) continue;
      const line = decodeLine(sequence, bytes);
      if (line === undefined) continue;
      if (readOptions?.step !== undefined && line.step !== readOptions.step) continue;
      lines.push(line);
    }
    const counter = decodeCounter(await storage.get(KEYS.workflowLogCounter(workflowId)));
    return { lines, dropped: counter?.dropped ?? 0 };
  };

  /** Whether the run behind `workflowId` is over, still going, or no longer has a record. */
  const runPhase = async (workflowId: string): Promise<'active' | 'finished' | 'missing'> => {
    const bytes = await storage.get(KEYS.workflow(workflowId));
    if (bytes === null) return 'missing';
    try {
      const state: unknown = decode(bytes);
      const status =
        typeof state === 'object' && state !== null ? Reflect.get(state, 'status') : undefined;
      return typeof status === 'string' && FINISHED_STATUSES.has(status) ? 'finished' : 'active';
    } catch {
      // A record that cannot be read is not evidence that the run is over.
      return 'active';
    }
  };

  /**
   * Commit one batch of a retention pass only if the run's counter still holds the bytes the pass
   * read, where the backend can say so: a write that landed since (another host logging for a
   * run whose finished id was started anew) changes the counter, and the pass leaves that run.
   */
  const commitUnlessWritten = async (
    workflowId: string,
    expectedCounter: Uint8Array,
    operations: BatchOperation[],
  ): Promise<boolean> => {
    if (!storage.capabilities().conditionalBatch) {
      await storage.batch(operations);
      return true;
    }
    return storageConditionalBatch(
      storage,
      [{ key: KEYS.workflowLogCounter(workflowId), expectedValue: expectedCounter }],
      operations,
    );
  };

  /**
   * Remove every line of a run in batches. A finished run's counter moves past the lines in the
   * last batch, so a crash leaves either the lines and the old counter or neither; a run with no
   * record loses its counter too. Answers false, having removed nothing more, once a batch finds
   * the counter changed.
   */
  const removeLines = async (
    workflowId: string,
    counter: Counter,
    expectedCounter: Uint8Array,
    keepCounter: boolean,
  ): Promise<boolean> => {
    const keys: string[] = [];
    for await (const [key] of storage.scan(KEYS.workflowLogPrefix(workflowId))) keys.push(key);
    const leading = Math.max(0, keys.length - EVICTION_CHUNK);
    for (let start = 0; start < leading; start += EVICTION_CHUNK) {
      const chunk = keys
        .slice(start, Math.min(leading, start + EVICTION_CHUNK))
        .map((key): BatchOperation => ({ type: 'delete', key }));
      if (!(await commitUnlessWritten(workflowId, expectedCounter, chunk))) return false;
    }
    const counterKey = KEYS.workflowLogCounter(workflowId);
    counter.first = counter.next;
    counter.dropped += keys.length;
    return commitUnlessWritten(workflowId, expectedCounter, [
      ...keys.slice(leading).map((key): BatchOperation => ({ type: 'delete', key })),
      keepCounter
        ? { type: 'put', key: counterKey, value: ENCODER.encode(JSON.stringify(counter)) }
        : { type: 'delete', key: counterKey },
    ]);
  };

  /** Remove one expired run's lines when the run is over; answers whether it did. */
  const pruneRun = async (candidate: {
    workflowId: string;
    counter: Counter;
    bytes: Uint8Array;
  }): Promise<boolean> => {
    const { workflowId, counter, bytes } = candidate;
    const phase = await runPhase(workflowId);
    if (phase === 'active') return false;
    // Nothing left to remove: a pass that already emptied this run counts nothing.
    if (phase === 'finished' && counter.first >= counter.next) return false;
    return removeLines(workflowId, counter, bytes, phase === 'finished');
  };

  const prune: WorkflowLogStore['prune'] = (pruneOptions) =>
    enqueue(async () => {
      await drain();
      const cutoff = getNow() - pruneOptions.olderThan;
      const expired: Array<{ workflowId: string; counter: Counter; bytes: Uint8Array }> = [];
      for await (const [key, bytes] of storage.scan(KEYS.workflowLogCounterPrefix())) {
        const counter = decodeCounter(bytes);
        const encoded = key.slice(KEYS.workflowLogCounterPrefix().length);
        const workflowId = tryDecodeStorageKeyComponent(encoded);
        if (counter !== undefined && workflowId !== null && counter.updatedAt < cutoff) {
          expired.push({ workflowId, counter, bytes });
        }
      }
      let runs = 0;
      for (const candidate of expired) {
        try {
          if (await pruneRun(candidate)) runs += 1;
        } catch (error) {
          report(error);
        }
      }
      return { runs };
    });

  return { sink, flush, read, prune };
}
