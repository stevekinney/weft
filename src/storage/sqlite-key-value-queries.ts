import type { NormalizedDeleteRangeOptions } from './delete-range';
import { resolvePrefixRangeEnd, type ScanOptions } from './interface';

export const SQLITE_CREATE_KEY_VALUE_TABLE = `CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL
) WITHOUT ROWID`;

export const SQLITE_SELECT_VALUE_BY_KEY = 'SELECT value FROM kv WHERE key = ?';

export const SQLITE_UPSERT_VALUE_BY_KEY =
  'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';

export const SQLITE_DELETE_VALUE_BY_KEY = 'DELETE FROM kv WHERE key = ?';

export const SQLITE_SELECT_KEY_PRESENCE = 'SELECT 1 AS present FROM kv WHERE key = ? LIMIT 1';

export const SQLITE_COUNT_KEYS_BY_PREFIX =
  'SELECT COUNT(*) AS count FROM kv WHERE key >= ? AND key < ?';

export const SQLITE_DELETE_KEYS_BY_PREFIX = 'DELETE FROM kv WHERE key >= ? AND key < ?';

export type SqliteKeyRangeQueryParameter = string | number;

export type SqliteKeyRangeQuery = {
  parameters: SqliteKeyRangeQueryParameter[];
  sqlSuffix: string;
};

/** A fully-built SQL statement and its bound parameters (SELECT or DELETE). */
export type SqliteBuiltQuery = {
  parameters: SqliteKeyRangeQueryParameter[];
  sql: string;
};

export function buildSqlitePrefixRangeParameters(prefix: string): [string, string] {
  return [prefix, resolvePrefixRangeEnd(prefix)];
}

/** The bound (gt/gte/lt/lte) fields shared by scan and delete range queries. */
type SqliteKeyRangeBounds = Pick<ScanOptions, 'gt' | 'gte' | 'lt' | 'lte'>;

/**
 * Assemble the prefix-range + bound WHERE conditions and their parameters,
 * without any ORDER BY or LIMIT. Single source of truth for the gt/gte/lt/lte
 * predicate logic shared by the SELECT and DELETE builders.
 */
function buildSqliteKeyRangeConditions(
  prefix: string,
  bounds: SqliteKeyRangeBounds,
): {
  conditions: string[];
  parameters: SqliteKeyRangeQueryParameter[];
} {
  const { gt, gte, lt, lte } = bounds;

  const conditions: string[] = ['key >= ? AND key < ?'];
  const parameters: SqliteKeyRangeQueryParameter[] = buildSqlitePrefixRangeParameters(prefix);

  if (gt !== undefined) {
    conditions.push('key > ?');
    parameters.push(gt);
  }
  if (gte !== undefined) {
    conditions.push('key >= ?');
    parameters.push(gte);
  }
  if (lt !== undefined) {
    conditions.push('key < ?');
    parameters.push(lt);
  }
  if (lte !== undefined) {
    conditions.push('key <= ?');
    parameters.push(lte);
  }

  return { conditions, parameters };
}

export function buildSqliteKeyRangeQuery(
  prefix: string,
  options: ScanOptions = {},
): SqliteKeyRangeQuery {
  const { limit, reverse } = options;

  const { conditions, parameters } = buildSqliteKeyRangeConditions(prefix, options);

  const direction = reverse ? 'DESC' : 'ASC';
  const limitClause = limit !== undefined ? ' LIMIT ?' : '';

  if (limit !== undefined) {
    parameters.push(limit);
  }

  return {
    parameters,
    sqlSuffix: `WHERE ${conditions.join(' AND ')} ORDER BY key ${direction}${limitClause}`,
  };
}

/**
 * Build a bounded-range `DELETE` for a `kv`-shaped table from already-validated
 * delete options.
 *
 * Without `limit`, emits a plain `DELETE FROM <table> WHERE <conditions>` — no
 * ordering, since order is meaningless when deleting the whole matched range.
 * With `limit`, emits a portable subquery form so the lowest (ascending) keys
 * are deleted first: `DELETE FROM <table> WHERE key IN (SELECT key FROM
 * <table> WHERE <conditions> ORDER BY key ASC LIMIT ?)`. The subquery avoids
 * relying on `DELETE ... ORDER BY ... LIMIT`, which requires the
 * `SQLITE_ENABLE_UPDATE_DELETE_LIMIT` compile flag and is not available on
 * libSQL/Turso.
 *
 * Requires {@link NormalizedDeleteRangeOptions}: the type guarantees at least
 * one bound is present, so this builder can never produce a whole-prefix wipe.
 *
 * `table` defaults to the unqualified `kv` so every existing caller (which all
 * use the fixed `kv` table) emits byte-identical SQL. Adapters with a
 * caller-configured table name (validated as a strict SQL identifier before it
 * reaches this builder) pass their own table reference.
 */
export function buildSqliteKeyRangeDelete(
  prefix: string,
  options: NormalizedDeleteRangeOptions,
  table: string = 'kv',
): SqliteBuiltQuery {
  const { conditions, parameters } = buildSqliteKeyRangeConditions(prefix, options);
  const whereClause = conditions.join(' AND ');

  if (options.limit === undefined) {
    return {
      parameters,
      sql: `DELETE FROM ${table} WHERE ${whereClause}`,
    };
  }

  parameters.push(options.limit);
  return {
    parameters,
    sql: `DELETE FROM ${table} WHERE key IN (SELECT key FROM ${table} WHERE ${whereClause} ORDER BY key ASC LIMIT ?)`,
  };
}

export function buildSqliteKeyValueRangeSelect(
  prefix: string,
  options: ScanOptions = {},
): SqliteBuiltQuery {
  const { parameters, sqlSuffix } = buildSqliteKeyRangeQuery(prefix, options);
  return {
    parameters,
    sql: `SELECT key, value FROM kv ${sqlSuffix}`,
  };
}

export function buildSqliteKeyRangeSelect(
  prefix: string,
  options: ScanOptions = {},
): SqliteBuiltQuery {
  const { parameters, sqlSuffix } = buildSqliteKeyRangeQuery(prefix, options);
  return {
    parameters,
    sql: `SELECT key FROM kv ${sqlSuffix}`,
  };
}
