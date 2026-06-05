import { describe, expect, it } from 'bun:test';

import { normalizeDeleteRangeOptions } from './delete-range.ts';
import {
  PG_COUNT_KEYS_BY_PREFIX,
  PG_CREATE_KEY_VALUE_TABLE,
  PG_DELETE_KEYS_BY_PREFIX,
  PG_DELETE_VALUE_BY_KEY,
  PG_SELECT_KEY_PRESENCE,
  PG_SELECT_VALUE_BY_KEY,
  PG_UPSERT_VALUE_BY_KEY,
  buildPostgresKeyRangeDelete,
  buildPostgresKeyRangeSelect,
  buildPostgresKeyValueRangeSelect,
  buildPostgresPrefixRangeParameters,
} from './postgres-key-value-queries.ts';

describe('postgres key-value query constants', () => {
  it('creates the kv table with a C collation and NOT NULL bytea value', () => {
    // The C collation is load-bearing: Postgres TEXT otherwise sorts by the
    // database locale, which reorders punctuation and silently breaks every
    // prefix-range scan. Pin the collation in the DDL so CI catches a regression
    // even though CI never reaches a real Neon endpoint.
    expect(PG_CREATE_KEY_VALUE_TABLE).toContain('COLLATE "C"');
    expect(PG_CREATE_KEY_VALUE_TABLE).toContain('PRIMARY KEY');
    expect(PG_CREATE_KEY_VALUE_TABLE).toContain('value BYTEA NOT NULL');
    expect(PG_CREATE_KEY_VALUE_TABLE).toContain('IF NOT EXISTS');
  });

  it('uses numbered placeholders, not question marks', () => {
    expect(PG_SELECT_VALUE_BY_KEY).toBe('SELECT value FROM kv WHERE key = $1');
    expect(PG_DELETE_VALUE_BY_KEY).toBe('DELETE FROM kv WHERE key = $1');
    expect(PG_SELECT_KEY_PRESENCE).toBe('SELECT 1 AS present FROM kv WHERE key = $1 LIMIT 1');
    expect(PG_COUNT_KEYS_BY_PREFIX).toBe(
      'SELECT COUNT(*) AS count FROM kv WHERE key >= $1 AND key < $2',
    );
    expect(PG_DELETE_KEYS_BY_PREFIX).toBe('DELETE FROM kv WHERE key >= $1 AND key < $2');
    // No `?` placeholders anywhere — those are SQLite-only.
    for (const sql of [
      PG_SELECT_VALUE_BY_KEY,
      PG_UPSERT_VALUE_BY_KEY,
      PG_DELETE_VALUE_BY_KEY,
      PG_SELECT_KEY_PRESENCE,
      PG_COUNT_KEYS_BY_PREFIX,
      PG_DELETE_KEYS_BY_PREFIX,
    ]) {
      expect(sql).not.toContain('?');
    }
  });

  it('upserts via ON CONFLICT (key) DO UPDATE with EXCLUDED', () => {
    expect(PG_UPSERT_VALUE_BY_KEY).toBe(
      'INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    );
  });
});

describe('buildPostgresPrefixRangeParameters', () => {
  it('returns the prefix and its exclusive range end', () => {
    expect(buildPostgresPrefixRangeParameters('wf:')).toEqual(['wf:', 'wf;']);
  });
});

describe('buildPostgresKeyValueRangeSelect', () => {
  it('selects key and value with an ascending order by default', () => {
    const { sql, parameters } = buildPostgresKeyValueRangeSelect('wf:');
    expect(sql).toBe('SELECT key, value FROM kv WHERE key >= $1 AND key < $2 ORDER BY key ASC');
    expect(parameters).toEqual(['wf:', 'wf;']);
  });

  it('emits DESC for reverse scans', () => {
    const { sql } = buildPostgresKeyValueRangeSelect('wf:', { reverse: true });
    expect(sql).toContain('ORDER BY key DESC');
  });

  it('appends each bound as a numbered placeholder in order', () => {
    const { sql, parameters } = buildPostgresKeyValueRangeSelect('wf:', {
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
    const { sql } = buildPostgresKeyValueRangeSelect('wf:');
    expect(sql).not.toContain('LIMIT');
  });
});

describe('buildPostgresKeyRangeSelect', () => {
  it('selects keys only', () => {
    const { sql, parameters } = buildPostgresKeyRangeSelect('wf:', { limit: 5 });
    expect(sql).toBe('SELECT key FROM kv WHERE key >= $1 AND key < $2 ORDER BY key ASC LIMIT $3');
    expect(parameters).toEqual(['wf:', 'wf;', 5]);
  });
});

describe('buildPostgresKeyRangeDelete', () => {
  it('deletes the whole bounded range when no limit is set', () => {
    const normalized = normalizeDeleteRangeOptions({ lt: 'ev:wf:3' });
    const { sql, parameters } = buildPostgresKeyRangeDelete('ev:wf:', normalized);
    expect(sql).toBe('DELETE FROM kv WHERE key >= $1 AND key < $2 AND key < $3');
    expect(parameters).toEqual(['ev:wf:', 'ev:wf;', 'ev:wf:3']);
  });

  it('deletes the lowest keys first via a subquery when a limit is set', () => {
    const normalized = normalizeDeleteRangeOptions({ lt: 'ev:wf:9', limit: 2 });
    const { sql, parameters } = buildPostgresKeyRangeDelete('ev:wf:', normalized);
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
    const { sql } = buildPostgresKeyRangeDelete('ev:wf:', normalized);
    expect(sql.startsWith('DELETE FROM kv WHERE key >= $1 AND key < $2')).toBe(true);
  });
});
