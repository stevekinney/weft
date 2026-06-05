/**
 * Pure value-mapping helpers shared by the Neon adapter: the minimal query-result
 * shape both the Neon serverless driver and the PGlite test backend satisfy, the
 * driver-tolerant affected-row count, and the BYTEA encode/decode pair. Split out
 * of `neon.ts` to keep that module focused on the `Storage` implementation; none
 * of these is exported from the package — `neon.ts` imports them back.
 *
 * @module storage/neon-value-mapping
 */

/**
 * Minimal structural view of a node-postgres query result. The Neon serverless
 * driver and PGlite both return an object with a `rows` array; nothing else is
 * needed here, so the adapter depends only on this shape rather than the full
 * driver types. Keeping the seam minimal is what lets the PGlite test backend
 * stand in for the real `Pool` without pulling the optional dependency's types
 * into the build.
 *
 * `rowCount` (node-postgres) and `affectedRows` (PGlite) are the driver-specific
 * names for the number of rows a write affected; both are optional here and read
 * defensively so delete counts never require materializing the deleted rows.
 */
export type NeonQueryResult = {
  rows: Array<Record<string, unknown>>;
  rowCount?: number | null;
  affectedRows?: number;
};

/**
 * Read the number of rows a write statement affected, tolerating the
 * driver-specific field name (`rowCount` on node-postgres/Neon, `affectedRows`
 * on PGlite). Falls back to `rows.length` for statements that return rows.
 */
export function affectedRowCount(result: NeonQueryResult): number {
  return result.rowCount ?? result.affectedRows ?? result.rows.length;
}

/**
 * Normalize a BYTEA value read back from Postgres into a `Uint8Array`. The Neon
 * driver returns a Node `Buffer`, which may be a view onto a larger pooled
 * `ArrayBuffer`; `new Uint8Array(buffer)` copies the bytes into a standalone
 * array so the value cannot be corrupted by buffer reuse. PGlite already returns
 * a `Uint8Array`, and copying it is harmless.
 */
export function toStorageValue(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) {
    return new Uint8Array(raw);
  }
  // Some drivers hand back an ArrayBuffer or array-like; coerce defensively.
  return new Uint8Array(raw as ArrayBufferLike);
}

/**
 * Bind a storage value for a BYTEA parameter. node-postgres serializes a Node
 * `Buffer` as BYTEA; a bare `Uint8Array` can serialize incorrectly. `Buffer` is
 * a `Uint8Array` subclass, so PGlite accepts the same bound value — keeping a
 * single bind path means the PGlite test exercises exactly what Neon runs.
 */
export function toBytea(value: Uint8Array): Buffer {
  return Buffer.from(value);
}
