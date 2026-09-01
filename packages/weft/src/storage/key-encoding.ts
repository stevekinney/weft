/**
 * Encoding helpers for colon-delimited storage key components.
 *
 * Split out of `interface.ts` so the ownership key builders can reuse them
 * without an import cycle: `interface.ts` re-exports everything here, so the
 * public surface (`@lostgradient/weft/storage/interface`) is unchanged.
 *
 * @module storage/key-encoding
 */

/**
 * Encode an untrusted string so it is safe to embed in a colon-delimited storage key.
 *
 * @example
 * ```ts
 * import { encodeStorageKeyComponent } from '@lostgradient/weft/storage/interface';
 *
 * const safe = encodeStorageKeyComponent('user:123/profile');
 * console.log(safe); // 'user%3A123%2Fprofile'
 * ```
 */
export function encodeStorageKeyComponent(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Decode a storage-key component produced by {@link encodeStorageKeyComponent}.
 * Throws when `value` is malformed percent-encoded text. Callers handling
 * untrusted input should prefer {@link tryDecodeStorageKeyComponent}.
 *
 * @throws {URIError} When `value` contains malformed percent-encoded data.
 *
 * @example
 * ```ts
 * import { encodeStorageKeyComponent, decodeStorageKeyComponent } from '@lostgradient/weft/storage/interface';
 *
 * const encoded = encodeStorageKeyComponent('user:123');
 * const decoded = decodeStorageKeyComponent(encoded);
 * console.log(decoded); // 'user:123'
 * ```
 */
export function decodeStorageKeyComponent(value: string): string {
  return decodeURIComponent(value);
}

/**
 * Decode a storage-key component produced by {@link encodeStorageKeyComponent}.
 * Returns `null` when the component is malformed instead of throwing.
 *
 * @example
 * ```ts
 * import { tryDecodeStorageKeyComponent } from '@lostgradient/weft/storage/interface';
 *
 * console.log(tryDecodeStorageKeyComponent('user%3A123')); // 'user:123'
 * console.log(tryDecodeStorageKeyComponent('%GG'));        // null
 * ```
 */
export function tryDecodeStorageKeyComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Format a millisecond timestamp as a fixed-width, zero-padded string so
 * lexicographic key order matches chronological order.
 *
 * Sixteen digits covers every millisecond timestamp JavaScript can represent as
 * a safe integer, so a shorter value can never sort after a longer one.
 *
 * @example
 * ```ts
 * import { formatSortableStorageTimestamp } from '@lostgradient/weft/storage';
 *
 * console.log(formatSortableStorageTimestamp(1700000000000)); // '0001700000000000'
 * ```
 */
export function formatSortableStorageTimestamp(timestamp: number): string {
  return String(timestamp).padStart(16, '0');
}
