/**
 * Pure codecs for the two lease ownership keys (`lease:epoch` and `lease:holder`).
 * Extracted from `lease-manager.ts` to keep that file under the `max-lines` ceiling;
 * these functions have no engine state, so they live and test cleanly on their own.
 *
 * @module core/engine/lease-codec
 */

/** The decoded `lease:holder` record. */
export type LeaseHolderRecord = {
  holderId: string;
  /** Wall-clock ms (from the engine's `getNow`) after which the lease may be stolen. */
  expiresAt: number;
  /** The ownership epoch this holder acquired. Mirrors `lease:epoch`. */
  epoch: number;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Encode an 8-byte big-endian uint64 epoch. `DataView.setBigUint64` is the
 * standard, overflow-safe encoder — preferred over a hand-rolled byte loop.
 */
export function encodeEpoch(epoch: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(epoch), false);
  return bytes;
}

/**
 * Decode an 8-byte big-endian uint64 epoch, or `null` when the stored value is
 * not a usable epoch — not exactly 8 bytes, or outside `[1, MAX_SAFE_INTEGER)`.
 * The epoch is the monotonic fencing high-water mark, so it must stay exactly
 * comparable AND have room to increment: acquisition always mints `epoch + 1`, so
 * `Number.MAX_SAFE_INTEGER` itself is rejected too — minting `2^53` would fail
 * `Number.isSafeInteger` on the next boot and brick the lease. A value at or above
 * the safe-integer ceiling (or below `1`) routes to the corruption path
 * (fail-closed at boot) rather than silently re-minting an imprecise generation.
 */
export function decodeEpoch(raw: Uint8Array): number | null {
  if (raw.byteLength !== 8) return null;
  const value = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getBigUint64(0, false);
  const numberValue = Number(value);
  return Number.isSafeInteger(numberValue) &&
    numberValue >= 1 &&
    numberValue < Number.MAX_SAFE_INTEGER
    ? numberValue
    : null;
}

/** Encode a holder record to its stored JSON bytes. */
export function encodeHolder(record: LeaseHolderRecord): Uint8Array {
  return textEncoder.encode(JSON.stringify(record));
}

/** Narrow an unknown JSON value to a plain object for field-by-field validation. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Decode a stored holder record, tolerating any malformed/foreign value as `null`. */
export function decodeHolder(raw: Uint8Array): LeaseHolderRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(raw));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { holderId, expiresAt, epoch } = parsed;
  if (
    typeof holderId !== 'string' ||
    typeof expiresAt !== 'number' ||
    // expiresAt must be a safe, non-negative integer — NOT merely finite. A
    // corrupt/foreign holder with a huge `expiresAt` (e.g. `1e20`) is finite but
    // would read as perpetually "live" (`getNow() < expiresAt`) and wedge
    // acquisition until `leaseWaitTimeout`. Treating it as malformed (→ null)
    // makes it stealable, the intended best-effort handling of a garbage holder.
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < 0 ||
    typeof epoch !== 'number' ||
    !Number.isSafeInteger(epoch) ||
    epoch < 1
  ) {
    return null;
  }
  return { holderId, expiresAt, epoch };
}
