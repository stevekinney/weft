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
import {
  EMPTY_EVENT_HEAD,
  type EventHeadRecord,
  type WorkflowLogEntry,
  hashBytes,
  isWorkflowLogEntry,
  readEventHead,
} from './event-log-shared.ts';
import { type VerifyResult, verifyEventLog } from './event-log-verify.ts';
import type { WorkflowVersionTuple } from './workflow-version-tuple.ts';

// Re-export the shared record/result types and the empty-head sentinel so that
// the canonical `from './event-log.ts'` import path stays stable for callers.
export { EMPTY_EVENT_HEAD };
export type { EventHeadRecord, VerifyResult, WorkflowLogEntry };

/**
 * Result returned from `appendToBatch()`. Carries the updated head
 * record AND the entry's wall-clock `timestamp` so post-commit
 * listeners can emit the exact value written into the durable log
 * without reaching for `Date.now()` a second time (which could
 * produce a different value under a ticking `getNow` used in tests).
 */
export type AppendToBatchResult = {
  readonly newHead: EventHeadRecord;
  readonly timestamp: number;
};

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
    versionTuple?: WorkflowVersionTuple,
  ): AppendToBatchResult {
    const { entry, encoded, newHead } = this.#buildEntry(event, head, versionTuple);

    batchOperations.push(
      { type: 'put', key: KEYS.event(this.#workflowId, newHead.sequence), value: encoded },
      { type: 'put', key: KEYS.eventHead(this.#workflowId), value: encode(newHead) },
    );

    return { newHead, timestamp: entry.timestamp };
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
    versionTuple?: WorkflowVersionTuple,
  ): Promise<{ sequence: number; hash: string; newHead: EventHeadRecord }> {
    const head = await this.#readHead();
    const { encoded, hash, newHead } = this.#buildEntry(event, head, versionTuple);

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
    const prefix = KEYS.eventPrefix(this.#workflowId);
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
   * Walk the log and verify hash-chain integrity, tolerating concurrent
   * compaction and a compaction watermark. Delegates to {@link verifyEventLog};
   * see that function for the full watermark-seeding, retry, and corruption
   * semantics.
   */
  async verify(): Promise<VerifyResult> {
    return verifyEventLog(this.#storage, this.#workflowId);
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
    versionTuple?: WorkflowVersionTuple,
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

    if (versionTuple !== undefined) {
      entry.versionTuple = versionTuple;
    }

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
    return readEventHead(this.#storage, this.#workflowId);
  }
}
