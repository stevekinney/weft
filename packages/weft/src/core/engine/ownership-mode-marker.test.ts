import { describe, expect, it } from 'bun:test';

import type { Storage, StorageCapabilities } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { OwnershipModeMismatchError } from './lease-errors.ts';
import {
  assertOwnershipModeMarker,
  assertOwnershipStorageCapability,
  bootstrapOwnershipGates,
} from './ownership-mode-marker.ts';
import { encodeOwnershipModeMarker } from './workflow-claim-codec.ts';

const markerKey = KEYS.ownershipModeMarker();

/**
 * Wraps a real `MemoryStorage` so the first `get()` for the marker key returns
 * `null` — simulating this engine's initial read racing ahead of a concurrent
 * write — while, at the same moment, "landing" another engine's write directly
 * against the underlying store. The subsequent CAS attempt this engine makes
 * therefore genuinely loses against real storage semantics (not a stubbed
 * boolean), and the re-read that follows observes the concurrent write for
 * real. Optionally deletes the key again before the second `get()`, to
 * simulate the marker vanishing between the lost CAS and the re-read.
 */
function createCasLossStorage(options: {
  concurrentWriteBytes: Uint8Array | null;
  vanishBeforeReread?: boolean;
}): Storage {
  const base = new MemoryStorage();
  let getCallCount = 0;
  const storage: Storage = {
    capabilities: () => base.capabilities(),
    get: async (key) => {
      if (key !== markerKey) return base.get(key);
      getCallCount += 1;
      if (getCallCount === 1) {
        if (options.concurrentWriteBytes !== null) {
          await base.put(markerKey, options.concurrentWriteBytes);
        }
        return null;
      }
      if (getCallCount === 2 && options.vanishBeforeReread === true) {
        await base.delete(markerKey);
      }
      return base.get(key);
    },
    put: (key, value) => base.put(key, value),
    delete: (key) => base.delete(key),
    scan: (prefix, scanOptions) => base.scan(prefix, scanOptions),
    batch: (operations) => base.batch(operations),
    conditionalBatch: (conditions, operations) => base.conditionalBatch(conditions, operations),
    [Symbol.dispose]: () => base[Symbol.dispose](),
  };
  return storage;
}

describe('bootstrapOwnershipGates', () => {
  it('skips entirely for ownership: "none"', async () => {
    let touched = false;
    const storage: Storage = {
      capabilities: () => new MemoryStorage().capabilities(),
      get: async () => {
        touched = true;
        return null;
      },
      put: async () => {
        touched = true;
      },
      delete: async () => {
        touched = true;
      },
      scan: async function* () {
        touched = true;
      },
      batch: async () => {
        touched = true;
      },
      [Symbol.dispose]: () => {},
    };

    await bootstrapOwnershipGates({ storage, ownershipMode: 'none', getNow: () => 0 });

    expect(touched).toBe(false);
  });

  it('stamps a fresh marker for the first fencing-mode engine, then runs Gate 2 after Gate 1', async () => {
    using storage = new MemoryStorage();

    await bootstrapOwnershipGates({
      storage,
      ownershipMode: 'workflow-lease',
      getNow: () => 1_000,
    });

    const bytes = await storage.get(markerKey);
    expect(bytes).not.toBeNull();
    expect(JSON.parse(new TextDecoder().decode(bytes as Uint8Array))).toEqual({
      mode: 'workflow-lease',
      establishedAt: 1_000,
    });
  });

  it('passes when the storage backend lacks conditionalBatch even for ownership: "none" without checking it', async () => {
    // Gate 1 is skipped for 'none', so an adapter without conditionalBatch is fine.
    const base = new MemoryStorage();
    const noCasStorage: Storage = {
      capabilities: (): StorageCapabilities => ({
        ...base.capabilities(),
        conditionalBatch: false,
      }),
      get: (key) => base.get(key),
      put: (key, value) => base.put(key, value),
      delete: (key) => base.delete(key),
      scan: (prefix, options) => base.scan(prefix, options),
      batch: (operations) => base.batch(operations),
      [Symbol.dispose]: () => base[Symbol.dispose](),
    };

    await expect(
      bootstrapOwnershipGates({ storage: noCasStorage, ownershipMode: 'none', getNow: () => 0 }),
    ).resolves.toBeUndefined();
  });
});

describe('assertOwnershipStorageCapability (Gate 1)', () => {
  it('rejects a conditionalBatch: false adapter, naming the configured mode', () => {
    const base = new MemoryStorage();
    const noCasStorage: Storage = {
      capabilities: (): StorageCapabilities => ({
        ...base.capabilities(),
        conditionalBatch: false,
      }),
      get: (key) => base.get(key),
      put: (key, value) => base.put(key, value),
      delete: (key) => base.delete(key),
      scan: (prefix, options) => base.scan(prefix, options),
      batch: (operations) => base.batch(operations),
      [Symbol.dispose]: () => base[Symbol.dispose](),
    };

    expect(() => assertOwnershipStorageCapability(noCasStorage, 'workflow-lease')).toThrow(
      /conditionalBatch/,
    );
    expect(() => assertOwnershipStorageCapability(noCasStorage, 'workflow-lease')).toThrow(
      /ownership: 'workflow-lease'/,
    );

    // Also proves the message names whichever mode is actually configured, not a
    // hardcoded 'workflow-lease' — an operator troubleshooting the shipped global
    // lease must not be misdirected toward an unimplemented feature.
    expect(() => assertOwnershipStorageCapability(noCasStorage, 'lease')).toThrow(
      /ownership: 'lease'/,
    );
  });

  it('passes for a conditionalBatch-capable adapter', () => {
    using storage = new MemoryStorage();
    expect(() => assertOwnershipStorageCapability(storage, 'lease')).not.toThrow();
  });
});

describe('assertOwnershipModeMarker (Gate 2)', () => {
  it("fresh store: stamps the marker with this engine's configured mode", async () => {
    using storage = new MemoryStorage();

    await assertOwnershipModeMarker({ storage, configuredMode: 'lease', getNow: () => 42 });

    const bytes = await storage.get(markerKey);
    expect(bytes).not.toBeNull();
    expect(JSON.parse(new TextDecoder().decode(bytes as Uint8Array))).toEqual({
      mode: 'lease',
      establishedAt: 42,
    });
  });

  it('passes when the stored mode matches the configured mode', async () => {
    using storage = new MemoryStorage();
    await storage.put(
      markerKey,
      encodeOwnershipModeMarker({ mode: 'workflow-lease', establishedAt: 10 }),
    );

    await expect(
      assertOwnershipModeMarker({ storage, configuredMode: 'workflow-lease', getNow: () => 999 }),
    ).resolves.toBeUndefined();

    // Verify Gate 2 did not overwrite the existing marker on a match.
    const bytes = await storage.get(markerKey);
    expect(JSON.parse(new TextDecoder().decode(bytes as Uint8Array))).toEqual({
      mode: 'workflow-lease',
      establishedAt: 10,
    });
  });

  it('throws OwnershipModeMismatchError with all three fields when the stored mode differs', async () => {
    using storage = new MemoryStorage();
    await storage.put(markerKey, encodeOwnershipModeMarker({ mode: 'lease', establishedAt: 500 }));

    let caught: unknown;
    try {
      await assertOwnershipModeMarker({
        storage,
        configuredMode: 'workflow-lease',
        getNow: () => 999,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OwnershipModeMismatchError);
    const error = caught as OwnershipModeMismatchError;
    expect(error.configuredMode).toBe('workflow-lease');
    expect(error.storedMode).toBe('lease');
    expect(error.establishedAt).toBe(500);
  });

  it('on a CAS loss, re-reads and passes when the winning engine used the same mode', async () => {
    const concurrentBytes = encodeOwnershipModeMarker({ mode: 'workflow-lease', establishedAt: 7 });
    const storage = createCasLossStorage({ concurrentWriteBytes: concurrentBytes });

    await expect(
      assertOwnershipModeMarker({ storage, configuredMode: 'workflow-lease', getNow: () => 999 }),
    ).resolves.toBeUndefined();
  });

  it('on a CAS loss, re-reads and throws OwnershipModeMismatchError when the winning engine used a different mode', async () => {
    const concurrentBytes = encodeOwnershipModeMarker({ mode: 'lease', establishedAt: 7 });
    const storage = createCasLossStorage({ concurrentWriteBytes: concurrentBytes });

    let caught: unknown;
    try {
      await assertOwnershipModeMarker({
        storage,
        configuredMode: 'workflow-lease',
        getNow: () => 999,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OwnershipModeMismatchError);
    const error = caught as OwnershipModeMismatchError;
    expect(error.configuredMode).toBe('workflow-lease');
    expect(error.storedMode).toBe('lease');
    expect(error.establishedAt).toBe(7);
  });

  it('on a CAS loss, throws a fail-closed error when the marker is absent again on re-read', async () => {
    const concurrentBytes = encodeOwnershipModeMarker({ mode: 'lease', establishedAt: 7 });
    const storage = createCasLossStorage({
      concurrentWriteBytes: concurrentBytes,
      vanishBeforeReread: true,
    });

    await expect(
      assertOwnershipModeMarker({ storage, configuredMode: 'workflow-lease', getNow: () => 999 }),
    ).rejects.toThrow(/absent again/);
  });

  it('a corrupt marker fails closed instead of being treated as absent', async () => {
    using storage = new MemoryStorage();
    // Bypass the typed encoder to write bytes that don't decode as a valid record.
    await storage.put(markerKey, new TextEncoder().encode(JSON.stringify({ mode: 'bogus-mode' })));

    await expect(
      assertOwnershipModeMarker({ storage, configuredMode: 'workflow-lease', getNow: () => 999 }),
    ).rejects.toThrow(/does not decode as a valid/);

    // Also prove it was not silently overwritten: the corrupt bytes remain.
    const bytes = await storage.get(markerKey);
    expect(JSON.parse(new TextDecoder().decode(bytes as Uint8Array))).toEqual({
      mode: 'bogus-mode',
    });
  });

  it('a corrupt marker found on the post-CAS-loss re-read also fails closed', async () => {
    const corruptBytes = new TextEncoder().encode(JSON.stringify({ mode: 'bogus-mode' }));
    const storage = createCasLossStorage({ concurrentWriteBytes: corruptBytes });

    await expect(
      assertOwnershipModeMarker({ storage, configuredMode: 'workflow-lease', getNow: () => 999 }),
    ).rejects.toThrow(/does not decode as a valid/);
  });
});
