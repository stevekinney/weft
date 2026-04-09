/**
 * Hash-chained event log for durable workflow event sourcing.
 *
 * Each workflow accumulates an append-only log of `WorkflowLogEntry` records
 * stored under `ev:{workflowId}:{sequence}`. A separate head record at
 * `ev:{workflowId}:head` tracks the current sequence counter and the hash of
 * the most recently committed entry.
 *
 * Entries are chained by a `prevHash` field (wyhash of the previous entry's
 * encoded bytes), enabling tamper detection via {@link EventLog.verify}.
 *
 * Callers that hold a batch accumulator (e.g. the engine's checkpoint writer)
 * pass it to {@link EventLog.append} so that the event write is included in
 * the same atomic `storage.batch()` call as the checkpoint — the two can never
 * diverge.
 *
 * @module core/event-log
 */

import type { BatchOperation, Storage } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import { decode, encode } from './codec.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hash value used as `prevHash` for the very first entry in a log. */
const GENESIS_HASH = '0000000000000000';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single entry in the event log, as stored in the KV backend. */
export interface WorkflowLogEntry {
  /** Discriminates the entry type, e.g. `'workflow:checkpoint'`. */
  type: string;
  /** Workflow this entry belongs to. */
  workflowId: string;
  /** Zero-based monotonic sequence number. */
  sequence: number;
  /**
   * wyhash (16 hex chars) of the *encoded bytes* of the previous entry.
   * The first entry carries {@link GENESIS_HASH}.
   */
  prevHash: string;
  /** Arbitrary event payload. */
  payload: unknown;
  /** Unix timestamp (ms) at the time of the append. */
  timestamp: number;
}

/**
 * The head record stored at `ev:{workflowId}:head`.
 * Tracks both the latest sequence number and the hash of the last committed
 * entry so that subsequent appends can chain without a second storage read.
 */
export interface EventHeadRecord {
  sequence: number;
  lastHash: string;
}

/**
 * The head state for a workflow with no committed entries.
 * Used as the starting point when appending the first event.
 * Frozen to prevent accidental mutation of the shared genesis sentinel.
 */
export const EMPTY_EVENT_HEAD: Readonly<EventHeadRecord> = Object.freeze({
  sequence: -1,
  lastHash: GENESIS_HASH,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute a 16-character hex wyhash of an arbitrary byte buffer. */
function hashBytes(bytes: Uint8Array): string {
  return Bun.hash.wyhash(bytes).toString(16).padStart(16, '0');
}

/** Narrow an unknown decoded value to {@link WorkflowLogEntry}. */
function isWorkflowLogEntry(value: unknown): value is WorkflowLogEntry {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['type'] === 'string' &&
    typeof obj['workflowId'] === 'string' &&
    typeof obj['sequence'] === 'number' &&
    typeof obj['prevHash'] === 'string' &&
    typeof obj['timestamp'] === 'number' &&
    'payload' in obj
  );
}

/** Narrow an unknown decoded value to {@link EventHeadRecord}. */
function isEventHeadRecord(value: unknown): value is EventHeadRecord {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj['sequence'] === 'number' && typeof obj['lastHash'] === 'string';
}

// ---------------------------------------------------------------------------
// EventLog
// ---------------------------------------------------------------------------

/**
 * Append-only, hash-chained event log scoped to a single workflow.
 *
 * All reads and writes go through the {@link Storage} interface so the log
 * works with every backend (memory, SQLite, LMDB, Turso, IndexedDB).
 */
export class EventLog {
  readonly #storage: Storage;
  readonly #workflowId: string;

  constructor(storage: Storage, workflowId: string) {
    this.#storage = storage;
    this.#workflowId = workflowId;
  }

  // -------------------------------------------------------------------------
  // Public: appendToBatch (synchronous fast path)
  // -------------------------------------------------------------------------

  /**
   * Synchronously build the batch operations for a new event entry and push
   * them onto `batchOperations`.
   *
   * This is the fast path used by the engine: no storage reads occur.
   * The caller is responsible for supplying the current `head` (from an
   * in-memory cache) and storing the returned `newHead` back into that cache
   * after the batch is committed.
   *
   * @returns The updated head record to cache for the next call.
   */
  appendToBatch(
    event: { type: string; payload: unknown },
    batchOperations: BatchOperation[],
    head: Readonly<EventHeadRecord>,
  ): EventHeadRecord {
    const { encoded, newHead } = this.#buildEntry(event, head);

    batchOperations.push(
      { type: 'put', key: KEYS.event(this.#workflowId, newHead.sequence), value: encoded },
      { type: 'put', key: KEYS.eventHead(this.#workflowId), value: encode(newHead) },
    );

    return newHead;
  }

  // -------------------------------------------------------------------------
  // Public: append (async general-purpose path)
  // -------------------------------------------------------------------------

  /**
   * Append a new event entry to the log.
   *
   * When `batchOperations` is supplied the writes are pushed onto it instead
   * of being flushed immediately, enabling the caller to include them in the
   * same atomic `storage.batch()` call as a checkpoint write.
   *
   * @returns The new sequence number, the hash of the appended entry, and the
   *   updated head record that the caller should cache for the next append.
   */
  async append(
    event: { type: string; payload: unknown },
    batchOperations?: BatchOperation[],
  ): Promise<{ sequence: number; hash: string; newHead: EventHeadRecord }> {
    const head = await this.#readHead();
    const { encoded, hash, newHead } = this.#buildEntry(event, head);

    const entryPut: BatchOperation = {
      type: 'put',
      key: KEYS.event(this.#workflowId, newHead.sequence),
      value: encoded,
    };

    const headPut: BatchOperation = {
      type: 'put',
      key: KEYS.eventHead(this.#workflowId),
      value: encode(newHead),
    };

    if (batchOperations) {
      batchOperations.push(entryPut, headPut);
    } else {
      await this.#storage.batch([entryPut, headPut]);
    }

    return { sequence: newHead.sequence, hash, newHead };
  }

  // -------------------------------------------------------------------------
  // Public: scan
  // -------------------------------------------------------------------------

  /**
   * Iterate over all log entries in ascending sequence order.
   *
   * @param options.fromSequence  Start at this sequence number (inclusive). Defaults to 0.
   */
  async *scan(options?: { fromSequence?: number }): AsyncIterable<WorkflowLogEntry> {
    const from = options?.fromSequence ?? 0;
    const prefix = `ev:${this.#workflowId}:`;
    const gte = KEYS.event(this.#workflowId, from);

    for await (const [, bytes] of this.#storage.scan(prefix, { gte })) {
      const decoded = decode(bytes);
      if (isWorkflowLogEntry(decoded)) {
        yield decoded;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public: replay
  // -------------------------------------------------------------------------

  /**
   * Return all entries up to and including `toStep`.
   *
   * "Step" here is the `sequence` field. Entries with `sequence > toStep`
   * are excluded, so callers can reconstruct state as it was at any point.
   */
  async replay(toStep: number): Promise<WorkflowLogEntry[]> {
    const results: WorkflowLogEntry[] = [];
    for await (const entry of this.scan()) {
      if (entry.sequence > toStep) break;
      results.push(entry);
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // Public: verify
  // -------------------------------------------------------------------------

  /**
   * Walk the entire log and verify hash-chain integrity.
   *
   * Returns `{ valid: true }` when every `prevHash` matches the hash of the
   * preceding entry's encoded bytes. Returns `{ valid: false, firstInvalidSequence: N }`
   * at the first broken link.
   */
  async verify(): Promise<{ valid: boolean; firstInvalidSequence?: number }> {
    let previousHash: string = GENESIS_HASH;
    let isFirst = true;

    const prefix = `ev:${this.#workflowId}:`;

    for await (const [, bytes] of this.#storage.scan(prefix)) {
      const decoded = decode(bytes);
      // The head record is not a WorkflowLogEntry; the type guard skips it.
      if (!isWorkflowLogEntry(decoded)) continue;

      if (isFirst) {
        // First entry must carry the genesis hash.
        if (decoded.prevHash !== GENESIS_HASH) {
          return { valid: false, firstInvalidSequence: decoded.sequence };
        }
        isFirst = false;
      } else {
        // Subsequent entries: prevHash must equal the hash of the previous bytes.
        if (decoded.prevHash !== previousHash) {
          return { valid: false, firstInvalidSequence: decoded.sequence };
        }
      }

      previousHash = hashBytes(bytes);
    }

    return { valid: true };
  }

  // -------------------------------------------------------------------------
  // Public: loadHead
  // -------------------------------------------------------------------------

  /**
   * Read the current head record from storage and return it.
   *
   * This is the async counterpart to the synchronous cache lookup in the
   * engine. Call it when resuming a workflow after an engine restart so that
   * the in-memory `#eventLogHeads` cache can be re-seeded before the next
   * {@link appendToBatch} call.
   *
   * Returns `EMPTY_EVENT_HEAD` (sequence -1) when no head record exists
   * (i.e., the log is empty or this workflow has never written an event).
   */
  async loadHead(): Promise<EventHeadRecord> {
    return this.#readHead();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Construct a new log entry from an event and the current head state.
   *
   * Returns the encoded bytes, the hash of those bytes, and the updated head
   * record. Both {@link appendToBatch} and {@link append} delegate here to
   * avoid duplicating the entry-construction logic.
   */
  #buildEntry(
    event: { type: string; payload: unknown },
    head: Readonly<EventHeadRecord>,
  ): { entry: WorkflowLogEntry; encoded: Uint8Array; hash: string; newHead: EventHeadRecord } {
    const sequence = head.sequence + 1;
    const prevHash = head.lastHash;

    const entry: WorkflowLogEntry = {
      type: event.type,
      workflowId: this.#workflowId,
      sequence,
      prevHash,
      payload: event.payload,
      timestamp: Date.now(),
    };

    const encoded = encode(entry);
    const hash = hashBytes(encoded);
    const newHead: EventHeadRecord = { sequence, lastHash: hash };

    return { entry, encoded, hash, newHead };
  }

  /**
   * Read the current head record from storage.
   *
   * Returns `{ sequence: -1, lastHash: GENESIS_HASH }` when no head record
   * exists (i.e., the log is empty). This lets {@link append} compute
   * `sequence = 0` and `prevHash = GENESIS_HASH` for the first entry.
   */
  async #readHead(): Promise<EventHeadRecord> {
    const headKey = KEYS.eventHead(this.#workflowId);
    const bytes = await this.#storage.get(headKey);
    if (bytes === null) {
      return { sequence: -1, lastHash: GENESIS_HASH };
    }
    const decoded = decode(bytes);
    if (isEventHeadRecord(decoded)) {
      return decoded;
    }
    return { sequence: -1, lastHash: GENESIS_HASH };
  }
}
