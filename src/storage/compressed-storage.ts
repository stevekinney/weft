/**
 * Storage decorator that transparently compresses and decompresses payloads.
 * Wraps any {@link Storage} implementation and applies compression above a
 * configurable size threshold.
 *
 * @module storage/compressed-storage
 */

import type { CompressionOptions, Compressor } from '../core/compression.ts';
import {
  compressPayload,
  createBunCompressor,
  decompressPayload,
  resolveCompressionOptions,
} from '../core/compression.ts';

import {
  assertStorageBatchOperationCount,
  type BatchOperation,
  type ScanOptions,
  type Storage,
  type StorageCapabilities,
} from './interface.ts';

/**
 * {@link Storage} decorator that transparently compresses payloads above a
 * configurable size threshold before writing and decompresses on read.
 *
 * Wraps any `Storage` implementation — pass a {@link BunSQLiteStorage},
 * {@link MemoryStorage}, or any other backend as the first argument. The same
 * compression algorithm and threshold apply to every stored key.
 *
 * @example
 * ```ts
 * import { CompressedStorage } from '@lostgradient/weft/storage/compressed';
 * import { workflow, Engine, MemoryStorage } from '@lostgradient/weft';
 *
 * await using inner = new MemoryStorage();
 * await using storage = new CompressedStorage(inner, {
 *   algorithm: 'gzip',
 *   threshold: 1024,
 * });
 * await using engine = new Engine({ storage });
 *
 * engine.register(workflow({ name: 'noop' }).execute(async function* () { return 'done'; }));
 * const handle = await engine.start('noop', null);
 * console.log(await handle.result()); // 'done'
 * ```
 */
export class CompressedStorage implements Storage {
  #inner: Storage;
  #compressor: Compressor;
  #threshold: number;

  constructor(inner: Storage, options?: CompressionOptions) {
    this.#inner = inner;
    const resolved = resolveCompressionOptions(options);
    this.#compressor = createBunCompressor(resolved.algorithm);
    this.#threshold = resolved.threshold;

    // Forward query when the inner storage provides it. Assigned via
    // defineProperty so the property is absent (not undefined) when the
    // inner storage lacks a query method — this satisfies
    // exactOptionalPropertyTypes.
    if (inner.query) {
      const boundQuery = inner.query.bind(inner);
      Object.defineProperty(this, 'query', {
        value: boundQuery,
        enumerable: true,
        configurable: true,
      });
    }
  }

  capabilities(): StorageCapabilities {
    // Compression transforms value bytes, so a caller-supplied expectedValue
    // can never byte-match the compressed stored value — conditionalBatch is
    // semantically broken through this decorator (and not forwarded). The
    // decorator also does not forward deletePrefix or deleteRange. Both are
    // forced false; the
    // visibility/atomicity properties are unchanged by per-value compression, so
    // they pass through from the inner store. This is the opaque-value invariant
    // enforced at the type level.
    const inner = this.#inner.capabilities();
    return {
      ...(inner.persistence === undefined ? {} : { persistence: inner.persistence }),
      readAfterWrite: inner.readAfterWrite,
      scanConsistency: inner.scanConsistency,
      atomicBatch: inner.atomicBatch,
      conditionalBatch: false,
      boundedRangeDelete: false,
    };
  }

  async get(key: string): Promise<Uint8Array | null> {
    const raw = await this.#inner.get(key);
    if (!raw) return null;
    return decompressPayload(raw);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    const compressed = await compressPayload(value, this.#compressor, this.#threshold);
    return this.#inner.put(key, compressed);
  }

  async delete(key: string): Promise<void> {
    return this.#inner.delete(key);
  }

  async *scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]> {
    for await (const [key, value] of this.#inner.scan(prefix, options)) {
      yield [key, await decompressPayload(value)];
    }
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    assertStorageBatchOperationCount('batch operations', operations.length);
    const compressed = await Promise.all(
      operations.map(async (op) => {
        if (op.type === 'put') {
          return {
            type: 'put' as const,
            key: op.key,
            value: await compressPayload(op.value, this.#compressor, this.#threshold),
          };
        }
        return op;
      }),
    );
    return this.#inner.batch(compressed);
  }

  [Symbol.dispose](): void {
    this.#inner[Symbol.dispose]();
  }
}
