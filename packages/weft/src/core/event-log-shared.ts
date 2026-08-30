/**
 * Shared primitives for the hash-chained event log: record shapes, the genesis
 * hash, type guards, the byte hasher, and the head reader. Split out so both
 * {@link EventLog} (`event-log.ts`) and the watermark-aware verifier
 * (`event-log-verify.ts`) can depend on them without an import cycle.
 *
 * @module core/event-log-shared
 */

import { hashBytes as portableHashBytes } from '../runtime/portable.ts';
import type { Storage } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import { decode } from './codec.ts';
import type { WorkflowVersionTuple } from './workflow-version-tuple.ts';

/** Hash value used as `prevHash` for the very first entry in a log. */
export const GENESIS_HASH = '0000000000000000';

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
  /**
   * Workflow, agent, and tool version tuple captured at the time of this
   * entry. Only present when the caller passes a `versionTuple` argument.
   * Absent for entries written by non-agent workflows or callers that opt out.
   */
  versionTuple?: WorkflowVersionTuple;
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

/** Compute a 16-character hex hash of an arbitrary byte buffer. */
export function hashBytes(bytes: Uint8Array): string {
  return portableHashBytes(bytes);
}

/** Narrow an unknown decoded value to {@link WorkflowLogEntry}. */
export function isWorkflowLogEntry(value: unknown): value is WorkflowLogEntry {
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
export function isEventHeadRecord(value: unknown): value is EventHeadRecord {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj['sequence'] === 'number' && typeof obj['lastHash'] === 'string';
}

/**
 * Read the current head record for a workflow from storage.
 *
 * Returns {@link EMPTY_EVENT_HEAD} (`sequence: -1`) when no head record exists
 * (i.e., the log is empty). This lets the first append compute `sequence = 0`
 * and `prevHash = GENESIS_HASH`.
 */
export async function readEventHead(
  storage: Storage,
  workflowId: string,
): Promise<EventHeadRecord> {
  const bytes = await storage.get(KEYS.eventHead(workflowId));
  if (bytes === null) {
    return { sequence: -1, lastHash: GENESIS_HASH };
  }
  const decoded = decode(bytes);
  if (isEventHeadRecord(decoded)) {
    return decoded;
  }
  return { sequence: -1, lastHash: GENESIS_HASH };
}
