/**
 * Shared test-only storage adapter fixtures used by the typed-storage and
 * scoped-storage suites. Both suites prove their wrappers behave correctly
 * against (a) a core-five adapter that omits every optional method (forcing the
 * derived fallbacks) and (b) a full adapter that forwards the optional surface
 * and tracks disposal. This module is the single source of truth for those
 * fixtures so the two suites stay in lockstep.
 *
 * Consumed via deep import and intentionally not re-exported from any package
 * entry point — it is test infrastructure, not part of the package surface. The
 * `.test-support.ts` suffix is excluded by `tsconfig.build.json` so this file
 * never ships in `dist/`.
 */

import { describe, expect, it } from 'bun:test';

import type { Storage, StorageCapabilities } from './interface.ts';
import { storageConditionalBatch } from './interface.ts';
import { MemoryStorage } from './memory.ts';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Encode a string as bytes for storage values. */
export function bytes(value: string): Uint8Array {
  return textEncoder.encode(value);
}

/** Decode storage bytes back into a string. */
export function decodeText(value: Uint8Array): string {
  return textDecoder.decode(value);
}

/** Drain an async iterable into an array, preserving order. */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

/**
 * A `linearizable`/`snapshot` capability profile with every boolean enabled —
 * the shape a single-process, fully-featured adapter (like `MemoryStorage`)
 * reports. Test doubles that delegate to a real backend can reuse this.
 */
export function fullStorageCapabilities(): StorageCapabilities {
  return {
    readAfterWrite: 'linearizable',
    scanConsistency: 'snapshot',
    atomicBatch: true,
    conditionalBatch: true,
    boundedRangeDelete: true,
  };
}

/**
 * A conservative capability profile for a minimal adapter that omits the
 * optional surface: no compare-and-swap and no bounded range delete. Used by
 * {@link createCoreStorageAdapter} so it doubles as the gate-failure fixture.
 */
export function coreStorageCapabilities(): StorageCapabilities {
  return {
    readAfterWrite: 'linearizable',
    scanConsistency: 'snapshot',
    atomicBatch: true,
    conditionalBatch: false,
    boundedRangeDelete: false,
  };
}

/**
 * Assert that `capabilities()` returns a well-formed {@link StorageCapabilities}
 * object: all five keys present, each value within its allowed union/boolean.
 * Every adapter suite calls this to guarantee uniform shape coverage.
 */
export function assertCapabilitiesShape(storage: Storage): void {
  const capabilities = storage.capabilities();
  expect(['linearizable', 'session', 'eventual']).toContain(capabilities.readAfterWrite);
  expect(['snapshot', 'best-effort']).toContain(capabilities.scanConsistency);
  expect(typeof capabilities.atomicBatch).toBe('boolean');
  expect(typeof capabilities.conditionalBatch).toBe('boolean');
  expect(typeof capabilities.boundedRangeDelete).toBe('boolean');
}

/**
 * A `Storage` exposing ONLY the required core-five operations
 * (get/put/delete/scan/batch) plus dispose, backed by a real `MemoryStorage`.
 * Used to prove wrappers degrade to derived fallbacks when optional methods are
 * absent.
 */
export function createCoreStorageAdapter(): Storage {
  const storage = new MemoryStorage();

  return {
    capabilities: coreStorageCapabilities,
    get: storage.get.bind(storage),
    put: storage.put.bind(storage),
    delete: storage.delete.bind(storage),
    scan: storage.scan.bind(storage),
    batch: storage.batch.bind(storage),
    [Symbol.dispose]: storage[Symbol.dispose].bind(storage),
  };
}

/** Handle returned by {@link createFullStorageAdapter}. */
export type FullStorageAdapter = {
  /** Storage exposing the full optional surface (has/deletePrefix/keys/count). */
  readonly storage: Storage;
  /** The underlying `MemoryStorage`, for asserting raw on-disk keys. */
  readonly inner: MemoryStorage;
  /** True once the adapter's `[Symbol.dispose]` ran. */
  readonly wasDisposed: () => boolean;
};

/**
 * A full `Storage` adapter backed by a real `MemoryStorage` that forwards every
 * optional method and flips a disposal flag observable via `wasDisposed()`.
 */
export function createFullStorageAdapter(): FullStorageAdapter {
  const storage = new MemoryStorage();
  let disposed = false;

  return {
    storage: {
      capabilities: storage.capabilities.bind(storage),
      get: storage.get.bind(storage),
      put: storage.put.bind(storage),
      delete: storage.delete.bind(storage),
      scan: storage.scan.bind(storage),
      batch: storage.batch.bind(storage),
      has: storage.has?.bind(storage),
      deletePrefix: storage.deletePrefix?.bind(storage),
      keys: storage.keys?.bind(storage),
      count: storage.count?.bind(storage),
      [Symbol.dispose]: () => {
        disposed = true;
        storage[Symbol.dispose]();
      },
    } satisfies Storage,
    inner: storage,
    wasDisposed: () => disposed,
  };
}

/** Options for {@link runStorageCapabilityConformance}. */
export type CapabilityConformanceOptions = {
  /** Construct a fresh, empty adapter for each conformance case. */
  readonly create: () => Storage | Promise<Storage>;
  /** Expected capability row for this adapter (asserted exactly). */
  readonly expected: StorageCapabilities;
  /**
   * Whether the adapter supports two in-flight write transactions at once.
   * Single-connection backends (libSQL/Turso) serialize writers and cannot run
   * the concurrent compare-and-swap contention case; set `false` to skip it.
   * Defaults to `true`.
   */
  readonly supportsConcurrentWrites?: boolean;
};

/**
 * Register a shared `describe` block that proves an adapter's declared
 * {@link StorageCapabilities} against its actual behavior — not just its
 * self-report. Asserts the exact matrix row, then behaviorally verifies
 * read-after-write, scan isolation (for `snapshot` adapters), and
 * compare-and-swap contention (for `conditionalBatch` adapters). Adapters whose
 * values are contract-based (remote Turso, HTTP) assert the shape/row only and
 * skip the behavioral cases that a local harness cannot prove.
 */
export function runStorageCapabilityConformance(
  name: string,
  options: CapabilityConformanceOptions,
): void {
  const { create, expected, supportsConcurrentWrites = true } = options;

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
      // For linearizable/session a same-instance read must observe the write;
      // eventual makes no same-instance promise, so only assert when stronger.
      if (expected.readAfterWrite !== 'eventual') {
        expect(observed).not.toBeNull();
        expect(new TextDecoder().decode(observed!)).toBe('written');
      }
    });

    // Note: distinguishing `linearizable` from `session` requires two truly
    // concurrent callers, which a single-process in-memory conformance harness
    // cannot stage. That guarantee is upheld by the engine's use of one shared
    // storage instance and is not provable here, so there is no separate
    // linearizable behavioral case — the read-after-write assertion above is the
    // strongest single-caller proof the harness can make.

    if (expected.scanConsistency === 'snapshot') {
      it('does not observe a key inserted after the scan began (snapshot)', async () => {
        using storage = await create();
        await storage.put('scan:a', bytes('1'));
        await storage.put('scan:b', bytes('2'));

        const iterator = storage.scan('scan:')[Symbol.asyncIterator]();
        const first = await iterator.next();
        expect(first.done).toBe(false);
        // Insert a new key after the scan has started; a snapshot scan fixes its
        // key set at the start and must not surface this late insertion.
        await storage.put('scan:c', bytes('3'));

        const seen: string[] = [];
        if (!first.done) seen.push(first.value[0]);
        for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
          seen.push(next.value[0]);
        }
        expect(seen).not.toContain('scan:c');
        expect(seen).toContain('scan:a');
        // Both pre-existing keys must appear — guards against an adapter that
        // re-runs the query per step and skips keys ordered before the insert.
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
        expect(new TextDecoder().decode((await storage.get('cas:key'))!)).toBe('initial');
      });

      it.skipIf(!supportsConcurrentWrites)(
        'lets exactly one of two contending conditionalBatch calls win',
        async () => {
          using storage = await create();
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
          // Exactly one call observed the expected value and committed.
          expect([first, second].filter(Boolean)).toHaveLength(1);
          const winner = new TextDecoder().decode((await storage.get('cas:counter'))!);
          expect(winner).toBe(first ? 'first' : 'second');
        },
      );
    }
  });
}

/** Construct a fresh, empty adapter for each basic-contract case. */
export type BasicStorageContractOptions = {
  readonly create: () => Storage | Promise<Storage>;
};

/**
 * Register the basic key/value and scan contract that every storage adapter
 * must satisfy identically: get/put/overwrite/delete and prefix scans with
 * limit/reverse/range bounds. Each case constructs a fresh adapter via
 * `create()` and disposes it through `using`, so adapters that hold native
 * handles (SQLite) and adapters that do not (in-memory) share one source of
 * truth. Batch behavior and adapter-specific construction, disposal semantics,
 * capability rows, and edge cases stay in the per-adapter suite.
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

    it('scan with empty prefix returns all keys', async () => {
      using storage = await create();
      await storage.put('alpha', bytes('a'));
      await storage.put('beta', bytes('b'));
      await storage.put('gamma', bytes('c'));

      const entries = await collect(storage.scan(''));
      expect(entries.map(([key]) => key)).toEqual(['alpha', 'beta', 'gamma']);
    });
  });
}
