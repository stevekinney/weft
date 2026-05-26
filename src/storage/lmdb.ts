import * as lmdb from 'lmdb';

import {
  matchesScanOptions,
  resolvePrefixRangeEnd,
  storageValuesEqual,
  type BatchOperation,
  type ConditionalBatchCondition,
  type ScanOptions,
  type Storage,
  type StorageCapabilities,
} from './interface';
import { scopedStorage } from './scoped-storage';

/**
 * LMDB-backed storage adapter. Reads hit lmdb-js's synchronous memory-mapped
 * path internally, but the Storage interface presents them as Promises and
 * copies the bytes into a fresh Uint8Array on each call. Writes use lmdb-js's
 * async batching: individual `put`/`remove` calls return promises that resolve
 * once the next batched transaction commits to disk. The adapter resets
 * lmdb-js's cached read transaction after every write so subsequent reads
 * observe just-written data.
 *
 * @example
 * ```ts
 * import { LMDBStorage } from 'weft/storage/lmdb';
 * import { workflow, Engine } from 'weft';
 *
 * await using storage = new LMDBStorage('./weft-data');
 * await using engine = new Engine({ storage });
 * engine.register(workflow({ name: 'ping' }).execute(async function* () { return 'pong'; }));
 * ```
 */
export class LMDBStorage implements Storage {
  #database: lmdb.RootDatabase<Buffer, string>;
  #isClosed = false;
  #closePromise: Promise<void> | null = null;

  constructor(path: string) {
    this.#database = lmdb.open<Buffer, string>({
      path,
      encoding: 'binary',
    });
  }

  #assertOpen(): void {
    if (this.#isClosed) {
      throw new Error('LMDBStorage is closed');
    }
  }

  capabilities(): StorageCapabilities {
    // LMDB MVCC, single writer, memory-mapped: a committed write is visible to
    // later reads (linearizable); read transactions are point-in-time snapshots;
    // batch() and the range deletePrefix run inside one write transaction.
    return {
      readAfterWrite: 'linearizable',
      scanConsistency: 'snapshot',
      atomicBatch: true,
      conditionalBatch: true,
      boundedRangeDelete: true,
    };
  }

  async get(key: string): Promise<Uint8Array | null> {
    this.#assertOpen();
    const value = this.#database.get(key);
    if (value === undefined) return null;
    return new Uint8Array(value);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.#assertOpen();
    await this.#database.put(key, Buffer.from(value));
  }

  async delete(key: string): Promise<void> {
    this.#assertOpen();
    await this.#database.remove(key);
  }

  async has(key: string): Promise<boolean> {
    this.#assertOpen();
    return this.#database.doesExist(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    this.#assertOpen();
    const keys: string[] = [];
    for await (const key of this.keys(prefix)) {
      keys.push(key);
    }

    if (keys.length === 0) {
      return 0;
    }

    await this.#database.batch(() => {
      for (const key of keys) {
        void this.#database.remove(key);
      }
    });

    return keys.length;
  }

  async *scan(prefix: string, options: ScanOptions = {}): AsyncIterable<[string, Uint8Array]> {
    this.#assertOpen();
    const { limit, reverse } = options;

    const prefixEnd = resolvePrefixRangeEnd(prefix);

    // In lmdb-js, reverse iteration requires start > end: start is the
    // upper bound to iterate backwards from, end is the lower bound to stop at.
    const range = reverse
      ? this.#database.getRange({
          start: prefixEnd,
          end: prefix,
          reverse: true,
        })
      : this.#database.getRange({ start: prefix, end: prefixEnd });

    let count = 0;
    let enteredPrefix = false;
    for (const { key, value } of range) {
      // Safety: ensure we stay within the prefix range.
      // Forward: keys past the prefix are lexicographically greater — break.
      // Reverse: iteration starts at prefixEnd which may itself not match — skip
      // non-matching keys until we enter the prefix range, then break when we leave.
      if (!key.startsWith(prefix)) {
        if (reverse && !enteredPrefix) continue;
        break;
      }
      enteredPrefix = true;

      if (!matchesScanOptions(key, options)) continue;
      if (limit !== undefined && count >= limit) break;

      yield [key, new Uint8Array(value)];
      count++;
    }
  }

  async *keys(prefix: string, options: ScanOptions = {}): AsyncIterable<string> {
    this.#assertOpen();
    const { limit, reverse } = options;
    const prefixEnd = resolvePrefixRangeEnd(prefix);

    const range = reverse
      ? this.#database.getKeys({
          start: prefixEnd,
          end: prefix,
          reverse: true,
        })
      : this.#database.getKeys({ start: prefix, end: prefixEnd });

    let count = 0;
    let enteredPrefix = false;
    for (const key of range) {
      if (!key.startsWith(prefix)) {
        if (reverse && !enteredPrefix) {
          continue;
        }
        break;
      }

      enteredPrefix = true;

      if (!matchesScanOptions(key, options)) {
        continue;
      }

      if (limit !== undefined && count >= limit) {
        break;
      }

      yield key;
      count++;
    }
  }

  async count(prefix: string): Promise<number> {
    this.#assertOpen();
    const prefixEnd = resolvePrefixRangeEnd(prefix);
    return this.#database.getKeysCount({ start: prefix, end: prefixEnd });
  }

  scoped(prefix: string): Storage {
    this.#assertOpen();
    const scoped = scopedStorage(this, prefix);
    return scoped;
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    this.#assertOpen();
    if (operations.length === 0) return;

    await this.#database.batch(() => {
      for (const operation of operations) {
        if (operation.type === 'put') {
          void this.#database.put(operation.key, Buffer.from(operation.value));
        } else {
          void this.#database.remove(operation.key);
        }
      }
    });
  }

  async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    this.#assertOpen();
    const committed = this.#database.transactionSync(() => {
      for (const condition of conditions) {
        const currentValue = this.#database.get(condition.key);
        const normalizedCurrentValue =
          currentValue === undefined ? null : new Uint8Array(currentValue);
        if (!storageValuesEqual(normalizedCurrentValue, condition.expectedValue)) {
          return false;
        }
      }

      for (const operation of operations) {
        if (operation.type === 'put') {
          this.#database.putSync(operation.key, Buffer.from(operation.value));
        } else {
          this.#database.removeSync(operation.key);
        }
      }

      return true;
    });

    return committed;
  }

  close(): Promise<void> {
    this.#isClosed = true;
    this.#closePromise ??= (async () => {
      await Promise.resolve();
      await this.#database.close();
    })();
    return this.#closePromise;
  }

  [Symbol.dispose](): void {
    void this.close();
  }
}
