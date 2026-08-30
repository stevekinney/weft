/**
 * Pure codecs for the per-workflow ownership claim keys (`wf-owner-epoch:<id>`
 * and `wf-owner-holder:<id>`) and for the store-wide `ownership-mode-marker`.
 *
 * These back the `ownership: 'workflow-lease'` mode described in
 * [ADR 0002](../../../documentation/contributing/architecture-decisions/0002-multiengine-per-workflow-ownership.md).
 * The epoch codec itself is shared with the global lease — `encodeEpoch` and
 * `decodeEpoch` are imported from `lease-codec.ts` rather than reimplemented, so
 * both fencing tokens stay byte-identical in representation.
 *
 * Only the holder record differs: the global lease holds three fields for one
 * store-wide lease, while a per-workflow claim holds four, adding `claimedAt`
 * for operator visibility and carrying `engineId` rather than `holderId`.
 *
 * Every decoder is fail-closed: any structurally invalid, foreign, or corrupt
 * value decodes to `null` rather than throwing, matching `lease-codec.ts`.
 *
 * @module core/engine/workflow-claim-codec
 */

import { decodeEpoch, encodeEpoch } from './lease-codec.ts';

export { decodeEpoch, encodeEpoch };

/** The ownership modes that fence engine work and therefore stamp the store-wide marker. */
export type FencingOwnershipMode = 'lease' | 'workflow-lease';

/** The decoded `wf-owner-holder:<workflowId>` record. */
export type WorkflowClaimHolderRecord = {
  /** Identity of the owning engine process, minted once per engine. */
  engineId: string;
  /** The claim generation this holder owns. Mirrors `wf-owner-epoch:<workflowId>`. */
  epoch: number;
  /** Engine-clock ms after which the claim becomes eligible for takeover. */
  expiresAt: number;
  /** Engine-clock ms when this epoch was first claimed. Unchanged across renewals. */
  claimedAt: number;
};

/** The decoded store-wide `ownership-mode-marker` record. */
export type OwnershipModeMarkerRecord = {
  /** The fencing mode the first fencing-mode engine stamped on this store. */
  mode: FencingOwnershipMode;
  /** Engine-clock ms when the marker was established. Diagnostics only. */
  establishedAt: number;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Narrow an unknown JSON value to a plain object for field-by-field validation. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * A timestamp field is usable only when it is a safe, non-negative integer — not
 * merely finite. A corrupt value such as `1e20` is finite but would read as
 * perpetually live and wedge takeover, so it routes to the malformed path
 * instead. This mirrors the reasoning in `lease-codec.ts`.
 */
function isUsableTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * An epoch field is usable only in `[1, MAX_SAFE_INTEGER)`. The ceiling is
 * exclusive because acquisition always mints `epoch + 1`; admitting
 * `MAX_SAFE_INTEGER` would produce an unrepresentable successor.
 */
function isUsableEpoch(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value < Number.MAX_SAFE_INTEGER
  );
}

/** Parse stored bytes as JSON, tolerating malformed input as `null`. */
function parseJsonBytes(raw: Uint8Array): unknown {
  try {
    return JSON.parse(textDecoder.decode(raw));
  } catch {
    return null;
  }
}

/** Encode a per-workflow claim holder record to its stored JSON bytes. */
export function encodeWorkflowClaimHolder(record: WorkflowClaimHolderRecord): Uint8Array {
  return textEncoder.encode(JSON.stringify(record));
}

/**
 * Decode a stored per-workflow claim holder record, tolerating any
 * malformed or foreign value as `null`.
 *
 * An empty `engineId` is rejected: it can never match a real engine's identity,
 * so admitting it would produce a holder that no engine can renew or release.
 */
export function decodeWorkflowClaimHolder(raw: Uint8Array): WorkflowClaimHolderRecord | null {
  const parsed = parseJsonBytes(raw);
  if (!isRecord(parsed)) return null;
  const { engineId, epoch, expiresAt, claimedAt } = parsed;
  if (
    typeof engineId !== 'string' ||
    engineId.length === 0 ||
    !isUsableEpoch(epoch) ||
    !isUsableTimestamp(expiresAt) ||
    !isUsableTimestamp(claimedAt)
  ) {
    return null;
  }
  return { engineId, epoch, expiresAt, claimedAt };
}

/** Encode the store-wide ownership-mode marker to its stored JSON bytes. */
export function encodeOwnershipModeMarker(record: OwnershipModeMarkerRecord): Uint8Array {
  return textEncoder.encode(JSON.stringify(record));
}

/**
 * Decode the store-wide ownership-mode marker, tolerating any malformed or
 * foreign value as `null`.
 *
 * An unrecognized `mode` decodes to `null` rather than being preserved. The
 * marker exists to make a mode mismatch detectable, and a mode this build does
 * not understand cannot be compared meaningfully; treating it as absent lets the
 * reader fail closed on its own terms instead of comparing against a string it
 * cannot interpret.
 */
export function decodeOwnershipModeMarker(raw: Uint8Array): OwnershipModeMarkerRecord | null {
  const parsed = parseJsonBytes(raw);
  if (!isRecord(parsed)) return null;
  const { mode, establishedAt } = parsed;
  if ((mode !== 'lease' && mode !== 'workflow-lease') || !isUsableTimestamp(establishedAt)) {
    return null;
  }
  return { mode, establishedAt };
}
