import type { NormalizedDeleteRangeOptions } from './delete-range.ts';
import { resolvePrefixRangeEnd, type ScanOptions } from './interface.ts';
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
  readonly selectValueByKey: string;
  readonly upsertValueByKey: string;
  readonly deleteValueByKey: string;
  readonly selectKeyPresence: string;
  readonly countKeysByPrefix: string;
  readonly deleteKeysByPrefix: string;
  /** One-statement condition read for `conditionalBatch`: `key = ANY($1)`. */
  readonly selectValuesByKeys: string;
  /** One-statement multi-row upsert for `batch`: `unnest($1::text[], $2::bytea[])`. */
  readonly upsertValuesByKeys: string;
  /** One-statement delete for `batch`: `key = ANY($1)`. */
  readonly deleteValuesByKeys: string;
  keyValueRangeSelect(prefix: string, options?: ScanOptions): PostgresBuiltQuery;
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
    selectValueByKey: `SELECT value FROM ${tableReference} WHERE key = $1`,
    upsertValueByKey: `INSERT INTO ${tableReference} (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    deleteValueByKey: `DELETE FROM ${tableReference} WHERE key = $1`,
    selectKeyPresence: `SELECT 1 AS present FROM ${tableReference} WHERE key = $1 LIMIT 1`,
    countKeysByPrefix: `SELECT COUNT(*) AS count FROM ${tableReference} WHERE key >= $1 AND key < $2`,
    // No `RETURNING`: the caller reads the affected-row count from the driver's
    // result metadata, so a large prefix delete never materializes every key.
    deleteKeysByPrefix: `DELETE FROM ${tableReference} WHERE key >= $1 AND key < $2`,
    selectValuesByKeys: `SELECT key, value FROM ${tableReference} WHERE key = ANY($1)`,
    upsertValuesByKeys: `INSERT INTO ${tableReference} (key, value) SELECT * FROM unnest($1::text[], $2::bytea[]) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    deleteValuesByKeys: `DELETE FROM ${tableReference} WHERE key = ANY($1)`,
    keyValueRangeSelect(prefix, options = {}) {
      const { parameters, whereOrderLimit } = buildPostgresKeyRangeQuery(prefix, options);
      return { parameters, sql: `SELECT key, value FROM ${tableReference} ${whereOrderLimit}` };
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

/** Commit the current transaction. */
export const PG_COMMIT = 'COMMIT';

/** Roll back the current transaction. */
export const PG_ROLLBACK = 'ROLLBACK';

/** Create the configured schema if it is absent (only when a schema is set). */
export function buildPostgresCreateSchema(schema: string): string {
  assertPostgresIdentifier(schema, 'schema');
  return `CREATE SCHEMA IF NOT EXISTS "${schema}"`;
}
