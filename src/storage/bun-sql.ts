import { Database, type SQLQueryBindings } from 'bun:sqlite';

import type { BatchOperation, ScanOptions, Storage } from './interface';

export class BunSQLiteStorage implements Storage {
  #database: Database;

  constructor(path: string = ':memory:') {
    this.#database = new Database(path);

    this.#database.exec('PRAGMA journal_mode = WAL');
    this.#database.exec('PRAGMA synchronous = NORMAL');
    this.#database.exec('PRAGMA cache_size = -64000');
    this.#database.exec('PRAGMA mmap_size = 268435456');
    this.#database.exec('PRAGMA temp_store = MEMORY');
    this.#database.exec('PRAGMA wal_autocheckpoint = 10000');

    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value BLOB NOT NULL
      ) WITHOUT ROWID
    `);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const row = this.#database
      .prepare<{ value: Uint8Array }, [string]>('SELECT value FROM kv WHERE key = ?')
      .get(key);

    if (!row) return null;

    // bun:sqlite may return a Buffer; ensure we return a proper Uint8Array.
    return new Uint8Array(row.value);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.#database
      .prepare(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  async delete(key: string): Promise<void> {
    this.#database.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  async *scan(prefix: string, options: ScanOptions = {}): AsyncIterable<[string, Uint8Array]> {
    const { limit, reverse, gt, lt, gte, lte } = options;

    // Compute the exclusive upper bound for the prefix range, same as MemoryStorage.
    // When prefix is empty, use '\xff' to match all keys since all valid string keys sort before it.
    const prefixEnd =
      prefix.length > 0
        ? prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
        : '\xff';

    const conditions: string[] = ['key >= ? AND key < ?'];
    const parameters: SQLQueryBindings[] = [prefix, prefixEnd];

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

    const direction = reverse ? 'DESC' : 'ASC';
    const limitClause = limit !== undefined ? `LIMIT ${limit}` : '';

    const sql = `SELECT key, value FROM kv WHERE ${conditions.join(' AND ')} ORDER BY key ${direction} ${limitClause}`;

    const rows = this.#database.prepare(sql).all(...parameters) as {
      key: string;
      value: Uint8Array;
    }[];

    for (const row of rows) {
      yield [row.key, new Uint8Array(row.value)];
    }
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    if (operations.length === 0) return;

    const runTransaction = this.#database.transaction((entries: BatchOperation[]) => {
      const putStatement = this.#database.prepare(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      );
      const deleteStatement = this.#database.prepare('DELETE FROM kv WHERE key = ?');

      for (const entry of entries) {
        if (entry.type === 'put') {
          putStatement.run(entry.key, entry.value);
        } else {
          deleteStatement.run(entry.key);
        }
      }
    });

    runTransaction(operations);
  }

  async query<T>(sql: string, parameters?: SQLQueryBindings[]): Promise<T[]> {
    const statement = this.#database.prepare(sql);
    return statement.all(...(parameters ?? [])) as T[];
  }

  [Symbol.dispose](): void {
    this.#database.close();
  }
}
