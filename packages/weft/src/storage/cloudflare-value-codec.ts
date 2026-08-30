/**
 * Value encoding for {@link CloudflareDurableObjectSQLiteStorage}'s `value`
 * column: the default base64-`TEXT` encoding, and the opt-in raw
 * `ArrayBuffer`/`BLOB` encoding.
 *
 * @module storage/cloudflare-value-codec
 */

import type { SqlStorageValue } from './cloudflare-durable-object-sql.ts';

/**
 * How {@link CloudflareDurableObjectSQLiteStorage} stores values in its
 * `value` column.
 *
 * - `'base64'` (the default): values are base64-encoded and stored as
 *   `TEXT`. Keeps the adapter's SQL binding contract to the TEXT/number/null
 *   value types the Durable Object SQL binding guarantees, at the cost of
 *   ~4/3 size expansion per value.
 * - `'blob'`: values are bound and stored as raw `ArrayBuffer`/`BLOB`,
 *   avoiding the base64 expansion. Requires the wider binding contract the
 *   real Durable Object SQL binding also supports (`ArrayBuffer` bind
 *   parameters and `BLOB` columns).
 *
 * @example
 * ```ts
 * import type { CloudflareValueEncoding } from '@lostgradient/weft/storage/cloudflare';
 *
 * const encoding: CloudflareValueEncoding = 'blob';
 * void encoding;
 * ```
 */
export type CloudflareValueEncoding = 'base64' | 'blob';

/**
 * A `value`-column codec: how to bind a `Uint8Array` as a SQL parameter, and
 * how to decode a column value read back out. `sqlColumnType` is the
 * declared type used only when `CREATE TABLE IF NOT EXISTS` creates a fresh
 * table — SQLite's manifest typing means an already-existing table keeps
 * whichever storage class (`TEXT` or `BLOB`) each row was actually written
 * with, regardless of the column's declared type. That is exactly what lets
 * {@link decode} on both codecs detect and reject a value written under the
 * *other* encoding: reading a `TEXT` value with the `'blob'` codec (or a
 * `BLOB` value with the `'base64'` codec) fails the type guard below and
 * throws immediately, instead of silently misinterpreting the bytes.
 *
 * This is the cross-mode contract for
 * {@link CloudflareDurableObjectSQLiteStorageOptions.valueEncoding}:
 * `valueEncoding` is a per-table storage-format decision, and every row in a
 * table must use the same encoding. Each codec accepts only values written in
 * its storage class, so cross-mode reads fail fast. Configure a distinct table
 * name when one Durable Object needs both encodings.
 */
type CloudflareValueCodec = {
  readonly sqlColumnType: 'TEXT' | 'BLOB';
  encode(value: Uint8Array): SqlStorageValue;
  decode(value: SqlStorageValue, key: string): Uint8Array;
};

// btoa/atob operate on Latin1 strings; String.fromCharCode(...bytes) with a
// large argument list overflows the call stack, so the byte→string
// conversion runs in bounded chunks. No `Buffer`, no `node:buffer`, so it
// stays portable to the Workers runtime.
const BASE64_CHUNK_SIZE = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function unexpectedValueTypeError(
  key: string,
  expectedEncoding: CloudflareValueEncoding,
  actualType: string,
): Error {
  return new Error(
    `Cloudflare Durable Object SQLite storage: key "${key}" holds a value of type ${actualType}, but ` +
      `this instance is configured for valueEncoding: '${expectedEncoding}'. valueEncoding is a ` +
      `per-table storage-format decision, and this row was written with a different valueEncoding. ` +
      `Configure every instance that accesses this table with the same valueEncoding, or use a ` +
      `different table name for a different encoding.`,
  );
}

const base64Codec: CloudflareValueCodec = {
  sqlColumnType: 'TEXT',
  encode(value) {
    return bytesToBase64(value);
  },
  decode(value, key) {
    if (typeof value !== 'string') {
      throw unexpectedValueTypeError(key, 'base64', value === null ? 'null' : typeof value);
    }
    return base64ToBytes(value);
  },
};

const blobCodec: CloudflareValueCodec = {
  sqlColumnType: 'BLOB',
  encode(value) {
    // A tight copy of exactly this value's bytes as a fresh `ArrayBuffer`,
    // not a view sharing a larger (or `SharedArrayBuffer`-backed) buffer:
    // `new Uint8Array(value)` copies `value`'s bytes into a new,
    // exactly-sized `Uint8Array` backed by an ordinary `ArrayBuffer`.
    return new Uint8Array(value).buffer;
  },
  decode(value, key) {
    if (!(value instanceof ArrayBuffer)) {
      throw unexpectedValueTypeError(key, 'blob', value === null ? 'null' : typeof value);
    }
    return new Uint8Array(value);
  },
};

/**
 * Resolve a {@link CloudflareValueEncoding} to its {@link CloudflareValueCodec}.
 *
 * `valueEncoding` is a durable, per-table format choice (see
 * {@link CloudflareValueCodec}'s docs on the cross-mode contract), so an
 * unrecognized value is rejected outright rather than silently falling back
 * to `'base64'` — the TypeScript type only guards callers who type-check;
 * a caller passing an unvalidated string (a config value, a typo'd literal
 * from plain JavaScript) must not have that typo silently pick the wrong
 * on-disk format for a table.
 */
export function resolveCloudflareValueCodec(
  encoding: CloudflareValueEncoding,
): CloudflareValueCodec {
  if (encoding === 'base64') return base64Codec;
  if (encoding === 'blob') return blobCodec;

  throw new Error(
    `Cloudflare Durable Object SQLite storage: valueEncoding must be 'base64' or 'blob', received ${JSON.stringify(encoding)}.`,
  );
}
