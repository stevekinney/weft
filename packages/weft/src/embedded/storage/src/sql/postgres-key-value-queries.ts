import type { NormalizedDeleteRangeOptions } from '../delete-range.ts';
import { resolvePrefixRangeEnd, type ScanOptions } from '../interface.ts';
import { assertSqlIdentifier } from './sql-identifier.ts';

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
 * Every query is parameterized by a **table reference** so the adapter can point
 * at a configured `"schema"."table"` instead of the default unqualified `kv`
 * (see {@link buildPostgresKeyValueQueries}). The reference is interpolated once
 * at construction, not per query.
 *
 * @module storage/postgres-key-value-queries
 */

/** The default unqualified table reference (resolves through `search_path`). */
export const DEFAULT_POSTGRES_TABLE_REFERENCE = 'kv';

/**
 * Validate a Postgres identifier (schema or table name) against a strict
 * `[a-z_][a-z0-9_]*` pattern. Identifiers cannot be bound as `$n` parameters, so
 * they must be interpolated into the SQL text — this validation, run once at
 * construction, is the injection guard that makes interpolation safe. The strict
 * pattern excludes the `"` quote character, so no quote-doubling is required.
 *
 * A thin Postgres-flavored wrapper over the driver-neutral
 * {@link assertSqlIdentifier} (`./sql-identifier.ts`), which also backs the
 * Cloudflare Durable Object SQLite adapter's table-name validation. Kept as a
 * named export with the `'schema' | 'table'` role union and the "Postgres"
 * wording so existing call sites and error-message assertions stay unchanged.
 */
export function assertPostgresIdentifier(value: string, role: 'schema' | 'table'): void {
  assertSqlIdentifier(value, role, 'Postgres');
}

/**
 * Resolve the SQL table reference from optional schema/table names. With neither
 * set, returns the bare unqualified `kv` so existing deployments emit
 * byte-identical SQL (the default search-path-resolved table). With either set,
 * returns a fully quoted `"schema"."table"` reference; both names are validated
 * as strict identifiers first so the interpolation is injection-safe.
 */
export function resolvePostgresTableReference(options: {
  schema?: string | undefined;
  table?: string | undefined;
}): string {
  const { schema, table } = options;
  if (schema === undefined && table === undefined) {
    return DEFAULT_POSTGRES_TABLE_REFERENCE;
  }
  const tableName = table ?? DEFAULT_POSTGRES_TABLE_REFERENCE;
  assertPostgresIdentifier(tableName, 'table');
  if (schema === undefined) {
    return `"${tableName}"`;
  }
  assertPostgresIdentifier(schema, 'schema');
  return `"${schema}"."${tableName}"`;
}

/** A value bound into a Postgres key-range statement: a key bound or a row limit. */
export type PostgresKeyRangeQueryParameter = string | number;

/** A fully-built SQL statement and its bound parameters (SELECT or DELETE). */
export type PostgresBuiltQuery = {
  parameters: PostgresKeyRangeQueryParameter[];
  sql: string;
};

/**
 * The `WHERE` condition and bound parameters selecting every key under `prefix`,
 * with `$1` (and `$2` when bounded) as its placeholders. An empty prefix matches
 * every key and has no upper bound, so its condition has no `key < $2` clause:
 * a sentinel end would drop keys that sort past it, such as those starting with
 * a CJK character or an emoji.
 */
export function buildPostgresPrefixRange(prefix: string): {
  condition: string;
  parameters: string[];
} {
  const prefixEnd = resolvePrefixRangeEnd(prefix);
  return prefixEnd === undefined
    ? { condition: 'key >= $1', parameters: [prefix] }
    : { condition: 'key >= $1 AND key < $2', parameters: [prefix, prefixEnd] };
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

  const prefixRange = buildPostgresPrefixRange(prefix);
  const parameters: PostgresKeyRangeQueryParameter[] = prefixRange.parameters;
  const conditions: string[] = [prefixRange.condition];

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

/**
 * The complete set of SQL statements an adapter instance runs, all bound to one
 * `tableReference`. Built once per storage instance via
 * {@link buildPostgresKeyValueQueries}; the range builders close over the
 * reference so callers never re-pass it.
 */
export type PostgresKeyValueQueries = {
  readonly tableReference: string;
  readonly createTable: string;
  readonly selectKeyCollation: string;
  /**
   * Whether the configured table has the `updated_at` column yet: `to_regclass($1)`, one row when
   * it does. A table created before write times were recorded has no such column.
   */
  readonly selectWriteTimeColumn: string;
  /** Adds the nullable `updated_at BIGINT` column (milliseconds since the Unix epoch). */
  readonly addWriteTimeColumn: string;
  readonly selectValueByKey: string;
  /** Writes one value (`$2`) and its write time (`$3`) at a key (`$1`). */
  readonly upsertValueByKey: string;
  /** Reads one key's write time; no row means the key is absent. */
  readonly selectWriteTimeByKey: string;
  readonly deleteValueByKey: string;
  readonly selectKeyPresence: string;
  countKeysByPrefix(prefix: string): PostgresBuiltQuery;
  deleteKeysByPrefix(prefix: string): PostgresBuiltQuery;
  /** One-statement condition read for `conditionalBatch`: `key = ANY($1)`. */
  readonly selectValuesByKeys: string;
  /**
   * One-statement multi-row upsert for `batch`: `unnest($1::text[], $2::bytea[])`, every row
   * stamped with the one write time `$3`.
   */
  readonly upsertValuesByKeys: string;
  /** One-statement delete for `batch`: `key = ANY($1)`. */
  readonly deleteValuesByKeys: string;
  keyValueRangeSelect(prefix: string, options?: ScanOptions): PostgresBuiltQuery;
  /** The `SELECT key, value, updated_at` a metadata scan of `prefix` runs. */
  keyValueMetadataRangeSelect(prefix: string, options?: ScanOptions): PostgresBuiltQuery;
  keyRangeSelect(prefix: string, options?: ScanOptions): PostgresBuiltQuery;
  keyRangeDelete(prefix: string, options: NormalizedDeleteRangeOptions): PostgresBuiltQuery;
};

/**
 * Build the full query set for a `kv`-shaped table at `tableReference` (either
 * the bare unqualified `kv` or a quoted `"schema"."table"`). The reference is
 * already validated/quoted by {@link resolvePostgresTableReference}; this only
 * interpolates it into statement text.
 *
 * The collation check uses `to_regclass($1)` with the resolved reference so it
 * is scoped to the configured table — a `kv` table elsewhere on the search path
 * can never be inspected by mistake.
 */
export function buildPostgresKeyValueQueries(tableReference: string): PostgresKeyValueQueries {
  const createTable = `CREATE TABLE IF NOT EXISTS ${tableReference} (
  key TEXT COLLATE "C" PRIMARY KEY,
  value BYTEA NOT NULL
)`;

  // `to_regclass($1)` resolves the configured relation (the same one the
  // adapter's own DML hits), so a `kv` table in another schema cannot be
  // inspected by mistake — which would falsely pass a mis-collated active table
  // or falsely reject a valid one. Detects a pre-existing table whose key
  // collation would break lexicographic prefix scans.
  const selectKeyCollation = `
  SELECT COALESCE(co.collname, 'default') AS collation
  FROM pg_attribute a
  LEFT JOIN pg_collation co ON co.oid = a.attcollation
  WHERE a.attrelid = to_regclass($1) AND a.attname = 'key' AND a.attnum > 0
`;

  return {
    tableReference,
    createTable,
    selectKeyCollation,
    selectWriteTimeColumn: `SELECT 1 AS present FROM pg_attribute WHERE attrelid = to_regclass($1) AND attname = 'updated_at' AND attnum > 0 AND NOT attisdropped`,
    // `IF NOT EXISTS` as well as the column check: a table another tool altered between the two
    // still adds nothing twice.
    addWriteTimeColumn: `ALTER TABLE ${tableReference} ADD COLUMN IF NOT EXISTS updated_at BIGINT`,
    selectValueByKey: `SELECT value FROM ${tableReference} WHERE key = $1`,
    upsertValueByKey: `INSERT INTO ${tableReference} (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    selectWriteTimeByKey: `SELECT updated_at FROM ${tableReference} WHERE key = $1`,
    deleteValueByKey: `DELETE FROM ${tableReference} WHERE key = $1`,
    selectKeyPresence: `SELECT 1 AS present FROM ${tableReference} WHERE key = $1 LIMIT 1`,
    countKeysByPrefix(prefix) {
      const { condition, parameters } = buildPostgresPrefixRange(prefix);
      return {
        parameters,
        sql: `SELECT COUNT(*) AS count FROM ${tableReference} WHERE ${condition}`,
      };
    },
    // No `RETURNING`: the caller reads the affected-row count from the driver's
    // result metadata, so a large prefix delete never materializes every key.
    deleteKeysByPrefix(prefix) {
      const { condition, parameters } = buildPostgresPrefixRange(prefix);
      return { parameters, sql: `DELETE FROM ${tableReference} WHERE ${condition}` };
    },
    selectValuesByKeys: `SELECT key, value FROM ${tableReference} WHERE key = ANY($1)`,
    upsertValuesByKeys: `INSERT INTO ${tableReference} (key, value, updated_at) SELECT entry.key, entry.value, $3::bigint FROM unnest($1::text[], $2::bytea[]) AS entry(key, value) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    deleteValuesByKeys: `DELETE FROM ${tableReference} WHERE key = ANY($1)`,
    keyValueRangeSelect(prefix, options = {}) {
      const { parameters, whereOrderLimit } = buildPostgresKeyRangeQuery(prefix, options);
      return { parameters, sql: `SELECT key, value FROM ${tableReference} ${whereOrderLimit}` };
    },
    keyValueMetadataRangeSelect(prefix, options = {}) {
      const { parameters, whereOrderLimit } = buildPostgresKeyRangeQuery(prefix, options);
      return {
        parameters,
        sql: `SELECT key, value, updated_at FROM ${tableReference} ${whereOrderLimit}`,
      };
    },
    keyRangeSelect(prefix, options = {}) {
      const { parameters, whereOrderLimit } = buildPostgresKeyRangeQuery(prefix, options);
      return { parameters, sql: `SELECT key FROM ${tableReference} ${whereOrderLimit}` };
    },
    keyRangeDelete(prefix, options) {
      const { conditions, parameters } = buildPostgresKeyRangeConditions(prefix, options);
      const whereClause = conditions.join(' AND ');

      // No `RETURNING`: the caller reads the affected-row count from result
      // metadata, so a bounded delete never materializes every deleted key.
      if (options.limit === undefined) {
        return { parameters, sql: `DELETE FROM ${tableReference} WHERE ${whereClause}` };
      }

      // Postgres does not support `DELETE ... ORDER BY ... LIMIT` directly, so the
      // subquery form deletes the lowest (ascending) keys first.
      parameters.push(options.limit);
      return {
        parameters,
        sql: `DELETE FROM ${tableReference} WHERE key IN (SELECT key FROM ${tableReference} WHERE ${whereClause} ORDER BY key ASC LIMIT $${parameters.length})`,
      };
    },
  };
}

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

/**
 * Take the transaction-scoped advisory lock that serializes schema and table
 * creation (`CREATE ... IF NOT EXISTS` races between connections). Released at
 * COMMIT or ROLLBACK. The key is a fixed hash of a Weft-specific name.
 */
export const PG_ACQUIRE_SETUP_LOCK = "SELECT pg_advisory_xact_lock(hashtext('weft:storage-setup'))";

/** Commit the current transaction. */
export const PG_COMMIT = 'COMMIT';

/** Roll back the current transaction. */
export const PG_ROLLBACK = 'ROLLBACK';

/** Create the configured schema if it is absent (only when a schema is set). */
export function buildPostgresCreateSchema(schema: string): string {
  assertPostgresIdentifier(schema, 'schema');
  return `CREATE SCHEMA IF NOT EXISTS "${schema}"`;
}
