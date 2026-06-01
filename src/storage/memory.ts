import { normalizeDeleteRangeOptions, type DeleteRangeOptions } from './delete-range';
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
 * In-memory {@link Storage} implementation.
 *
 * Backs the engine with a `Map<string, Uint8Array>` — fast, dependency-free,
 * and ideal for tests, ephemeral runs, and CI. State is lost when the process
 * exits, so don't use it for anything you care about between restarts.
 *
 * @example Run an engine with in-memory storage
 * ```ts
 * import { workflow, Engine, MemoryStorage } from '@lostgradient/weft';
 *
 * await using storage = new MemoryStorage();
 * await using engine = new Engine({ storage });
 * engine.register(
 *   workflow({ name: 'noop' }).execute(async function* () {
 *     return 'done';
 *   }),
 * );
 *
 * const handle = await engine.start('noop', null);
 * const result = await handle.result();
 * ```
 */
export class MemoryStorage implements Storage {
  #data: Map<string, Uint8Array>;

  constructor() {
    this.#data = new Map();
  }

  capabilities(): StorageCapabilities {
    // In-process Map with synchronous mutation: every read observes every prior
    // write (linearizable). scan() materializes a sorted key snapshot before
    // yielding, so concurrent mutation is not observed mid-iteration. batch()
    // applies synchronously (atomic). deletePrefix and deleteRange are
    // range-bounded deletes.
    return {
      readAfterWrite: 'linearizable',
      scanConsistency: 'snapshot',
      atomicBatch: true,
      conditionalBatch: true,
      boundedRangeDelete: true,
    };
  }

  #matchesPrefix(key: string, prefix: string, prefixEnd: string): boolean {
    return key >= prefix && key < prefixEnd;
  }

  #collectSortedKeys(prefix: string, prefixEnd: string): string[] {
    const keys: string[] = [];
    for (const key of this.#data.keys()) {
      if (this.#matchesPrefix(key, prefix, prefixEnd)) {
        keys.push(key);
      }
    }
    return keys.toSorted();
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.#data.get(key) ?? null;
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.#data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.#data.delete(key);
  }

  async *scan(prefix: string, options: ScanOptions = {}): AsyncIterable<[string, Uint8Array]> {
    const { limit, reverse } = options;

    const prefixEnd = resolvePrefixRangeEnd(prefix);
    let keys = this.#collectSortedKeys(prefix, prefixEnd);
    keys = keys.filter((key) => matchesScanOptions(key, options));

    if (reverse) {
      keys.reverse();
    }

    let count = 0;
    for (const key of keys) {
      if (limit !== undefined && count >= limit) break;
      const value = this.#data.get(key);
      if (value !== undefined) {
        yield [key, value];
        count++;
      }
    }
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    this.#applyBatchOperations(operations);
  }

  #applyBatchOperations(operations: BatchOperation[]): void {
    for (const operation of operations) {
      if (operation.type === 'put') {
        this.#data.set(operation.key, operation.value);
      } else {
        this.#data.delete(operation.key);
      }
    }
  }

  async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    for (const condition of conditions) {
      const currentValue = this.#data.get(condition.key) ?? null;
      if (!storageValuesEqual(currentValue, condition.expectedValue)) {
        return false;
      }
    }

    this.#applyBatchOperations(operations);
    return true;
  }

  async has(key: string): Promise<boolean> {
    return this.#data.has(key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    const prefixEnd = resolvePrefixRangeEnd(prefix);
    const keys = this.#collectSortedKeys(prefix, prefixEnd);

    for (const key of keys) {
      this.#data.delete(key);
    }

    return keys.length;
  }

  async deleteRange(prefix: string, options: DeleteRangeOptions): Promise<number> {
    const normalized = normalizeDeleteRangeOptions(options);
    const prefixEnd = resolvePrefixRangeEnd(prefix);
    const keys = this.#collectSortedKeys(prefix, prefixEnd).filter((key) =>
      matchesScanOptions(key, normalized),
    );

    // limit deletes the lowest (ascending) keys first; #collectSortedKeys is sorted ascending.
    const bounded = normalized.limit === undefined ? keys : keys.slice(0, normalized.limit);

    for (const key of bounded) {
      this.#data.delete(key);
    }

    return bounded.length;
  }

  async *keys(prefix: string, options: ScanOptions = {}): AsyncIterable<string> {
    const { limit, reverse } = options;
    const prefixEnd = resolvePrefixRangeEnd(prefix);
    let keys = this.#collectSortedKeys(prefix, prefixEnd);
    keys = keys.filter((key) => matchesScanOptions(key, options));

    if (reverse) {
      keys.reverse();
    }

    let count = 0;
    for (const key of keys) {
      if (limit !== undefined && count >= limit) {
        break;
      }

      yield key;
      count++;
    }
  }

  async count(prefix: string): Promise<number> {
    const prefixEnd = resolvePrefixRangeEnd(prefix);
    return this.#collectSortedKeys(prefix, prefixEnd).length;
  }

  scoped(prefix: string): Storage {
    return scopedStorage(this, prefix);
  }

  get size(): number {
    return this.#data.size;
  }

  clear(): void {
    this.#data.clear();
  }

  snapshot(): Map<string, Uint8Array> {
    const copy = new Map<string, Uint8Array>();
    for (const [key, value] of this.#data) {
      copy.set(key, new Uint8Array(value));
    }
    return copy;
  }

  [Symbol.dispose](): void {
    this.#data.clear();
  }
}
