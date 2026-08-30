import { describe, expect, it } from 'bun:test';

import { normalizeDeleteRangeOptions } from './delete-range';
import {
  SQLITE_COUNT_KEYS_BY_PREFIX,
  SQLITE_CREATE_KEY_VALUE_TABLE,
  SQLITE_DELETE_KEYS_BY_PREFIX,
  SQLITE_DELETE_VALUE_BY_KEY,
  SQLITE_SELECT_KEY_PRESENCE,
  SQLITE_SELECT_VALUE_BY_KEY,
  SQLITE_UPSERT_VALUE_BY_KEY,
  buildSqliteKeyRangeDelete,
  buildSqliteKeyRangeQuery,
  buildSqliteKeyRangeSelect,
  buildSqliteKeyValueRangeSelect,
  buildSqlitePrefixRangeParameters,
} from './sqlite-key-value-queries';

describe('SQLite key-value query helpers', () => {
  it('exposes the shared key-value SQL statements used by storage adapters', () => {
    expect(SQLITE_CREATE_KEY_VALUE_TABLE).toBe(`CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL
) WITHOUT ROWID`);
    expect(SQLITE_SELECT_VALUE_BY_KEY).toBe('SELECT value FROM kv WHERE key = ?');
    expect(SQLITE_UPSERT_VALUE_BY_KEY).toBe(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    expect(SQLITE_DELETE_VALUE_BY_KEY).toBe('DELETE FROM kv WHERE key = ?');
    expect(SQLITE_SELECT_KEY_PRESENCE).toBe('SELECT 1 AS present FROM kv WHERE key = ? LIMIT 1');
    expect(SQLITE_COUNT_KEYS_BY_PREFIX).toBe(
      'SELECT COUNT(*) AS count FROM kv WHERE key >= ? AND key < ?',
    );
    expect(SQLITE_DELETE_KEYS_BY_PREFIX).toBe('DELETE FROM kv WHERE key >= ? AND key < ?');
  });

  it('builds a stable range query suffix and parameter list for every scan option', () => {
    const query = buildSqliteKeyRangeQuery('job:', {
      gt: 'job:001',
      gte: 'job:010',
      lt: 'job:900',
      lte: 'job:800',
      reverse: true,
      limit: 25,
    });

    expect(query).toEqual({
      parameters: ['job:', 'job;', 'job:001', 'job:010', 'job:900', 'job:800', 25],
      sqlSuffix:
        'WHERE key >= ? AND key < ? AND key > ? AND key >= ? AND key < ? AND key <= ? ORDER BY key DESC LIMIT ?',
    });
  });

  it('uses the full keyspace upper bound for empty-prefix range queries', () => {
    expect(buildSqlitePrefixRangeParameters('')).toEqual(['', '\xff']);
    expect(buildSqliteKeyRangeQuery('')).toEqual({
      parameters: ['', '\xff'],
      sqlSuffix: 'WHERE key >= ? AND key < ? ORDER BY key ASC',
    });
  });

  it('builds key and key-value range select statements from the same suffix', () => {
    expect(buildSqliteKeyValueRangeSelect('item:', { limit: 3 })).toEqual({
      parameters: ['item:', 'item;', 3],
      sql: 'SELECT key, value FROM kv WHERE key >= ? AND key < ? ORDER BY key ASC LIMIT ?',
    });

    expect(buildSqliteKeyRangeSelect('item:', { reverse: true })).toEqual({
      parameters: ['item:', 'item;'],
      sql: 'SELECT key FROM kv WHERE key >= ? AND key < ? ORDER BY key DESC',
    });
  });

  it('keeps the SQL shape stable when only bound parameter values change', () => {
    const first = buildSqliteKeyValueRangeSelect('page:', { limit: 1 });
    const second = buildSqliteKeyValueRangeSelect('page:', { limit: 100 });

    expect(first.sql).toBe(second.sql);
    expect(first.parameters).toEqual(['page:', 'page;', 1]);
    expect(second.parameters).toEqual(['page:', 'page;', 100]);
  });
});

describe('buildSqliteKeyRangeDelete', () => {
  it('emits a plain bounded DELETE with no ORDER BY when unlimited', () => {
    expect(
      buildSqliteKeyRangeDelete('ev:wf:', normalizeDeleteRangeOptions({ lt: 'ev:wf:03' })),
    ).toEqual({
      parameters: ['ev:wf:', 'ev:wf;', 'ev:wf:03'],
      sql: 'DELETE FROM kv WHERE key >= ? AND key < ? AND key < ?',
    });
  });

  it('threads lower-only and upper-only bounds into the WHERE clause and parameters', () => {
    expect(buildSqliteKeyRangeDelete('k:', normalizeDeleteRangeOptions({ gt: 'k:a' }))).toEqual({
      parameters: ['k:', 'k;', 'k:a'],
      sql: 'DELETE FROM kv WHERE key >= ? AND key < ? AND key > ?',
    });

    expect(buildSqliteKeyRangeDelete('k:', normalizeDeleteRangeOptions({ lte: 'k:z' }))).toEqual({
      parameters: ['k:', 'k;', 'k:z'],
      sql: 'DELETE FROM kv WHERE key >= ? AND key < ? AND key <= ?',
    });
  });

  it('handles inclusive and exclusive variants of both bounds at once', () => {
    expect(
      buildSqliteKeyRangeDelete(
        'k:',
        normalizeDeleteRangeOptions({ gt: 'k:001', gte: 'k:010', lt: 'k:900', lte: 'k:800' }),
      ),
    ).toEqual({
      parameters: ['k:', 'k;', 'k:001', 'k:010', 'k:900', 'k:800'],
      sql: 'DELETE FROM kv WHERE key >= ? AND key < ? AND key > ? AND key >= ? AND key < ? AND key <= ?',
    });
  });

  it('uses a portable ascending subquery when a limit caps the delete', () => {
    expect(
      buildSqliteKeyRangeDelete(
        'ev:wf:',
        normalizeDeleteRangeOptions({ gte: 'ev:wf:', limit: 100 }),
      ),
    ).toEqual({
      parameters: ['ev:wf:', 'ev:wf;', 'ev:wf:', 100],
      sql: 'DELETE FROM kv WHERE key IN (SELECT key FROM kv WHERE key >= ? AND key < ? AND key >= ? ORDER BY key ASC LIMIT ?)',
    });
  });

  it('uses the subquery form and emits LIMIT 0 when limit is zero', () => {
    expect(
      buildSqliteKeyRangeDelete('k:', normalizeDeleteRangeOptions({ gte: 'k:', limit: 0 })),
    ).toEqual({
      parameters: ['k:', 'k;', 'k:', 0],
      sql: 'DELETE FROM kv WHERE key IN (SELECT key FROM kv WHERE key >= ? AND key < ? AND key >= ? ORDER BY key ASC LIMIT ?)',
    });
  });

  it('keeps the SQL shape stable when only the limit value changes', () => {
    const first = buildSqliteKeyRangeDelete(
      'k:',
      normalizeDeleteRangeOptions({ gte: 'k:', limit: 1 }),
    );
    const second = buildSqliteKeyRangeDelete(
      'k:',
      normalizeDeleteRangeOptions({ gte: 'k:', limit: 999 }),
    );
    expect(first.sql).toBe(second.sql);
    expect(first.parameters).toEqual(['k:', 'k;', 'k:', 1]);
    expect(second.parameters).toEqual(['k:', 'k;', 'k:', 999]);
  });

  it('cannot be reached with empty bounds — normalize is the only door to the builder', () => {
    // The builder accepts only NormalizedDeleteRangeOptions, and the only way to
    // obtain one is normalizeDeleteRangeOptions, which rejects empty bounds. So a
    // full-prefix DELETE shape is unreachable by construction.
    expect(() => normalizeDeleteRangeOptions({})).toThrow(/at least one of gt\/gte\/lt\/lte/);
  });
});
