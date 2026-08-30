/**
 * Watermark-aware hash-chain verification for the event log.
 *
 * Split out from `event-log.ts` so the (intricate) concurrent-compaction retry
 * logic lives on its own. Depends only on the shared primitives in
 * `event-log-shared.ts` and the watermark reader in `event-log-compaction.ts`,
 * so there is no import cycle with `event-log.ts`.
 *
 * @module core/event-log-verify
 */

import type { Storage } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import { decode } from './codec.ts';
import { type EventLogWatermark, readEventLogWatermark } from './engine/event-log-compaction.ts';
import {
  EMPTY_EVENT_HEAD,
  type EventHeadRecord,
  GENESIS_HASH,
  type WorkflowLogEntry,
  hashBytes,
  isWorkflowLogEntry,
  readEventHead,
} from './event-log-shared.ts';

/**
 * Result of {@link verifyEventLog}. The `indeterminate` variant keeps
 * `valid: false` so existing `if (result.valid)` callers never get a false
 * positive, but signals that verification could not complete because the log
 * was being compacted concurrently — it is NOT a corruption report (it carries
 * no `firstInvalidSequence`).
 */
export type VerifyResult =
  | { valid: true }
  | { valid: false; firstInvalidSequence: number }
  | { valid: false; indeterminate: true; reason: 'concurrent-compaction' };

/** A single verification pass outcome (success or a located chain break). */
type VerifyPass = { outcome: 'ok' } | { outcome: 'invalid'; firstInvalidSequence: number };

/** A clean chain scan: the entry count and the final entry's sequence and hash. */
type ScannedChain = {
  outcome: 'scanned';
  entriesSeen: number;
  lastSequence: number;
  lastHash: string;
};

/**
 * Walk a workflow's event log and verify hash-chain integrity.
 *
 * When event-log compaction has truncated the early records, a
 * {@link EventLogWatermark} at `ev:{id}:watermark` marks where the surviving
 * chain begins; verification seeds its walk from the watermark's `prevHash`
 * instead of {@link GENESIS_HASH} so a compacted log does not look broken.
 *
 * A compaction can commit concurrently (before or during the scan); to avoid
 * reporting a *false* chain break, the walk re-reads the watermark on any break
 * and, only when the watermark has ACTUALLY ADVANCED past the snapshot the
 * failing pass used, restarts — up to a small bound. A stable break is genuine
 * corruption. If it never stabilizes, the result is flagged `indeterminate`.
 *
 * Corruption cases worth calling out: a watermark pointing at a first surviving
 * record that is no longer present is reported at `watermark.sequence`; a tail
 * record lost while the head still points past it is reported at the missing
 * sequence (the tail is cross-checked against `ev:{id}:head`); and a compacted
 * log whose watermark was removed (e.g. a code rollback) is reported broken at
 * the expected genesis sequence rather than silently passing — compaction is
 * one-way.
 */
export async function verifyEventLog(storage: Storage, workflowId: string): Promise<VerifyResult> {
  // A single workflow has at most one in-flight checkpoint/compaction at a time,
  // so one retry is enough to converge in practice; 5 is generous headroom before
  // declaring the log too volatile to verify deterministically.
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // Snapshot the watermark AND the head before the scan, then re-read both
    // after the pass. Both move only forward under a concurrent commit (a
    // compaction advances the watermark; an ordinary append advances the head),
    // and the scan reads entries written between them. If either moved during the
    // pass, the snapshot was torn — a failure may be a false break, so retry.
    const watermark = await readEventLogWatermark(storage, workflowId);
    const head = await readEventHead(storage, workflowId);
    const result = await verifyAgainstSnapshot(storage, workflowId, watermark, head);

    if (result.outcome === 'ok') return { valid: true };

    const watermarkAfter = await readEventLogWatermark(storage, workflowId);
    const headAfter = await readEventHead(storage, workflowId);
    const watermarkMoved = (watermarkAfter?.sequence ?? -1) > (watermark?.sequence ?? -1);
    const headMoved = headAfter.sequence !== head.sequence || headAfter.lastHash !== head.lastHash;
    if (watermarkMoved || headMoved) {
      continue;
    }
    // Stable failure across a quiescent snapshot — genuine corruption.
    return { valid: false, firstInvalidSequence: result.firstInvalidSequence };
  }
  return { valid: false, indeterminate: true, reason: 'concurrent-compaction' };
}

/** One verification pass against a fixed watermark + head snapshot. */
async function verifyAgainstSnapshot(
  storage: Storage,
  workflowId: string,
  watermark: EventLogWatermark | null,
  head: EventHeadRecord,
): Promise<VerifyPass> {
  const seed = watermark?.prevHash ?? GENESIS_HASH;
  const expectedFirstSequence = watermark?.sequence ?? 0;

  const prefix = KEYS.eventPrefix(workflowId);
  const options = watermark ? { gte: KEYS.event(workflowId, watermark.sequence) } : undefined;

  const scan = await scanChain(storage, prefix, options, seed, expectedFirstSequence);
  if (scan.outcome === 'invalid') return scan;

  // An empty scan while a watermark expects a surviving entry is corruption:
  // the first surviving record was deleted out from under the watermark.
  if (scan.entriesSeen === 0 && watermark !== null) {
    return { outcome: 'invalid', firstInvalidSequence: watermark.sequence };
  }

  // Cross-check the surviving tail against the snapshotted head. Without this a
  // lost LAST entry (head still pointing past the survivors) would leave a
  // shorter internally consistent prefix that falsely verifies.
  return verifyTailAgainstHead(scan, head);
}

/**
 * Cross-check the final scanned entry against the snapshotted head record. The
 * head records the expected last sequence and its hash; a divergence (a missing
 * tail, a tampered tail, or a head that claims entries the scan did not find) is
 * corruption.
 */
function verifyTailAgainstHead(scan: ScannedChain, head: EventHeadRecord): VerifyPass {
  if (head.sequence === EMPTY_EVENT_HEAD.sequence) {
    // No head record: only an empty scan is consistent (a fresh/empty log).
    return scan.entriesSeen === 0
      ? { outcome: 'ok' }
      : { outcome: 'invalid', firstInvalidSequence: 0 };
  }
  if (scan.entriesSeen === 0) {
    // Head claims a tail but the scan found nothing surviving.
    return { outcome: 'invalid', firstInvalidSequence: head.sequence };
  }
  if (scan.lastSequence !== head.sequence) {
    // The surviving tail does not reach the head's claimed last record: the
    // missing record is the one after the last survivor.
    return { outcome: 'invalid', firstInvalidSequence: scan.lastSequence + 1 };
  }
  if (scan.lastHash !== head.lastHash) {
    // Same last sequence but the hash diverges: the tail record itself is corrupt.
    return { outcome: 'invalid', firstInvalidSequence: scan.lastSequence };
  }
  return { outcome: 'ok' };
}

/**
 * Walk the surviving entries once, validating each chain link. Returns the first
 * failing pass, or a clean walk with the entry count and the final entry's
 * sequence and hash (for the tail-vs-head cross-check).
 */
async function scanChain(
  storage: Storage,
  prefix: string,
  options: { gte: string } | undefined,
  seed: string,
  expectedFirstSequence: number,
): Promise<{ outcome: 'invalid'; firstInvalidSequence: number } | ScannedChain> {
  let previousHash = seed;
  let entriesSeen = 0;
  let lastSequence = -1;

  for await (const [, bytes] of storage.scan(prefix, options)) {
    const decoded = decode(bytes);
    // The head and watermark records are not WorkflowLogEntries; the guard skips them.
    if (!isWorkflowLogEntry(decoded)) continue;

    const link = checkChainLink(decoded, previousHash, entriesSeen === 0, expectedFirstSequence);
    if (link.outcome === 'invalid') return link;
    entriesSeen += 1;
    lastSequence = decoded.sequence;
    previousHash = hashBytes(bytes);
  }

  return { outcome: 'scanned', entriesSeen, lastSequence, lastHash: previousHash };
}

/**
 * Validate one entry's place in the hash chain during a verify pass.
 *
 * For the first surviving entry, its `sequence` must equal the expected start.
 * A mismatch means either a compaction raced the watermark read OR the expected
 * first record is genuinely missing; both report `invalid` at the *expected*
 * sequence, and {@link verifyEventLog} distinguishes a race (retry) from
 * corruption (report) by re-reading the watermark. The `prevHash` link must also
 * match the seed. For every subsequent entry, only the `prevHash` link is checked.
 */
function checkChainLink(
  entry: WorkflowLogEntry,
  previousHash: string,
  isFirst: boolean,
  expectedFirstSequence: number,
): VerifyPass {
  if (isFirst && entry.sequence !== expectedFirstSequence) {
    return { outcome: 'invalid', firstInvalidSequence: expectedFirstSequence };
  }
  if (entry.prevHash !== previousHash) {
    return { outcome: 'invalid', firstInvalidSequence: entry.sequence };
  }
  return { outcome: 'ok' };
}
