import {
  storageBatch,
  storageConditionalBatch,
  type BatchOperation,
  type ConditionalBatchCondition,
  type ScanOptions,
  type Storage,
} from '../storage/interface.ts';

/**
 * Byte-oriented raw storage surface shared by local and HTTP clients.
 *
 * @example
 * ```ts
 * import { Engine, LocalClient, MemoryStorage, type WeftClientStorage } from '@lostgradient/weft';
 *
 * await using engine = new Engine({ storage: new MemoryStorage() });
 * const client = new LocalClient(engine);
 * const storage: WeftClientStorage = client.storage;
 * await storage.put('example:key', new TextEncoder().encode('value'));
 * ```
 */
export interface WeftClientStorage {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]>;
  batch(operations: BatchOperation[]): Promise<void>;
  conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean>;
}

/** Adapt an engine-owned storage backend without exposing adapter-only methods. */
export function createLocalClientStorage(storage: Storage): WeftClientStorage {
  return {
    get: (key) => storage.get(key),
    put: (key, value) => storage.put(key, value),
    delete: (key) => storage.delete(key),
    scan: (prefix, options) => storage.scan(prefix, options),
    batch: (operations) => storageBatch(storage, operations),
    conditionalBatch: (conditions, operations) =>
      storageConditionalBatch(storage, conditions, operations),
  };
}
