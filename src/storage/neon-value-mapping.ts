import type { BatchOperation } from './interface.ts';

/**
 * Pure value-mapping helpers shared by the Neon adapter: the minimal query-result
 * shape both the Neon serverless driver and the PGlite test backend satisfy, the
 * driver-tolerant affected-row count, the BYTEA encode/decode pair, and the
 * batch net-effect resolver. Split out of `neon.ts` to keep that module focused
 * on the `Storage` implementation; none of these is exported from the package —
 * `neon.ts` imports them back.
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

/**
 * The net effect of a batch, resolved per key so each phase collapses to one
 * statement. `puts` and `deletes` partition the affected keys with **no
 * overlap**: a key appears in whichever its *last* operation was, never both.
 */
export type BatchNetEffect = {
  /** Keys whose last operation is a put, mapped to that put's value. */
  puts: Map<string, Uint8Array>;
  /** Keys whose last operation is a delete. */
  deletes: Set<string>;
};

/**
 * Resolve a batch to its net effect per key, preserving last-write-wins —
 * exactly the semantics of executing the operations sequentially. Iterating in
 * order and keeping only the final operation per key means the resulting put-set
 * keys and delete-set keys are **disjoint** (a key is whichever its last op was).
 *
 * That disjointness is the correctness guarantee for collapsing the batch into
 * one multi-row upsert plus one bulk delete: the two statements touch
 * non-overlapping key sets, so they commute and their emission order is
 * irrelevant. Deduplicating to one entry per key also avoids the
 * `ON CONFLICT DO UPDATE cannot affect row a second time` error a naive
 * multi-row upsert would raise for a key written twice in one batch.
 */
export function resolveBatchNetEffect(operations: BatchOperation[]): BatchNetEffect {
  const puts = new Map<string, Uint8Array>();
  const deletes = new Set<string>();

  for (const operation of operations) {
    if (operation.type === 'put') {
      deletes.delete(operation.key);
      puts.set(operation.key, operation.value);
    } else {
      puts.delete(operation.key);
      deletes.add(operation.key);
    }
  }

  return { puts, deletes };
}
