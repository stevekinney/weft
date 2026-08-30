/**
 * Event-log compaction: truncate old hash-chained event-log records behind a
 * confirmed checkpoint to reclaim storage on long-running workflows.
 *
 * The canonical checkpoint at `KEYS.checkpoint` already holds the compacted
 * execution state, and resume rebuilds from that checkpoint alone (never from
 * event replay), so deleting records below a retention window does not affect
 * resume correctness. To keep {@link EventLog.verify} from falsely reporting a
 * broken hash chain after truncation, compaction writes an atomic **watermark**
 * record in the SAME storage batch as the deletes: `verify()` seeds its chain
 * walk from the watermark instead of genesis.
 *
 * Compaction is folded into the checkpoint commit batch (see
 * `checkpoint-io.ts`), so the deletes and the watermark commit atomically with
 * the new checkpoint — there is never a committed state where records are gone
 * but the watermark is absent.
 *
 * @module core/engine/event-log-compaction
 */

import { hashBytes } from '../../runtime/portable.ts';
import type { BatchOperation, Storage } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { decode, encode } from '../codec.ts';
import { isWorkflowLogEntry } from '../event-log-shared.ts';
import {
  mergeCheckpointReplayPayloads,
  readCheckpointReplayPayload,
  type CheckpointReplayPayload,
} from './checkpoint-replay.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Upper bound on event-log records deleted in a single compaction (one
 * checkpoint commit). A workflow that enables `retentionWindow` with a large
 * pre-existing backlog compacts incrementally across successive checkpoints —
 * the watermark advances by at most this many records per commit — rather than
 * emitting one unbounded batch that could exceed storage batch limits, stall the
 * execution path, or load the whole backlog into memory at once.
 */
export const MAX_COMPACTION_BATCH = 1_000;

// ---------------------------------------------------------------------------
// Watermark record (internal storage shape — not part of the public API)
// ---------------------------------------------------------------------------

/**
 * The compaction watermark stored at `ev:{id}:watermark`. Marks where the live
 * (post-compaction) event-log prefix begins so {@link EventLog.verify} can walk
 * the surviving chain without a genesis predecessor.
 *
 * Internal: the shape is a storage implementation detail and is intentionally
 * not exported from the package barrel.
 */
export type EventLogWatermark = {
  type: 'event-log-watermark';
  version: 1;
  /** Lowest SURVIVING sequence; all records with `sequence < this` are deleted. */
  sequence: number;
  /**
   * `hashBytes` of the raw stored bytes of the last deleted record
   * (`sequence - 1`). Equals the surviving record `sequence`'s own `prevHash`
   * field, so `verify()` validates the first surviving link from this seed.
   */
  prevHash: string;
  /**
   * Highest sequence deleted across ALL compactions (`sequence - 1`). Since the
   * watermark only advances forward, `[0, deletedThrough]` is the complete
   * deleted prefix — unambiguous across incremental batches.
   */
  deletedThrough: number;
  /**
   * Internal replay deltas folded from compacted checkpoint events. Canonical
   * checkpoints can prune consumed results only because recovery can seed replay
   * from the event log; when old events are compacted, their replay deltas move
   * here before deletion.
   */
  checkpointReplay?: CheckpointReplayPayload;
};

/**
 * Narrow an unknown decoded value to {@link EventLogWatermark}, rejecting
 * internally inconsistent or out-of-range records (negative/non-integer
 * sequences, `deletedThrough` that is not `sequence - 1`, empty `prevHash`) so a
 * corrupt or hand-tampered watermark is never treated as authoritative.
 */
export function isEventLogWatermark(value: unknown): value is EventLogWatermark {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record['type'] !== 'event-log-watermark' || record['version'] !== 1) return false;
  const prevHash = record['prevHash'];
  if (typeof prevHash !== 'string' || prevHash.length === 0) return false;
  return isConsistentWatermarkBounds(record['sequence'], record['deletedThrough']);
}

/**
 * `sequence` must be a positive safe integer and `deletedThrough` must equal
 * `sequence - 1` (the watermark only advances forward, so `[0, deletedThrough]`
 * is the complete deleted prefix).
 */
function isConsistentWatermarkBounds(sequence: unknown, deletedThrough: unknown): boolean {
  return (
    typeof sequence === 'number' &&
    Number.isSafeInteger(sequence) &&
    sequence > 0 &&
    deletedThrough === sequence - 1
  );
}

/** Read and decode the watermark for a workflow, or `null` when absent/invalid. */
export async function readEventLogWatermark(
  storage: Storage,
  workflowId: string,
): Promise<EventLogWatermark | null> {
  const bytes = await storage.get(KEYS.eventWatermark(workflowId));
  if (bytes === null) return null;
  const decoded = decode(bytes);
  return isEventLogWatermark(decoded) ? decoded : null;
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

/** Outcome of a compaction that contributed operations to a checkpoint batch. */
export type CompactionResult = {
  /** The watermark written in this batch. */
  watermark: EventLogWatermark;
  /** Raw stored bytes of the deleted records, in ascending sequence order. */
  deletedEntries: Uint8Array[];
  /** Inclusive sequence bounds of the records deleted in this batch. */
  deletedRange: { from: number; to: number };
};

/**
 * Append the delete + watermark operations for one compaction pass onto
 * `operations`, to be committed atomically alongside a checkpoint batch.
 *
 * Returns `null` (a no-op — `operations` is left untouched) when:
 * - compaction is disabled (`retentionWindow` is `null`);
 * - there is nothing new to delete (`batchFirstSurviving <= currentFloor`);
 * - the last-deleted record (`batchFirstSurviving - 1`) is missing — we cannot
 *   derive a valid `prevHash`, so we abort rather than write an unvalidatable
 *   watermark, leaving any pre-existing corruption visible to `verify()`;
 * - the delete range is non-contiguous (a gap already exists) — aborting keeps
 *   compaction from advancing the watermark past pre-existing corruption.
 *
 * @param retentionWindow  Keep at most this many most-recent records, or `null`
 *   to disable compaction (a no-op).
 * @param headSequence  The event-log head sequence AFTER the current
 *   checkpoint append (`newHead.sequence`). The retention window is measured
 *   against this, NOT `checkpoint.step`, so step/sequence need not stay coupled.
 */
export async function appendCompactionOperations(
  storage: Storage,
  workflowId: string,
  headSequence: number,
  retentionWindow: number | null,
  operations: BatchOperation[],
): Promise<CompactionResult | null> {
  if (retentionWindow === null) return null;

  // Ideal retention boundary: keep AT MOST `retentionWindow` most-recent records.
  const targetFirstSurviving = Math.max(0, headSequence - retentionWindow + 1);

  const existing = await readEventLogWatermark(storage, workflowId);
  const currentFloor = existing?.sequence ?? 0;

  // Cap this commit's work so a large backlog compacts incrementally. The
  // watermark is written at `batchFirstSurviving` (what we actually delete this
  // commit), never the uncapped target, so it never claims records still present.
  const batchFirstSurviving = Math.min(targetFirstSurviving, currentFloor + MAX_COMPACTION_BATCH);
  if (batchFirstSurviving <= currentFloor) return null;

  const collected = await collectDeleteRange(
    storage,
    workflowId,
    currentFloor,
    batchFirstSurviving,
  );
  if (collected === null) return null;

  // Seed the watermark from the last deleted record's bytes; this equals the
  // surviving record's `prevHash`, letting verify() validate the first link.
  const prevHash = hashBytes(collected.lastDeletedBytes);
  const watermark: EventLogWatermark = {
    type: 'event-log-watermark',
    version: 1,
    sequence: batchFirstSurviving,
    prevHash,
    deletedThrough: batchFirstSurviving - 1,
    ...optionalCheckpointReplay(
      mergeDeletedCheckpointReplayPayloads(existing?.checkpointReplay, collected.deletedEntries),
    ),
  };

  for (let sequence = currentFloor; sequence < batchFirstSurviving; sequence += 1) {
    operations.push({ type: 'delete', key: KEYS.event(workflowId, sequence) });
  }
  operations.push({
    type: 'put',
    key: KEYS.eventWatermark(workflowId),
    value: encode(watermark),
  });

  return {
    watermark,
    deletedEntries: collected.deletedEntries,
    deletedRange: { from: currentFloor, to: batchFirstSurviving - 1 },
  };
}

function optionalCheckpointReplay(
  checkpointReplay: CheckpointReplayPayload | undefined,
): { checkpointReplay: CheckpointReplayPayload } | {} {
  return checkpointReplay === undefined ? {} : { checkpointReplay };
}

function mergeDeletedCheckpointReplayPayloads(
  existing: CheckpointReplayPayload | undefined,
  deletedEntries: Uint8Array[],
): CheckpointReplayPayload | undefined {
  let merged = existing;
  for (const bytes of deletedEntries) {
    const decoded = decode(bytes);
    if (!isWorkflowLogEntry(decoded)) continue;
    merged = mergeCheckpointReplayPayloads(merged, readCheckpointReplayPayload(decoded.payload));
  }
  return merged;
}

type CollectedDeleteRange = {
  deletedEntries: Uint8Array[];
  /** Raw stored bytes of the highest deleted record (`batchFirstSurviving - 1`). */
  lastDeletedBytes: Uint8Array;
};

/**
 * Scan `[currentFloor, batchFirstSurviving)` and collect the raw stored bytes
 * of every record. Returns `null` when the range is non-contiguous (a gap), the
 * last record is missing, or any record is not a well-formed event-log entry —
 * each condition aborts compaction so a malformed/corrupt record is never
 * silently deleted and hidden behind an advancing watermark.
 */
async function collectDeleteRange(
  storage: Storage,
  workflowId: string,
  currentFloor: number,
  batchFirstSurviving: number,
): Promise<CollectedDeleteRange | null> {
  const deletedEntries: Uint8Array[] = [];
  let expected = currentFloor;

  const prefix = KEYS.eventPrefix(workflowId);
  const gte = KEYS.event(workflowId, currentFloor);
  const lt = KEYS.event(workflowId, batchFirstSurviving);

  for await (const [, bytes] of storage.scan(prefix, { gte, lt })) {
    const decoded = decode(bytes);
    // The scan is bounded to numeric event keys `< batchFirstSurviving`; head and
    // watermark suffixes sort after all numeric keys and lie above `lt`, so they
    // never appear here. Require the FULL event-log entry shape (not just a
    // numeric `sequence`) so a malformed record aborts rather than being deleted.
    if (!isWorkflowLogEntry(decoded) || decoded.sequence !== expected) return null;
    deletedEntries.push(bytes);
    expected += 1;
  }

  // The range must be fully contiguous up to (but excluding) batchFirstSurviving.
  if (expected !== batchFirstSurviving || deletedEntries.length === 0) return null;

  const lastDeletedBytes = deletedEntries[deletedEntries.length - 1];
  if (lastDeletedBytes === undefined) return null;
  return { deletedEntries, lastDeletedBytes };
}

/**
 * Serialize the raw stored bytes of a deleted event-log range for an
 * {@link import('../types/archive-adapter.ts').ArchiveAdapter}. Round-trips via
 * the codec: `decode()` on the result yields the original `Uint8Array[]`.
 */
export function serializeDeletedEntries(entries: Uint8Array[]): Uint8Array {
  return encode(entries);
}
