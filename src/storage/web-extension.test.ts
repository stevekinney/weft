import { describe, expect, it } from 'bun:test';

import type { BatchOperation } from './interface.ts';
import { assertCapabilitiesShape } from './storage-adapter.test-support.ts';
import { WebExtensionStorage } from './web-extension.ts';

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decode(value: Uint8Array | null): string | null {
  return value === null ? null : new TextDecoder().decode(value);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const value of iterable) {
    results.push(value);
  }
  return results;
}

type FakeStorageAreaOptions = {
  callbackStyle?: boolean;
  quotaBytes?: number;
  quotaBytesPerItem?: number;
};

type WebExtensionTestGlobal = typeof globalThis & {
  browser?: unknown;
  chrome?: unknown;
};

type StorageNamespaceOptions = {
  onAddListener?: () => void;
  onRemoveListener?: () => void;
};

class FakeStorageArea {
  readonly data = new Map<string, unknown>();
  readonly callbackStyle: boolean;
  readonly QUOTA_BYTES?: number;
  readonly QUOTA_BYTES_PER_ITEM?: number;
  setCallCount = 0;
  removeCallCount = 0;

  constructor(options: FakeStorageAreaOptions = {}) {
    this.callbackStyle = options.callbackStyle ?? false;
    if (options.quotaBytes !== undefined) this.QUOTA_BYTES = options.quotaBytes;
    if (options.quotaBytesPerItem !== undefined)
      this.QUOTA_BYTES_PER_ITEM = options.quotaBytesPerItem;
  }

  get(keys?: string | string[] | null, callback?: (items: Record<string, unknown>) => void) {
    const result: Record<string, unknown> = {};
    if (keys === undefined || keys === null) {
      for (const [key, value] of this.data) result[key] = value;
    } else if (typeof keys === 'string') {
      const value = this.data.get(keys);
      if (value !== undefined) result[keys] = value;
    } else {
      for (const key of keys) {
        const value = this.data.get(key);
        if (value !== undefined) result[key] = value;
      }
    }
    return this.#finish(result, callback);
  }

  set(items: Record<string, unknown>, callback?: () => void) {
    this.setCallCount += 1;
    for (const [key, value] of Object.entries(items)) this.data.set(key, value);
    return this.#finish(undefined, callback);
  }

  remove(keys: string | string[], callback?: () => void) {
    this.removeCallCount += 1;
    const normalized = Array.isArray(keys) ? keys : [keys];
    for (const key of normalized) this.data.delete(key);
    return this.#finish(undefined, callback);
  }

  getBytesInUse(keys?: string | string[] | null, callback?: (bytes: number) => void) {
    const selected = new Map<string, unknown>();
    if (keys === undefined || keys === null) {
      for (const [key, value] of this.data) selected.set(key, value);
    } else if (typeof keys === 'string') {
      if (this.data.has(keys)) selected.set(keys, this.data.get(keys));
    } else {
      for (const key of keys) {
        if (this.data.has(key)) selected.set(key, this.data.get(key));
      }
    }
    const bytes = new TextEncoder().encode(JSON.stringify(Object.fromEntries(selected))).byteLength;
    return this.#finish(bytes, callback);
  }

  #finish<T>(value: T, callback?: (value: T) => void): Promise<T> | undefined {
    if (this.callbackStyle) {
      queueMicrotask(() => callback?.(value));
      return undefined;
    }
    return Promise.resolve(value);
  }
}

function installStorageNamespace(
  namespace: 'browser' | 'chrome',
  area: {
    QUOTA_BYTES?: number;
    QUOTA_BYTES_PER_ITEM?: number;
    get: FakeStorageArea['get'];
    set: FakeStorageArea['set'];
    remove: FakeStorageArea['remove'];
    getBytesInUse?: FakeStorageArea['getBytesInUse'];
  },
  options: StorageNamespaceOptions = {},
): () => void {
  const globalObject = globalThis as WebExtensionTestGlobal;
  const previousBrowser = globalObject.browser;
  const previousChrome = globalObject.chrome;
  const storageNamespace = {
    storage: {
      local: area,
      sync: area,
      managed: area,
      onChanged: {
        addListener() {
          options.onAddListener?.();
        },
        removeListener() {
          options.onRemoveListener?.();
        },
      },
    },
  };
  Object.assign(globalObject, {
    browser: undefined,
    chrome: undefined,
    [namespace]: storageNamespace,
  });
  return () => {
    Object.assign(globalObject, { browser: previousBrowser, chrome: previousChrome });
  };
}

describe('WebExtensionStorage', () => {
  it('reports its honest capability row (no conditionalBatch, scan-and-delete prefix)', async () => {
    const area = new FakeStorageArea();
    const restore = installStorageNamespace('browser', area);
    try {
      const storage = new WebExtensionStorage();
      assertCapabilitiesShape(storage);
      expect(storage.capabilities()).toEqual({
        readAfterWrite: 'session',
        scanConsistency: 'best-effort',
        atomicBatch: true,
        conditionalBatch: false,
        boundedRangeDelete: false,
      });
      // Read-after-write at the session level: the instance reads its own write.
      await storage.put('raw:key', encode('written'));
      expect(decode(await storage.get('raw:key'))).toBe('written');
    } finally {
      restore();
    }
  });

  it('does not expose conditionalBatch (capabilities reports false)', async () => {
    const area = new FakeStorageArea();
    const restore = installStorageNamespace('browser', area);
    try {
      const storage = new WebExtensionStorage();
      expect(storage.capabilities().conditionalBatch).toBe(false);
      expect((storage as { conditionalBatch?: unknown }).conditionalBatch).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('stores bytes and scans keys through browser.storage', async () => {
    const area = new FakeStorageArea();
    const restore = installStorageNamespace('browser', area);
    try {
      const storage = new WebExtensionStorage();
      await storage.put('wf:one', encode('first'));
      await storage.put('wf:two', encode('second'));
      await storage.put('other', encode('ignored'));
      const entries = await collect(storage.scan('wf:'));

      expect(decode(await storage.get('wf:one'))).toBe('first');
      expect(await collect(storage.keys('wf:'))).toEqual(['wf:one', 'wf:two']);
      expect(entries.map(([key, value]) => [key, decode(value)])).toEqual([
        ['wf:one', 'first'],
        ['wf:two', 'second'],
      ]);
    } finally {
      restore();
    }
  });

  it('supports callback-style chrome.storage APIs', async () => {
    const area = new FakeStorageArea({ callbackStyle: true });
    const restore = installStorageNamespace('chrome', area);
    try {
      const storage = new WebExtensionStorage();
      await storage.put('key', encode('value'));
      expect(decode(await storage.get('key'))).toBe('value');
    } finally {
      restore();
    }
  });

  it('falls back to promise-style WebExtension methods when callback invocation throws', async () => {
    const area = new FakeStorageArea();
    const callbackUnsupportedArea = {
      QUOTA_BYTES: 512,
      QUOTA_BYTES_PER_ITEM: 512,
      get(keys?: string | string[] | null, callback?: (items: Record<string, unknown>) => void) {
        if (callback) throw new Error('callback get unsupported');
        return area.get(keys);
      },
      set(items: Record<string, unknown>, callback?: () => void) {
        if (callback) throw new Error('callback set unsupported');
        return area.set(items);
      },
      remove(keys: string | string[], callback?: () => void) {
        if (callback) throw new Error('callback remove unsupported');
        return area.remove(keys);
      },
      getBytesInUse(keys?: string | string[] | null, callback?: (bytes: number) => void) {
        if (callback) throw new Error('callback bytes unsupported');
        return area.getBytesInUse(keys);
      },
    };
    const restore = installStorageNamespace('browser', callbackUnsupportedArea);
    try {
      const storage = new WebExtensionStorage({ area: 'sync' });
      await storage.put('key', encode('value'));

      expect(decode(await storage.get('key'))).toBe('value');
      expect(await storage.count('k')).toBe(1);
    } finally {
      restore();
    }
  });

  it('rejects when both callback and promise-style WebExtension writes fail', async () => {
    const area = new FakeStorageArea();
    const failingArea = {
      get: area.get.bind(area),
      set() {
        throw new Error('set failed');
      },
      remove: area.remove.bind(area),
      getBytesInUse: area.getBytesInUse.bind(area),
    };
    const restore = installStorageNamespace('browser', failingArea);
    try {
      const storage = new WebExtensionStorage();
      await expect(storage.put('key', encode('value'))).rejects.toThrow('set failed');
    } finally {
      restore();
    }
  });

  it('applies a batch through a single storage-area write', async () => {
    const area = new FakeStorageArea();
    const restore = installStorageNamespace('browser', area);
    try {
      const storage = new WebExtensionStorage();
      const operations: BatchOperation[] = [
        { type: 'put', key: 'a', value: encode('one') },
        { type: 'put', key: 'b', value: encode('two') },
        { type: 'delete', key: 'a' },
      ];

      await storage.batch(operations);

      expect(await storage.get('a')).toBeNull();
      expect(decode(await storage.get('b'))).toBe('two');
      expect(await collect(storage.keys(''))).toEqual(['b']);
      expect(area.data.has('a')).toBe(false);
      expect(area.data.size).toBe(1);
      expect(area.setCallCount).toBe(1);
      expect(area.removeCallCount).toBe(0);
    } finally {
      restore();
    }
  });

  it('rejects user access to the reserved metadata key', async () => {
    const area = new FakeStorageArea();
    const restore = installStorageNamespace('browser', area);
    try {
      const storage = new WebExtensionStorage();
      await expect(storage.get('__weftStorageKeyspace')).rejects.toThrow(
        'reserved for adapter metadata',
      );
      await expect(storage.put('__weftStorageKeyspace', encode('value'))).rejects.toThrow(
        'reserved for adapter metadata',
      );
      await expect(
        storage.batch([
          { type: 'put', key: 'safe', value: encode('safe') },
          { type: 'delete', key: '__weftStorageKeyspace' },
        ]),
      ).rejects.toThrow('reserved for adapter metadata');

      expect(await collect(storage.keys(''))).toEqual([]);
      expect(area.setCallCount).toBe(0);
    } finally {
      restore();
    }
  });

  it('serializes concurrent writes so read-modify-write cycles do not lose data', async () => {
    const area = new FakeStorageArea();
    const restore = installStorageNamespace('browser', area);
    try {
      const storage = new WebExtensionStorage();

      await Promise.all([
        storage.put('a', encode('one')),
        storage.put('b', encode('two')),
        storage.batch([{ type: 'put', key: 'c', value: encode('three') }]),
      ]);

      expect(decode(await storage.get('a'))).toBe('one');
      expect(decode(await storage.get('b'))).toBe('two');
      expect(decode(await storage.get('c'))).toBe('three');
    } finally {
      restore();
    }
  });

  it('removes keys from the logical keyspace when deleting a prefix', async () => {
    const area = new FakeStorageArea();
    const restore = installStorageNamespace('browser', area);
    try {
      const storage = new WebExtensionStorage();
      await storage.put('wf:a', encode('a'));
      await storage.put('wf:b', encode('b'));
      await storage.put('other', encode('c'));

      expect(await storage.deletePrefix('wf:')).toBe(2);

      expect(await collect(storage.keys(''))).toEqual(['other']);
      expect(area.data.has('wf:a')).toBe(false);
      expect(area.data.has('wf:b')).toBe(false);
      expect(area.data.size).toBe(1);
    } finally {
      restore();
    }
  });

  it('rejects writes to managed storage', async () => {
    const area = new FakeStorageArea();
    const restore = installStorageNamespace('browser', area);
    try {
      const storage = new WebExtensionStorage({ area: 'managed' });
      await expect(storage.put('key', encode('value'))).rejects.toThrow(
        'WebExtensionStorage area "managed" is read-only.',
      );
    } finally {
      restore();
    }
  });

  it('rejects deletePrefix on managed storage before deleting anything', async () => {
    const area = new FakeStorageArea();
    // Pre-seed the raw area directly (bypassing the writable guard) so we can
    // prove deletePrefix throws before removing matching keys. The non-mutation
    // assertions inspect the backing map and remove() call count, so the stored
    // shape is irrelevant here.
    area.data.set('wf:a', 'a');
    area.data.set('wf:b', 'b');
    area.data.set('other', 'c');
    const restore = installStorageNamespace('browser', area);
    try {
      const storage = new WebExtensionStorage({ area: 'managed' });

      await expect(storage.deletePrefix('wf:')).rejects.toThrow(
        'WebExtensionStorage area "managed" is read-only.',
      );
      // An empty prefix is still a write attempt and must be rejected up front.
      await expect(storage.deletePrefix('missing:')).rejects.toThrow(
        'WebExtensionStorage area "managed" is read-only.',
      );

      // No keys were removed and remove() was never invoked.
      expect(area.data.has('wf:a')).toBe(true);
      expect(area.data.has('wf:b')).toBe(true);
      expect(area.data.has('other')).toBe(true);
      expect(area.removeCallCount).toBe(0);
    } finally {
      restore();
    }
  });

  it('deletePrefix removes exactly the matching keys and leaves nearby keys intact', async () => {
    const area = new FakeStorageArea();
    const restore = installStorageNamespace('browser', area);
    try {
      const storage = new WebExtensionStorage();
      await storage.put('wf:a', encode('a'));
      await storage.put('wf:b', encode('b'));
      await storage.put('wfx', encode('lexically-adjacent-non-match'));
      await storage.put('other', encode('c'));

      expect(await storage.deletePrefix('wf:')).toBe(2);

      expect(decode(await storage.get('wf:a'))).toBeNull();
      expect(decode(await storage.get('wf:b'))).toBeNull();
      expect(decode(await storage.get('wfx'))).toBe('lexically-adjacent-non-match');
      expect(decode(await storage.get('other'))).toBe('c');
      expect(await collect(storage.keys(''))).toEqual(['other', 'wfx']);
    } finally {
      restore();
    }
  });

  it('keys preserves scan ordering, reverse, and limit through the yield* delegation', async () => {
    const area = new FakeStorageArea();
    const restore = installStorageNamespace('browser', area);
    try {
      const storage = new WebExtensionStorage();
      for (const suffix of ['a', 'b', 'c', 'd']) {
        await storage.put(`wf:${suffix}`, encode(suffix));
      }

      expect(await collect(storage.keys('wf:'))).toEqual(['wf:a', 'wf:b', 'wf:c', 'wf:d']);
      expect(await collect(storage.keys('wf:', { reverse: true }))).toEqual([
        'wf:d',
        'wf:c',
        'wf:b',
        'wf:a',
      ]);
      expect(await collect(storage.keys('wf:', { limit: 2 }))).toEqual(['wf:a', 'wf:b']);
    } finally {
      restore();
    }
  });

  it('fails fast when a sync item exceeds quota', async () => {
    const area = new FakeStorageArea({ quotaBytes: 256, quotaBytesPerItem: 64 });
    const restore = installStorageNamespace('browser', area);
    try {
      const storage = new WebExtensionStorage({ area: 'sync' });
      await expect(storage.put('large', encode('x'.repeat(128)))).rejects.toThrow(
        'WebExtensionStorage sync item quota exceeded',
      );
    } finally {
      restore();
    }
  });

  it('fails fast when a sync write exceeds total quota via getBytesInUse', async () => {
    const area = new FakeStorageArea({ quotaBytes: 150, quotaBytesPerItem: 512 });
    const restore = installStorageNamespace('browser', area);
    try {
      const storage = new WebExtensionStorage({ area: 'sync' });
      await storage.put('small', encode('ok'));

      await expect(storage.put('large', encode('x'.repeat(120)))).rejects.toThrow(
        'WebExtensionStorage sync total quota exceeded',
      );
    } finally {
      restore();
    }
  });

  it('falls back to get-all sizing when getBytesInUse is unavailable', async () => {
    const area = new FakeStorageArea({ quotaBytes: 190, quotaBytesPerItem: 512 });
    const areaWithoutBytes = {
      ...(area.QUOTA_BYTES === undefined ? {} : { QUOTA_BYTES: area.QUOTA_BYTES }),
      ...(area.QUOTA_BYTES_PER_ITEM === undefined
        ? {}
        : { QUOTA_BYTES_PER_ITEM: area.QUOTA_BYTES_PER_ITEM }),
      get: area.get.bind(area),
      set: area.set.bind(area),
      remove: area.remove.bind(area),
    };
    const restore = installStorageNamespace('browser', areaWithoutBytes);
    try {
      const storage = new WebExtensionStorage({ area: 'sync' });
      await storage.put('small', encode('ok'));

      await expect(storage.put('large', encode('x'.repeat(120)))).rejects.toThrow(
        'WebExtensionStorage sync total quota exceeded',
      );
    } finally {
      restore();
    }
  });

  it('deletes existing keys and skips writes for missing keys', async () => {
    const area = new FakeStorageArea();
    const restore = installStorageNamespace('browser', area);
    try {
      const storage = new WebExtensionStorage();
      await storage.put('keep', encode('value'));
      const writesBeforeMissingDelete = area.setCallCount;

      await storage.delete('missing');
      expect(area.setCallCount).toBe(writesBeforeMissingDelete);

      await storage.delete('keep');
      expect(await storage.get('keep')).toBeNull();
    } finally {
      restore();
    }
  });

  it('delegates has, count, scoped, and dispose through the adapter surface', async () => {
    const area = new FakeStorageArea();
    let removeListenerCalls = 0;
    const restore = installStorageNamespace('browser', area, {
      onRemoveListener: () => {
        removeListenerCalls += 1;
      },
    });
    try {
      const storage = new WebExtensionStorage();
      const scoped = storage.scoped('tenant:');
      if (scoped.has === undefined || scoped.count === undefined || scoped.keys === undefined) {
        throw new Error('Scoped storage is missing derived operations.');
      }
      await scoped.put('visible', encode('yes'));
      await storage.put('plain', encode('no'));

      expect(await scoped.has('visible')).toBe(true);
      expect(await storage.has('tenant:visible')).toBe(true);
      expect(await scoped.count('')).toBe(1);
      expect(await collect(scoped.keys(''))).toEqual(['visible']);

      storage[Symbol.dispose]();
      expect(removeListenerCalls).toBe(1);
    } finally {
      restore();
    }
  });
});
