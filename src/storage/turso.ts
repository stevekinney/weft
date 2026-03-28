import { createClient, type Client, type InValue } from '@libsql/client';

import type { BatchOperation, ScanOptions, Storage } from './interface';

/** Configuration for connecting to a Turso/libSQL database. */
export type TursoStorageOptions = {
  /** The database URL (e.g., `libsql://your-db.turso.io`, `file:local.db`, `file::memory:`). */
  url: string;
  /** Authentication token for remote Turso databases. */
  authToken?: string;
};

const TABLE_INIT = `CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL
) WITHOUT ROWID;`;

/**
 * Storage adapter backed by Turso/libSQL for distributed SQLite deployments.
 *
 * Implements the same `Storage` interface as `BunSQLiteStorage`, but uses `@libsql/client`
 * so the database can be a remote Turso instance, an embedded replica, or a local file.
 * Switch from `BunSQLiteStorage` to `TursoStorage` by changing the connection string —
 * the rest of the application stays the same.
 */
export class TursoStorage implements Storage {
  #client: Client;
  #initialized = false;

  constructor(options: TursoStorageOptions) {
    this.#client = createClient(
      options.authToken ? { url: options.url, authToken: options.authToken } : { url: options.url },
    );
  }

  async #ensureTable(): Promise<void> {
    if (this.#initialized) return;
    await this.#client.executeMultiple(TABLE_INIT);
    this.#initialized = true;
  }

  async get(key: string): Promise<Uint8Array | null> {
    await this.#ensureTable();

    const result = await this.#client.execute({
      sql: 'SELECT value FROM kv WHERE key = ?',
      args: [key],
    });

    if (result.rows.length === 0) return null;

    const raw = result.rows[0]!['value'] as unknown;
    if (raw === null || raw === undefined) return null;
    return new Uint8Array(raw as ArrayBuffer);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    await this.#ensureTable();

    await this.#client.execute({
      sql: 'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      args: [key, value],
    });
  }

  async delete(key: string): Promise<void> {
    await this.#ensureTable();

    await this.#client.execute({
      sql: 'DELETE FROM kv WHERE key = ?',
      args: [key],
    });
  }

  async *scan(prefix: string, options: ScanOptions = {}): AsyncIterable<[string, Uint8Array]> {
    await this.#ensureTable();

    const { limit, reverse, gt, lt, gte, lte } = options;

    const prefixEnd =
      prefix.length > 0
        ? prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
        : '\xff';

    const conditions: string[] = ['key >= ? AND key < ?'];
    const parameters: InValue[] = [prefix, prefixEnd];

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

    const result = await this.#client.execute({ sql, args: parameters });

    for (const row of result.rows) {
      const key = row['key'] as string;
      const raw = row['value'] as unknown;
      const value = new Uint8Array(raw as ArrayBuffer);
      yield [key, value];
    }
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    if (operations.length === 0) return;

    await this.#ensureTable();

    const statements = operations.map((operation) => {
      if (operation.type === 'put') {
        return {
          sql: 'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          args: [operation.key, operation.value] as InValue[],
        };
      }
      return {
        sql: 'DELETE FROM kv WHERE key = ?',
        args: [operation.key] as InValue[],
      };
    });

    await this.#client.batch(statements, 'write');
  }

  async query<T>(sql: string, parameters?: unknown[]): Promise<T[]> {
    await this.#ensureTable();

    const result = await this.#client.execute({
      sql,
      args: (parameters ?? []) as InValue[],
    });

    return result.rows as unknown as T[];
  }

  [Symbol.dispose](): void {
    this.#client.close();
  }
}
