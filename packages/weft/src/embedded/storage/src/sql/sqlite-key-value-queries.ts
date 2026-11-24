import type { NormalizedDeleteRangeOptions } from '../delete-range.ts';
import { resolvePrefixRangeEnd, type ScanOptions } from '../interface.ts';

/**
 * How long a SQLite connection waits for another connection's write lock before it gives up with
 * SQLite's busy error, in milliseconds. Both SQLite adapters set it as `PRAGMA busy_timeout`.
 *
 * Without it, a write that meets another process's lock fails at once with `database is locked`,
 * and a `conditionalBatch` that lost a compare-and-swap race throws where its caller expects
 * `false`. The bound has to outlast any one transaction another process commits, so a loser
 * waits its turn instead of failing, and stay finite, so a holder that never releases surfaces
 * as SQLite's own error instead of a hang. Five seconds is `better-sqlite3`'s default for the
 * same pragma, which keeps the two adapters' behavior the same. The adapters take no option for
 * it.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

/** Creates the `kv` table every SQLite adapter stores keys and values in. */
export const SQLITE_CREATE_KEY_VALUE_TABLE = `CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL
) WITHOUT ROWID`;

/** Reads one value by key. */
export const SQLITE_SELECT_VALUE_BY_KEY = 'SELECT value FROM kv WHERE key = ?';

/** Writes one value, replacing any value already stored at the key. */
export const SQLITE_UPSERT_VALUE_BY_KEY =
  'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';

/**
 * Names the `kv` table's columns, so an adapter that records write times can tell whether a table
 * created before it did has the `updated_at` column yet.
 */
export const SQLITE_SELECT_KEY_VALUE_COLUMNS = "SELECT name FROM pragma_table_info('kv')";

/**
 * Adds the nullable `updated_at` column (milliseconds since the Unix epoch) to a `kv` table that
 * lacks it. Rows written before it was added read back `NULL`, which means "unknown".
 */
export const SQLITE_ADD_UPDATED_AT_COLUMN = 'ALTER TABLE kv ADD COLUMN updated_at INTEGER';

/** Writes one value and its write time, replacing any value and time already stored at the key. */
export const SQLITE_UPSERT_VALUE_WITH_WRITE_TIME =
  'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at';

/** Reads one key's write time; no row means the key is absent. */
export const SQLITE_SELECT_WRITE_TIME_BY_KEY = 'SELECT updated_at FROM kv WHERE key = ?';

/** Deletes one key. */
export const SQLITE_DELETE_VALUE_BY_KEY = 'DELETE FROM kv WHERE key = ?';

/** Reads whether a key is present, without reading its value. */
export const SQLITE_SELECT_KEY_PRESENCE = 'SELECT 1 AS present FROM kv WHERE key = ? LIMIT 1';

/** A value bound into a SQLite key-range statement: a key bound or a row limit. */
export type SqliteKeyRangeQueryParameter = string | number;

/** The `WHERE … ORDER BY … LIMIT` suffix of a key-range statement, with its bound parameters. */
export type SqliteKeyRangeQuery = {
  parameters: SqliteKeyRangeQueryParameter[];
  sqlSuffix: string;
};

/** A fully-built SQL statement and its bound parameters (SELECT or DELETE). */
export type SqliteBuiltQuery = {
  parameters: SqliteKeyRangeQueryParameter[];
  sql: string;
};

/** A whole-prefix statement: only the prefix bounds are bound, and they are always strings. */
export type SqlitePrefixQuery = { parameters: string[]; sql: string };

/**
 * The `WHERE` condition and bound parameters selecting every key under `prefix`.
 * An empty prefix matches every key and has no upper bound, so its condition has
 * no `key < ?` clause: a sentinel end would drop keys that sort past it, such as
 * those starting with a CJK character or an emoji.
 */
export function buildSqlitePrefixRange(prefix: string): {
  condition: string;
  parameters: string[];
} {
  const prefixEnd = resolvePrefixRangeEnd(prefix);
  return prefixEnd === undefined
    ? { condition: 'key >= ?', parameters: [prefix] }
    : { condition: 'key >= ? AND key < ?', parameters: [prefix, prefixEnd] };
}

/** A `COUNT(*)` of every key under `prefix`, over the `kv`-shaped `table`. */
export function buildSqliteCountKeysByPrefix(
  prefix: string,
  table: string = 'kv',
): SqlitePrefixQuery {
  const { condition, parameters } = buildSqlitePrefixRange(prefix);
  return { parameters, sql: `SELECT COUNT(*) AS count FROM ${table} WHERE ${condition}` };
}

/** A `DELETE` of every key under `prefix`, over the `kv`-shaped `table`. */
export function buildSqliteDeleteKeysByPrefix(
  prefix: string,
  table: string = 'kv',
): SqlitePrefixQuery {
  const { condition, parameters } = buildSqlitePrefixRange(prefix);
  return { parameters, sql: `DELETE FROM ${table} WHERE ${condition}` };
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

  const prefixRange = buildSqlitePrefixRange(prefix);
  const conditions: string[] = [prefixRange.condition];
  const parameters: SqliteKeyRangeQueryParameter[] = prefixRange.parameters;

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

/** Build the range suffix that selects the keys under `prefix` that `options` admits, in scan order. */
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

/** Build the `SELECT key, value` that a scan of `prefix` runs. */
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

/** Build the `SELECT key, value, updated_at` that a metadata scan of `prefix` runs. */
export function buildSqliteKeyValueMetadataRangeSelect(
  prefix: string,
  options: ScanOptions = {},
): SqliteBuiltQuery {
  const { parameters, sqlSuffix } = buildSqliteKeyRangeQuery(prefix, options);
  return {
    parameters,
    sql: `SELECT key, value, updated_at FROM kv ${sqlSuffix}`,
  };
}

/** Build the `SELECT key` that a key listing of `prefix` runs. */
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
