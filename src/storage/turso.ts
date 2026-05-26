import { createClient, type Client, type InValue } from '@libsql/client';

import {
  storageValuesEqual,
  type BatchOperation,
  type ConditionalBatchCondition,
  type ScanOptions,
  type Storage,
  type StorageCapabilities,
} from './interface';
import { assertReadOnlyQuery } from './read-only-query';
import { scopedStorage } from './scoped-storage';
import {
  SQLITE_COUNT_KEYS_BY_PREFIX,
  SQLITE_CREATE_KEY_VALUE_TABLE,
  SQLITE_DELETE_KEYS_BY_PREFIX,
  SQLITE_DELETE_VALUE_BY_KEY,
  SQLITE_SELECT_KEY_PRESENCE,
  SQLITE_SELECT_VALUE_BY_KEY,
  SQLITE_UPSERT_VALUE_BY_KEY,
  buildSqliteKeyRangeSelect,
  buildSqliteKeyValueRangeSelect,
  buildSqlitePrefixRangeParameters,
} from './sqlite-key-value-queries';

const LIBSQL_CREATE_KEY_VALUE_TABLE_STATEMENT = `${SQLITE_CREATE_KEY_VALUE_TABLE};`;

/**
 * Configuration for connecting to a Turso/libSQL database.
 *
 * @example
 * ```ts
 * import { TursoStorage, type TursoStorageOptions } from 'weft/storage/turso';
 *
 * const options: TursoStorageOptions = {
 *   url: 'file:local.db',
 * };
 * await using storage = new TursoStorage(options);
 * ```
 */
export type TursoStorageOptions = {
  /** The database URL (e.g., `libsql://your-db.turso.io`, `file:local.db`, `file::memory:`). */
  url: string;
  /** Authentication token for remote Turso databases. */
  authToken?: string;
};

/**
 * Storage adapter backed by Turso/libSQL for distributed SQLite deployments.
 *
 * Implements the same `Storage` interface as `BunSQLiteStorage`, but uses `@libsql/client`
 * so the database can be a remote Turso instance or a local file.
 * Switch from `BunSQLiteStorage` to `TursoStorage` by changing the connection string —
 * the rest of the application stays the same.
 *
 * @example
 * ```ts
 * import { TursoStorage } from 'weft/storage/turso';
 * import { Engine } from 'weft';
 *
 * await using storage = new TursoStorage({
 *   url: 'libsql://my-db.turso.io',
 * ...(process.env['TURSO_AUTH_TOKEN'] ? { authToken: process.env['TURSO_AUTH_TOKEN'] } : {}),
 * });
 * await using engine = new Engine({ storage });
 * ```
 */
export class TursoStorage implements Storage {
  #client: Client;
  #initialized = false;

  constructor(options: TursoStorageOptions) {
    this.#client = createClient(
      options.authToken ? { url: options.url, authToken: options.authToken } : { url: options.url },
    );
  }

  capabilities(): StorageCapabilities {
    // libSQL over a single client connection. Honest floor across supported
    // configs (local `file:` and remote primary) is read-your-writes per
    // connection — `session`, since a separate instance/replica may lag. Scans
    // run inside a libSQL transaction (snapshot); batch() and the range
    // deletePrefix are single transactional statements.
    return {
      readAfterWrite: 'session',
      scanConsistency: 'snapshot',
      atomicBatch: true,
      conditionalBatch: true,
      boundedRangeDelete: true,
    };
  }

  async #ensureTable(): Promise<void> {
    if (this.#initialized) return;
    await this.#client.executeMultiple(LIBSQL_CREATE_KEY_VALUE_TABLE_STATEMENT);
    this.#initialized = true;
  }

  async get(key: string): Promise<Uint8Array | null> {
    await this.#ensureTable();

    const result = await this.#client.execute({
      sql: SQLITE_SELECT_VALUE_BY_KEY,
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
      sql: SQLITE_UPSERT_VALUE_BY_KEY,
      args: [key, value],
    });
  }

  async delete(key: string): Promise<void> {
    await this.#ensureTable();

    await this.#client.execute({
      sql: SQLITE_DELETE_VALUE_BY_KEY,
      args: [key],
    });
  }

  async has(key: string): Promise<boolean> {
    await this.#ensureTable();

    const result = await this.#client.execute({
      sql: SQLITE_SELECT_KEY_PRESENCE,
      args: [key],
    });

    return result.rows.length > 0;
  }

  async deletePrefix(prefix: string): Promise<number> {
    await this.#ensureTable();

    const [rangeStart, rangeEnd] = buildSqlitePrefixRangeParameters(prefix);
    const result = await this.#client.execute({
      sql: SQLITE_DELETE_KEYS_BY_PREFIX,
      args: [rangeStart, rangeEnd],
    });

    return result.rowsAffected;
  }

  async *scan(prefix: string, options: ScanOptions = {}): AsyncIterable<[string, Uint8Array]> {
    await this.#ensureTable();

    const { parameters, sql } = buildSqliteKeyValueRangeSelect(prefix, options);
    const result = await this.#client.execute({
      sql,
      args: parameters,
    });

    for (const row of result.rows) {
      const key = row['key'] as string;
      const raw = row['value'] as unknown;
      const value = new Uint8Array(raw as ArrayBuffer);
      yield [key, value];
    }
  }

  async *keys(prefix: string, options: ScanOptions = {}): AsyncIterable<string> {
    await this.#ensureTable();

    const { parameters, sql } = buildSqliteKeyRangeSelect(prefix, options);
    const result = await this.#client.execute({
      sql,
      args: parameters,
    });

    for (const row of result.rows) {
      yield row['key'] as string;
    }
  }

  async count(prefix: string): Promise<number> {
    await this.#ensureTable();

    const [rangeStart, rangeEnd] = buildSqlitePrefixRangeParameters(prefix);
    const result = await this.#client.execute({
      sql: SQLITE_COUNT_KEYS_BY_PREFIX,
      args: [rangeStart, rangeEnd],
    });

    return Number(result.rows[0]?.['count'] ?? 0);
  }

  scoped(prefix: string): Storage {
    const scoped = scopedStorage(this, prefix);
    return scoped;
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    if (operations.length === 0) return;

    await this.#ensureTable();

    const statements = operations.map((operation) => {
      if (operation.type === 'put') {
        return {
          sql: SQLITE_UPSERT_VALUE_BY_KEY,
          args: [operation.key, operation.value] as InValue[],
        };
      }
      return {
        sql: SQLITE_DELETE_VALUE_BY_KEY,
        args: [operation.key] as InValue[],
      };
    });

    await this.#client.batch(statements, 'write');
  }

  async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    await this.#ensureTable();

    const transaction = await this.#client.transaction('write');
    try {
      await transaction.executeMultiple(LIBSQL_CREATE_KEY_VALUE_TABLE_STATEMENT);

      for (const condition of conditions) {
        const result = await transaction.execute({
          sql: SQLITE_SELECT_VALUE_BY_KEY,
          args: [condition.key],
        });

        const raw = result.rows[0]?.['value'] as unknown;
        const currentValue =
          raw === null || raw === undefined ? null : new Uint8Array(raw as ArrayBuffer);
        if (!storageValuesEqual(currentValue, condition.expectedValue)) {
          await transaction.rollback();
          return false;
        }
      }

      for (const operation of operations) {
        if (operation.type === 'put') {
          await transaction.execute({
            sql: SQLITE_UPSERT_VALUE_BY_KEY,
            args: [operation.key, operation.value],
          });
        } else {
          await transaction.execute({
            sql: SQLITE_DELETE_VALUE_BY_KEY,
            args: [operation.key],
          });
        }
      }

      await transaction.commit();
      return true;
    } catch (error) {
      try {
        await transaction.rollback();
      } catch {
        // Best-effort rollback; preserve the original failure.
      }
      throw error;
    }
  }

  async query<T>(sql: string, parameters?: unknown[]): Promise<T[]> {
    await this.#ensureTable();
    assertReadOnlyQuery(sql);

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
