import type { NormalizedDeleteRangeOptions } from './delete-range.ts';
import { resolvePrefixRangeEnd, type ScanOptions } from './interface.ts';

/**
 * The Postgres counterpart of `sqlite-key-value-queries.ts`. The schema is the
 * same single `kv(key, value)` table, but two Postgres specifics differ from the
 * SQLite builders and force a separate module:
 *
 * - **Numbered placeholders.** Postgres binds parameters as `$1`, `$2`, … in
 *   statement order, not the positional `?` SQLite uses. A builder that appends
 *   bounds dynamically must therefore track the next placeholder index.
 * - **`COLLATE "C"` on the key.** Postgres `TEXT` sorts by the database locale,
 *   which reorders punctuation and would silently corrupt every prefix-range
 *   scan and `ORDER BY key` the engine relies on. Pinning the primary-key column
 *   to the `C` collation restores byte-wise (codepoint) ordering, matching
 *   SQLite's default `BINARY` collation and the engine's key-layout assumptions.
 *
 * @module storage/postgres-key-value-queries
 */

export const PG_CREATE_KEY_VALUE_TABLE = `CREATE TABLE IF NOT EXISTS kv (
  key TEXT COLLATE "C" PRIMARY KEY,
  value BYTEA NOT NULL
)`;

/**
 * Introspect the collation of the `key` column on the `kv` table the adapter's
 * own unqualified queries resolve to. Returns one row with a `collation` field:
 * the named collation (`C` for a correctly-created table) or `default` when the
 * column inherits the database default collation. Returns zero rows when no `kv`
 * table is visible on the search path.
 *
 * `to_regclass('kv')` resolves the same search-path-visible relation that
 * unqualified DDL/DML hits, so a `kv` table in another schema cannot be inspected
 * by mistake (which would falsely pass a mis-collated active table or falsely
 * reject a valid one). Detects a pre-existing `kv` whose key collation would break
 * lexicographic prefix scans — a `CREATE TABLE IF NOT EXISTS` would otherwise
 * silently adopt it.
 */
export const PG_SELECT_KEY_COLLATION = `
  SELECT COALESCE(co.collname, 'default') AS collation
  FROM pg_attribute a
  LEFT JOIN pg_collation co ON co.oid = a.attcollation
  WHERE a.attrelid = to_regclass('kv') AND a.attname = 'key' AND a.attnum > 0
`;

/** Begin a transaction at SERIALIZABLE isolation (conditionalBatch's CAS path). */
export const PG_BEGIN_SERIALIZABLE = 'BEGIN ISOLATION LEVEL SERIALIZABLE';

/** Begin a transaction at READ COMMITTED isolation (the atomic batch() path). */
export const PG_BEGIN_READ_COMMITTED = 'BEGIN ISOLATION LEVEL READ COMMITTED';

/**
 * Begin a READ ONLY transaction for the `query()` passthrough. Postgres enforces
 * this at the database level — a writing statement (including a data-modifying
 * CTE that a textual SELECT check would miss) errors instead of mutating.
 */
export const PG_BEGIN_READ_ONLY = 'BEGIN READ ONLY';

/** Commit the current transaction. */
export const PG_COMMIT = 'COMMIT';

/** Roll back the current transaction. */
export const PG_ROLLBACK = 'ROLLBACK';

export const PG_SELECT_VALUE_BY_KEY = 'SELECT value FROM kv WHERE key = $1';

export const PG_UPSERT_VALUE_BY_KEY =
  'INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value';

export const PG_DELETE_VALUE_BY_KEY = 'DELETE FROM kv WHERE key = $1';

export const PG_SELECT_KEY_PRESENCE = 'SELECT 1 AS present FROM kv WHERE key = $1 LIMIT 1';

export const PG_COUNT_KEYS_BY_PREFIX =
  'SELECT COUNT(*) AS count FROM kv WHERE key >= $1 AND key < $2';

// No `RETURNING` clause: the caller reads the affected-row count from the
// driver's result metadata (`rowCount`/`affectedRows`), so a large prefix delete
// never materializes every deleted key over the wire.
export const PG_DELETE_KEYS_BY_PREFIX = 'DELETE FROM kv WHERE key >= $1 AND key < $2';

export type PostgresKeyRangeQueryParameter = string | number;

/** A fully-built SQL statement and its bound parameters (SELECT or DELETE). */
export type PostgresBuiltQuery = {
  parameters: PostgresKeyRangeQueryParameter[];
  sql: string;
};

export function buildPostgresPrefixRangeParameters(prefix: string): [string, string] {
  return [prefix, resolvePrefixRangeEnd(prefix)];
}

/** The bound (gt/gte/lt/lte) fields shared by scan and delete range queries. */
type PostgresKeyRangeBounds = Pick<ScanOptions, 'gt' | 'gte' | 'lt' | 'lte'>;

/**
 * Assemble the prefix-range + bound WHERE conditions and their parameters, using
 * `$n` numbered placeholders. Single source of truth for the gt/gte/lt/lte
 * predicate logic shared by the SELECT and DELETE builders. The prefix range is
 * always the first condition, so every statement built from this is bounded.
 */
function buildPostgresKeyRangeConditions(
  prefix: string,
  bounds: PostgresKeyRangeBounds,
): {
  conditions: string[];
  parameters: PostgresKeyRangeQueryParameter[];
} {
  const { gt, gte, lt, lte } = bounds;

  const parameters: PostgresKeyRangeQueryParameter[] = buildPostgresPrefixRangeParameters(prefix);
  const conditions: string[] = ['key >= $1 AND key < $2'];

  if (gt !== undefined) {
    parameters.push(gt);
    conditions.push(`key > $${parameters.length}`);
  }
  if (gte !== undefined) {
    parameters.push(gte);
    conditions.push(`key >= $${parameters.length}`);
  }
  if (lt !== undefined) {
    parameters.push(lt);
    conditions.push(`key < $${parameters.length}`);
  }
  if (lte !== undefined) {
    parameters.push(lte);
    conditions.push(`key <= $${parameters.length}`);
  }

  return { conditions, parameters };
}

type PostgresKeyRangeQuery = {
  parameters: PostgresKeyRangeQueryParameter[];
  whereOrderLimit: string;
};

function buildPostgresKeyRangeQuery(
  prefix: string,
  options: ScanOptions = {},
): PostgresKeyRangeQuery {
  const { limit, reverse } = options;

  const { conditions, parameters } = buildPostgresKeyRangeConditions(prefix, options);

  const direction = reverse ? 'DESC' : 'ASC';
  let limitClause = '';
  if (limit !== undefined) {
    parameters.push(limit);
    limitClause = ` LIMIT $${parameters.length}`;
  }

  return {
    parameters,
    whereOrderLimit: `WHERE ${conditions.join(' AND ')} ORDER BY key ${direction}${limitClause}`,
  };
}

export function buildPostgresKeyValueRangeSelect(
  prefix: string,
  options: ScanOptions = {},
): PostgresBuiltQuery {
  const { parameters, whereOrderLimit } = buildPostgresKeyRangeQuery(prefix, options);
  return { parameters, sql: `SELECT key, value FROM kv ${whereOrderLimit}` };
}

export function buildPostgresKeyRangeSelect(
  prefix: string,
  options: ScanOptions = {},
): PostgresBuiltQuery {
  const { parameters, whereOrderLimit } = buildPostgresKeyRangeQuery(prefix, options);
  return { parameters, sql: `SELECT key FROM kv ${whereOrderLimit}` };
}

/**
 * Build a bounded-range `DELETE` for the `kv` table from already-validated
 * delete options.
 *
 * Without `limit`, emits `DELETE FROM kv WHERE <conditions>` — no ordering, since
 * order is meaningless when deleting the whole matched range. With `limit`, emits
 * a subquery form so the lowest (ascending) keys are deleted first:
 * `DELETE FROM kv WHERE key IN (SELECT key FROM kv WHERE <conditions> ORDER BY key
 * ASC LIMIT $n)`. Postgres does not support `DELETE ... ORDER BY ... LIMIT`
 * directly, so the subquery is the portable form.
 *
 * Requires {@link NormalizedDeleteRangeOptions}: the type guarantees at least one
 * bound is present and the prefix range is always the leading condition, so this
 * builder can never produce a whole-table wipe.
 */
export function buildPostgresKeyRangeDelete(
  prefix: string,
  options: NormalizedDeleteRangeOptions,
): PostgresBuiltQuery {
  const { conditions, parameters } = buildPostgresKeyRangeConditions(prefix, options);
  const whereClause = conditions.join(' AND ');

  // No `RETURNING`: the caller reads the affected-row count from result metadata,
  // so a bounded delete never materializes every deleted key — see the note on
  // PG_DELETE_KEYS_BY_PREFIX.
  if (options.limit === undefined) {
    return { parameters, sql: `DELETE FROM kv WHERE ${whereClause}` };
  }

  parameters.push(options.limit);
  return {
    parameters,
    sql: `DELETE FROM kv WHERE key IN (SELECT key FROM kv WHERE ${whereClause} ORDER BY key ASC LIMIT $${parameters.length})`,
  };
}
