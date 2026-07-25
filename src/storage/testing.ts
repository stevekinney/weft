/**
 * Storage adapter conformance helpers for third-party adapter authors.
 *
 * Imported via `@lostgradient/weft/storage/testing`. These helpers register
 * `bun:test` suites against a caller-provided adapter factory, so this subpath
 * is intended for Bun test files rather than production runtime bundles.
 *
 * @module @lostgradient/weft/storage/testing
 */

import { describe, expect, it } from 'bun:test';

import type { Storage, StorageCapabilities } from './interface.ts';
import { storageConditionalBatch } from './interface.ts';
import {
  assertCapabilitiesShape,
  bytes,
  collect,
  decodeText,
} from './storage-test-primitives.test-support.ts';

/**
 * Options for {@link runStorageCapabilityConformance}.
 *
 * @example
 * ```ts
 * import type { CapabilityConformanceOptions } from '@lostgradient/weft/storage/testing';
 * import { MemoryStorage, type StorageCapabilities } from '@lostgradient/weft/storage';
 *
 * const expected = {
 *   persistence: 'ephemeral',
 *   readAfterWrite: 'linearizable',
 *   scanConsistency: 'snapshot',
 *   atomicBatch: true,
 *   conditionalBatch: true,
 *   boundedRangeDelete: true,
 * } satisfies StorageCapabilities;
 *
 * const options: CapabilityConformanceOptions = {
 *   create: () => new MemoryStorage(),
 *   expected,
 * };
 * ```
 */
export type CapabilityConformanceOptions = {
  /** Construct a fresh, empty adapter for each conformance case. */
  readonly create: () => Storage | Promise<Storage>;
  /** Expected capability row for this adapter, asserted exactly. */
  readonly expected: StorageCapabilities;
};

/**
 * Options for {@link runConcurrentConditionalBatchConformance}.
 *
 * @example
 * ```ts
 * import type { ConcurrentConditionalBatchConformanceOptions } from '@lostgradient/weft/storage/testing';
 * import { BunSQLiteStorage } from '@lostgradient/weft/storage/sqlite/bun';
 *
 * const options: ConcurrentConditionalBatchConformanceOptions = {
 *   create: () => new BunSQLiteStorage(':memory:'),
 * };
 * ```
 */
export type ConcurrentConditionalBatchConformanceOptions = {
  /** Construct a fresh, empty adapter that can stage concurrent write transactions. */
  readonly create: () => Storage | Promise<Storage>;
};

/**
 * Options for {@link runBinaryAndLargeScanStorageConformance}.
 *
 * @example
 * ```ts
 * import type { BinaryAndLargeScanConformanceOptions } from '@lostgradient/weft/storage/testing';
 * import { MemoryStorage } from '@lostgradient/weft/storage';
 *
 * const options: BinaryAndLargeScanConformanceOptions = {
 *   create: () => new MemoryStorage(),
 * };
 * ```
 */
export type BinaryAndLargeScanConformanceOptions = {
  /** Construct a fresh, empty adapter for each conformance case. */
  readonly create: () => Storage | Promise<Storage>;
  /** Optional timeout for adapters whose local large-scan test needs more time. */
  readonly largeScanTimeoutMs?: number;
};

/**
 * Construct a fresh, empty adapter for each basic-contract case.
 *
 * @example
 * ```ts
 * import type { BasicStorageContractOptions } from '@lostgradient/weft/storage/testing';
 * import { MemoryStorage } from '@lostgradient/weft/storage';
 *
 * const options: BasicStorageContractOptions = {
 *   create: () => new MemoryStorage(),
 * };
 * ```
 */
export type BasicStorageContractOptions = {
  readonly create: () => Storage | Promise<Storage>;
};

/**
 * Register a shared `describe` block for binary byte round-trips and large
 * sorted prefix scans. Use this alongside the basic contract for adapters whose
 * production storage can exercise larger result sets locally.
 *
 * @example
 * ```ts
 * import { runBinaryAndLargeScanStorageConformance } from '@lostgradient/weft/storage/testing';
 * import { MemoryStorage } from '@lostgradient/weft/storage';
 *
 * runBinaryAndLargeScanStorageConformance('MemoryStorage', {
 *   create: () => new MemoryStorage(),
 * });
 * ```
 */
export function runBinaryAndLargeScanStorageConformance(
  name: string,
  options: BinaryAndLargeScanConformanceOptions,
): void {
  describe(`${name} binary and large-scan conformance`, () => {
    it('round-trips binary values correctly', async () => {
      const storage = await options.create();
      try {
        const binaryData = new Uint8Array([0, 1, 127, 128, 255, 42, 0, 13, 10]);
        await storage.put('binary', binaryData);
        const result = await storage.get('binary');
        expect(result).toEqual(binaryData);
      } finally {
        storage[Symbol.dispose]();
      }
    });

    it(
      'returns 1000 scanned keys in sorted order',
      async () => {
        const storage = await options.create();
        try {
          const operations = Array.from({ length: 1000 }, (_, index) => ({
            type: 'put' as const,
            key: `item:${String(index).padStart(4, '0')}`,
            value: bytes(String(index)),
          }));
          await storage.batch(operations);

          const entries = await collect(storage.scan('item:'));
          expect(entries).toHaveLength(1000);

          for (let index = 0; index < entries.length; index += 1) {
            expect(entries[index]![0]).toBe(`item:${String(index).padStart(4, '0')}`);
          }
        } finally {
          storage[Symbol.dispose]();
        }
      },
      options.largeScanTimeoutMs,
    );
  });
}

/**
 * Register a shared `describe` block that proves an adapter's declared
 * {@link StorageCapabilities} against its actual behavior, not just its
 * self-report. The suite asserts the exact capability row, then behaviorally
 * verifies read-after-write, snapshot scans, and compare-and-swap contention
 * when the adapter claims those stronger guarantees.
 *
 * @example
 * ```ts
 * import { runStorageCapabilityConformance } from '@lostgradient/weft/storage/testing';
 * import { MemoryStorage, type StorageCapabilities } from '@lostgradient/weft/storage';
 *
 * const expected = {
 *   persistence: 'ephemeral',
 *   readAfterWrite: 'linearizable',
 *   scanConsistency: 'snapshot',
 *   atomicBatch: true,
 *   conditionalBatch: true,
 *   boundedRangeDelete: true,
 * } satisfies StorageCapabilities;
 *
 * runStorageCapabilityConformance('MemoryStorage', {
 *   create: () => new MemoryStorage(),
 *   expected,
 * });
 * ```
 */
export function runStorageCapabilityConformance(
  name: string,
  options: CapabilityConformanceOptions,
): void {
  const { create, expected } = options;

  describe(`${name} capabilities() conformance`, () => {
    it('reports a well-formed capability shape', async () => {
      using storage = await create();
      assertCapabilitiesShape(storage);
    });

    it('reports the expected capability row', async () => {
      using storage = await create();
      expect(storage.capabilities()).toEqual(expected);
    });

    it('satisfies its declared read-after-write level', async () => {
      using storage = await create();
      await storage.put('raw:key', bytes('written'));
      const observed = await storage.get('raw:key');
      if (expected.readAfterWrite !== 'eventual') {
        expect(observed).not.toBeNull();
        expect(decodeText(observed!)).toBe('written');
      }
    });

    if (expected.scanConsistency === 'snapshot') {
      it('does not observe a key inserted after the scan began (snapshot)', async () => {
        using storage = await create();
        await storage.put('scan:a', bytes('1'));
        await storage.put('scan:b', bytes('2'));

        const iterator = storage.scan('scan:')[Symbol.asyncIterator]();
        const first = await iterator.next();
        expect(first.done).toBe(false);
        await storage.put('scan:c', bytes('3'));

        const seen: string[] = [];
        if (!first.done) seen.push(first.value[0]);
        for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
          seen.push(next.value[0]);
        }
        expect(seen).not.toContain('scan:c');
        expect(seen).toContain('scan:a');
        expect(seen).toContain('scan:b');
      });
    }

    if (expected.conditionalBatch) {
      it('applies nothing when a conditionalBatch precondition mismatches', async () => {
        using storage = await create();
        await storage.put('cas:key', bytes('initial'));
        const applied = await storageConditionalBatch(
          storage,
          [{ key: 'cas:key', expectedValue: bytes('wrong') }],
          [{ type: 'put', key: 'cas:key', value: bytes('changed') }],
        );
        expect(applied).toBe(false);
        expect(decodeText((await storage.get('cas:key'))!)).toBe('initial');
      });

      it('reports conditionalBatch before running compare-and-swap assertions', async () => {
        using storage = await create();
        expect(storage.capabilities().conditionalBatch).toBe(true);
      });
    }
  });
}

/**
 * Register a shared `describe` block that exercises concurrent
 * compare-and-swap writes against one adapter instance. Use this in addition to
 * {@link runStorageCapabilityConformance} for storage backends that can stage
 * overlapping write transactions locally. Synchronous in-memory adapters still
 * run these calls in the same JavaScript turn, so pair this helper with an
 * adapter-specific multi-connection test when true IO-level contention matters.
 *
 * @example
 * ```ts
 * import { runConcurrentConditionalBatchConformance } from '@lostgradient/weft/storage/testing';
 * import { BunSQLiteStorage } from '@lostgradient/weft/storage/sqlite/bun';
 *
 * runConcurrentConditionalBatchConformance('BunSQLiteStorage', {
 *   create: () => new BunSQLiteStorage(':memory:'),
 * });
 * ```
 */
export function runConcurrentConditionalBatchConformance(
  name: string,
  options: ConcurrentConditionalBatchConformanceOptions,
): void {
  const { create } = options;

  describe(`${name} concurrent conditionalBatch conformance`, () => {
    it('lets exactly one of two contending conditionalBatch calls win', async () => {
      using storage = await create();
      expect(storage.capabilities().conditionalBatch).toBe(true);
      await storage.put('cas:counter', bytes('start'));
      const condition = [{ key: 'cas:counter', expectedValue: bytes('start') }];
      const [first, second] = await Promise.all([
        storageConditionalBatch(storage, condition, [
          { type: 'put', key: 'cas:counter', value: bytes('first') },
        ]),
        storageConditionalBatch(storage, condition, [
          { type: 'put', key: 'cas:counter', value: bytes('second') },
        ]),
      ]);
      expect([first, second].filter(Boolean)).toHaveLength(1);
      const winner = decodeText((await storage.get('cas:counter'))!);
      expect(winner).toBe(first ? 'first' : 'second');
    });
  });
}

/**
 * Register the complete basic key/value and scan contract that every storage
 * adapter must satisfy: get, put, overwrite, delete (including missing keys),
 * prefix scans, limits, reverse ordering, exclusive and inclusive range
 * bounds, no-match scans, empty-prefix scans, and put/delete batches.
 *
 * @example
 * ```ts
 * import { runBasicStorageContract } from '@lostgradient/weft/storage/testing';
 * import { MemoryStorage } from '@lostgradient/weft/storage';
 *
 * runBasicStorageContract('MemoryStorage', {
 *   create: () => new MemoryStorage(),
 * });
 * ```
 */
export function runBasicStorageContract(name: string, options: BasicStorageContractOptions): void {
  const { create } = options;

  describe(`${name} basic storage contract`, () => {
    it('get on empty storage returns null', async () => {
      using storage = await create();
      const result = await storage.get('nonexistent');
      expect(result).toBeNull();
    });

    it('put then get returns same bytes', async () => {
      using storage = await create();
      const value = bytes('hello');
      await storage.put('key', value);
      const result = await storage.get('key');
      expect(result).toEqual(value);
    });

    it('put with same key overwrites previous value', async () => {
      using storage = await create();
      await storage.put('key', bytes('first'));
      await storage.put('key', bytes('second'));
      const result = await storage.get('key');
      expect(decodeText(result!)).toBe('second');
    });

    it('delete removes key, subsequent get returns null', async () => {
      using storage = await create();
      await storage.put('key', bytes('value'));
      await storage.delete('key');
      const result = await storage.get('key');
      expect(result).toBeNull();
    });

    it('delete on a missing key is a no-op', async () => {
      using storage = await create();
      await storage.delete('nonexistent');
      expect(await storage.get('nonexistent')).toBeNull();
    });

    it('scan with prefix returns only matching keys, sorted lexicographically', async () => {
      using storage = await create();
      await storage.put('wf:b', bytes('b'));
      await storage.put('wf:a', bytes('a'));
      await storage.put('wf:c', bytes('c'));
      await storage.put('other:x', bytes('x'));

      const entries = await collect(storage.scan('wf:'));
      expect(entries.map(([key]) => key)).toEqual(['wf:a', 'wf:b', 'wf:c']);
    });

    it('scan with limit returns at most N entries', async () => {
      using storage = await create();
      await storage.put('p:a', bytes('a'));
      await storage.put('p:b', bytes('b'));
      await storage.put('p:c', bytes('c'));

      const entries = await collect(storage.scan('p:', { limit: 2 }));
      expect(entries).toHaveLength(2);
      expect(entries.map(([key]) => key)).toEqual(['p:a', 'p:b']);
    });

    it('scan with reverse returns in reverse order', async () => {
      using storage = await create();
      await storage.put('p:a', bytes('a'));
      await storage.put('p:b', bytes('b'));
      await storage.put('p:c', bytes('c'));

      const entries = await collect(storage.scan('p:', { reverse: true }));
      expect(entries.map(([key]) => key)).toEqual(['p:c', 'p:b', 'p:a']);
    });

    it('scan with gt/lt bounds', async () => {
      using storage = await create();
      await storage.put('p:a', bytes('a'));
      await storage.put('p:b', bytes('b'));
      await storage.put('p:c', bytes('c'));
      await storage.put('p:d', bytes('d'));

      const entries = await collect(storage.scan('p:', { gt: 'p:a', lt: 'p:d' }));
      expect(entries.map(([key]) => key)).toEqual(['p:b', 'p:c']);
    });

    it('scan with inclusive gte/lte bounds', async () => {
      using storage = await create();
      await storage.put('p:a', bytes('a'));
      await storage.put('p:b', bytes('b'));
      await storage.put('p:c', bytes('c'));
      await storage.put('p:d', bytes('d'));

      const entries = await collect(storage.scan('p:', { gte: 'p:b', lte: 'p:c' }));
      expect(entries.map(([key]) => key)).toEqual(['p:b', 'p:c']);
    });

    it('scan with no matching keys returns no entries', async () => {
      using storage = await create();
      await storage.put('other:a', bytes('a'));

      expect(await collect(storage.scan('wf:'))).toHaveLength(0);
    });

    it('batch with multiple puts stores every value', async () => {
      using storage = await create();
      await storage.batch([
        { type: 'put', key: 'a', value: bytes('1') },
        { type: 'put', key: 'b', value: bytes('2') },
        { type: 'put', key: 'c', value: bytes('3') },
      ]);

      expect(await storage.get('a')).toEqual(bytes('1'));
      expect(await storage.get('b')).toEqual(bytes('2'));
      expect(await storage.get('c')).toEqual(bytes('3'));
    });

    it('batch with mixed puts and deletes leaves the expected state', async () => {
      using storage = await create();
      await storage.put('keep', bytes('keep'));
      await storage.put('remove', bytes('remove'));

      await storage.batch([
        { type: 'put', key: 'new', value: bytes('new') },
        { type: 'delete', key: 'remove' },
      ]);

      expect(await storage.get('keep')).toEqual(bytes('keep'));
      expect(await storage.get('remove')).toBeNull();
      expect(await storage.get('new')).toEqual(bytes('new'));
    });

    it('batch with no operations is a no-op', async () => {
      using storage = await create();
      await storage.put('key', bytes('value'));
      await storage.batch([]);
      expect(await storage.get('key')).toEqual(bytes('value'));
    });

    it('scan with empty prefix returns all keys', async () => {
      using storage = await create();
      await storage.put('alpha', bytes('a'));
      await storage.put('beta', bytes('b'));
      await storage.put('gamma', bytes('c'));

      const entries = await collect(storage.scan(''));
      expect(entries.map(([key]) => key)).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('scan with empty prefix on empty storage returns no entries', async () => {
      using storage = await create();
      expect(await collect(storage.scan(''))).toEqual([]);
    });
  });
}
