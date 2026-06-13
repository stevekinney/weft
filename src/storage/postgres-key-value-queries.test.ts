import { describe, expect, it } from 'bun:test';

import { normalizeDeleteRangeOptions } from './delete-range.ts';
import {
  assertPostgresIdentifier,
  buildPostgresCreateSchema,
  buildPostgresKeyValueQueries,
  buildPostgresPrefixRangeParameters,
  DEFAULT_POSTGRES_TABLE_REFERENCE,
  resolvePostgresTableReference,
} from './postgres-key-value-queries.ts';

// The default unqualified query set — what every existing deployment emits.
const defaultQueries = buildPostgresKeyValueQueries(DEFAULT_POSTGRES_TABLE_REFERENCE);

describe('postgres key-value query constants (default unqualified table)', () => {
  it('creates the kv table with a C collation and NOT NULL bytea value', () => {
    // The C collation is load-bearing: Postgres TEXT otherwise sorts by the
    // database locale, which reorders punctuation and silently breaks every
    // prefix-range scan. Pin the collation in the DDL so CI catches a regression
    // even though CI never reaches a real Neon endpoint.
    expect(defaultQueries.createTable).toContain('COLLATE "C"');
    expect(defaultQueries.createTable).toContain('PRIMARY KEY');
    expect(defaultQueries.createTable).toContain('value BYTEA NOT NULL');
    expect(defaultQueries.createTable).toContain('IF NOT EXISTS');
    // Byte-identical default: the table reference is the bare unqualified `kv`,
    // not a quoted `"kv"`, so existing deployments see no SQL change.
    expect(defaultQueries.createTable).toContain('CREATE TABLE IF NOT EXISTS kv (');
  });

  it('uses numbered placeholders, not question marks, against the unqualified kv', () => {
    expect(defaultQueries.selectValueByKey).toBe('SELECT value FROM kv WHERE key = $1');
    expect(defaultQueries.deleteValueByKey).toBe('DELETE FROM kv WHERE key = $1');
    expect(defaultQueries.selectKeyPresence).toBe(
      'SELECT 1 AS present FROM kv WHERE key = $1 LIMIT 1',
    );
    expect(defaultQueries.countKeysByPrefix).toBe(
      'SELECT COUNT(*) AS count FROM kv WHERE key >= $1 AND key < $2',
    );
    expect(defaultQueries.deleteKeysByPrefix).toBe('DELETE FROM kv WHERE key >= $1 AND key < $2');
    // No `?` placeholders anywhere — those are SQLite-only.
    for (const sql of [
      defaultQueries.selectValueByKey,
      defaultQueries.upsertValueByKey,
      defaultQueries.deleteValueByKey,
      defaultQueries.selectKeyPresence,
      defaultQueries.countKeysByPrefix,
      defaultQueries.deleteKeysByPrefix,
    ]) {
      expect(sql).not.toContain('?');
    }
  });

  it('upserts via ON CONFLICT (key) DO UPDATE with EXCLUDED', () => {
    expect(defaultQueries.upsertValueByKey).toBe(
      'INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    );
  });

  it('scopes the collation introspection to the configured table via to_regclass($1)', () => {
    expect(defaultQueries.selectKeyCollation).toContain('to_regclass($1)');
  });
});

describe('batch-collapse queries (#469)', () => {
  it('reads conditions with one key = ANY($1)', () => {
    expect(defaultQueries.selectValuesByKeys).toBe('SELECT key, value FROM kv WHERE key = ANY($1)');
  });

  it('upserts puts with one unnest-driven multi-row INSERT', () => {
    expect(defaultQueries.upsertValuesByKeys).toBe(
      'INSERT INTO kv (key, value) SELECT * FROM unnest($1::text[], $2::bytea[]) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    );
  });

  it('deletes with one key = ANY($1)', () => {
    expect(defaultQueries.deleteValuesByKeys).toBe('DELETE FROM kv WHERE key = ANY($1)');
  });
});

describe('resolvePostgresTableReference (#468)', () => {
  it('returns the bare unqualified kv with neither schema nor table', () => {
    expect(resolvePostgresTableReference({})).toBe('kv');
    expect(DEFAULT_POSTGRES_TABLE_REFERENCE).toBe('kv');
  });

  it('quotes the table when only a table is configured', () => {
    expect(resolvePostgresTableReference({ table: 'workflow_state' })).toBe('"workflow_state"');
  });

  it('quotes schema and table together when a schema is configured', () => {
    expect(resolvePostgresTableReference({ schema: 'weft' })).toBe('"weft"."kv"');
    expect(resolvePostgresTableReference({ schema: 'weft', table: 'state' })).toBe(
      '"weft"."state"',
    );
  });

  it('rejects identifiers that are not strict Postgres identifiers', () => {
    expect(() => resolvePostgresTableReference({ table: 'kv; DROP TABLE kv' })).toThrow(
      /not a valid Postgres identifier/,
    );
    expect(() => resolvePostgresTableReference({ schema: 'public"; --' })).toThrow(
      /not a valid Postgres identifier/,
    );
    expect(() => resolvePostgresTableReference({ table: '1starts_with_digit' })).toThrow(
      /not a valid Postgres identifier/,
    );
  });
});

describe('buildPostgresKeyValueQueries (configured schema/table)', () => {
  it('qualifies every statement with the quoted schema.table reference', () => {
    const queries = buildPostgresKeyValueQueries('"weft"."kv"');
    expect(queries.createTable).toContain('CREATE TABLE IF NOT EXISTS "weft"."kv" (');
    expect(queries.selectValueByKey).toBe('SELECT value FROM "weft"."kv" WHERE key = $1');
    expect(queries.deleteValuesByKeys).toBe('DELETE FROM "weft"."kv" WHERE key = ANY($1)');
    expect(queries.keyValueRangeSelect('wf:').sql).toContain('FROM "weft"."kv"');
  });
});

describe('assertPostgresIdentifier', () => {
  it('accepts valid identifiers and rejects invalid ones', () => {
    expect(() => assertPostgresIdentifier('weft', 'schema')).not.toThrow();
    expect(() => assertPostgresIdentifier('kv_2', 'table')).not.toThrow();
    expect(() => assertPostgresIdentifier('_underscore', 'table')).not.toThrow();
    expect(() => assertPostgresIdentifier('has space', 'table')).toThrow(/not a valid/);
    expect(() => assertPostgresIdentifier('', 'schema')).toThrow(/not a valid/);
  });
});

describe('buildPostgresCreateSchema', () => {
  it('emits CREATE SCHEMA IF NOT EXISTS with a quoted identifier', () => {
    expect(buildPostgresCreateSchema('weft')).toBe('CREATE SCHEMA IF NOT EXISTS "weft"');
  });

  it('validates the schema identifier', () => {
    expect(() => buildPostgresCreateSchema('bad; DROP')).toThrow(/not a valid/);
  });
});

describe('buildPostgresPrefixRangeParameters', () => {
  it('returns the prefix and its exclusive range end', () => {
    expect(buildPostgresPrefixRangeParameters('wf:')).toEqual(['wf:', 'wf;']);
  });
});

describe('keyValueRangeSelect', () => {
  it('selects key and value with an ascending order by default', () => {
    const { sql, parameters } = defaultQueries.keyValueRangeSelect('wf:');
    expect(sql).toBe('SELECT key, value FROM kv WHERE key >= $1 AND key < $2 ORDER BY key ASC');
    expect(parameters).toEqual(['wf:', 'wf;']);
  });

  it('emits DESC for reverse scans', () => {
    const { sql } = defaultQueries.keyValueRangeSelect('wf:', { reverse: true });
    expect(sql).toContain('ORDER BY key DESC');
  });

  it('appends each bound as a numbered placeholder in order', () => {
    const { sql, parameters } = defaultQueries.keyValueRangeSelect('wf:', {
      gt: 'wf:a',
      gte: 'wf:b',
      lt: 'wf:y',
      lte: 'wf:z',
      limit: 10,
    });
    expect(sql).toBe(
      'SELECT key, value FROM kv WHERE key >= $1 AND key < $2 AND key > $3 AND key >= $4 AND key < $5 AND key <= $6 ORDER BY key ASC LIMIT $7',
    );
    expect(parameters).toEqual(['wf:', 'wf;', 'wf:a', 'wf:b', 'wf:y', 'wf:z', 10]);
  });

  it('omits the LIMIT clause when no limit is given', () => {
    const { sql } = defaultQueries.keyValueRangeSelect('wf:');
    expect(sql).not.toContain('LIMIT');
  });
});

describe('keyRangeSelect', () => {
  it('selects keys only', () => {
    const { sql, parameters } = defaultQueries.keyRangeSelect('wf:', { limit: 5 });
    expect(sql).toBe('SELECT key FROM kv WHERE key >= $1 AND key < $2 ORDER BY key ASC LIMIT $3');
    expect(parameters).toEqual(['wf:', 'wf;', 5]);
  });
});

describe('keyRangeDelete', () => {
  it('deletes the whole bounded range when no limit is set', () => {
    const normalized = normalizeDeleteRangeOptions({ lt: 'ev:wf:3' });
    const { sql, parameters } = defaultQueries.keyRangeDelete('ev:wf:', normalized);
    expect(sql).toBe('DELETE FROM kv WHERE key >= $1 AND key < $2 AND key < $3');
    expect(parameters).toEqual(['ev:wf:', 'ev:wf;', 'ev:wf:3']);
  });

  it('deletes the lowest keys first via a subquery when a limit is set', () => {
    const normalized = normalizeDeleteRangeOptions({ lt: 'ev:wf:9', limit: 2 });
    const { sql, parameters } = defaultQueries.keyRangeDelete('ev:wf:', normalized);
    expect(sql).toBe(
      'DELETE FROM kv WHERE key IN (SELECT key FROM kv WHERE key >= $1 AND key < $2 AND key < $3 ORDER BY key ASC LIMIT $4)',
    );
    expect(parameters).toEqual(['ev:wf:', 'ev:wf;', 'ev:wf:9', 2]);
  });

  it('always carries the prefix range, so a bounded delete can never wipe the table', () => {
    // The builder only accepts NormalizedDeleteRangeOptions, which is produced
    // exclusively by normalizeDeleteRangeOptions (it throws on an unbounded
    // request). Every emitted statement therefore starts from the prefix range.
    const normalized = normalizeDeleteRangeOptions({ gte: 'ev:wf:1' });
    const { sql } = defaultQueries.keyRangeDelete('ev:wf:', normalized);
    expect(sql.startsWith('DELETE FROM kv WHERE key >= $1 AND key < $2')).toBe(true);
  });
});
