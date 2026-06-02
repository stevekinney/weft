import { describe, expect, it } from 'bun:test';

import { storageBackends, teardown } from '../testing/storage-backends.test-support.ts';
import type { Storage } from './interface.ts';
import { MemoryStorage } from './memory.ts';
import {
  type ConditionalTextValueStore,
  type TextValueStore,
  textValueStore,
} from './text-value-store.ts';

function createCoreStorageAdapter(): Storage {
  const storage = new MemoryStorage();

  return {
    capabilities: storage.capabilities.bind(storage),
    get: storage.get.bind(storage),
    put: storage.put.bind(storage),
    delete: storage.delete.bind(storage),
    scan: storage.scan.bind(storage),
    batch: storage.batch.bind(storage),
    [Symbol.dispose]: storage[Symbol.dispose].bind(storage),
  };
}

describe('textValueStore (MemoryStorage)', () => {
  it('round-trips ASCII text', async () => {
    await using base = new MemoryStorage();
    const store = textValueStore(base);

    await store.set('greeting', 'hello');
    expect(await store.get('greeting')).toBe('hello');
  });

  it('round-trips multibyte UTF-8 and surrogate-pair emoji', async () => {
    await using base = new MemoryStorage();
    const store = textValueStore(base);

    await store.set('multibyte', 'こんにちは');
    await store.set('emoji', 'hello 🌍 🇺🇸 👨‍👩‍👧');

    expect(await store.get('multibyte')).toBe('こんにちは');
    expect(await store.get('emoji')).toBe('hello 🌍 🇺🇸 👨‍👩‍👧');
  });

  it('round-trips a leading BOM (U+FEFF) without dropping it', async () => {
    await using base = new MemoryStorage();
    const store = textValueStore(base);

    const withBom = '﻿hello';
    await store.set('bom', withBom);
    expect(await store.get('bom')).toBe(withBom);
  });

  it('round-trips the empty string distinguishably from null', async () => {
    await using base = new MemoryStorage();
    const store = textValueStore(base);

    await store.set('empty', '');
    expect(await store.get('empty')).toBe('');
    expect(await store.get('missing')).toBeNull();
  });

  it('throws when bytes written through the raw Storage are not valid UTF-8', async () => {
    await using base = new MemoryStorage();
    const store = textValueStore(base);

    // Lone continuation byte (0x80) — invalid UTF-8.
    await base.put('corrupt', new Uint8Array([0x80]));

    await expect(store.get('corrupt')).rejects.toThrow();
  });

  it('lists keys under a prefix as an array', async () => {
    await using base = new MemoryStorage();
    const store = textValueStore(base);

    await store.set('jobs:1', 'a');
    await store.set('jobs:2', 'b');
    await store.set('other:1', 'c');

    const jobs = await store.list('jobs:');
    expect(jobs.toSorted()).toEqual(['jobs:1', 'jobs:2']);
    expect(await store.list('missing:')).toEqual([]);
  });

  it('list returns every key when prefix is empty', async () => {
    await using base = new MemoryStorage();
    const store = textValueStore(base);

    await store.set('a', '1');
    await store.set('b', '2');

    const keys = await store.list('');
    expect(keys.toSorted()).toEqual(['a', 'b']);
  });

  it('preserves the underlying scan order for list()', async () => {
    await using base = new MemoryStorage();
    const store = textValueStore(base);

    await store.set('jobs:b', 'b');
    await store.set('jobs:a', 'a');
    await store.set('jobs:c', 'c');

    // MemoryStorage scans lexicographically; that ordering should flow through.
    expect(await store.list('jobs:')).toEqual(['jobs:a', 'jobs:b', 'jobs:c']);
  });

  it('delete removes a single key', async () => {
    await using base = new MemoryStorage();
    const store = textValueStore(base);

    await store.set('temp', 'value');
    await store.delete('temp');

    expect(await store.get('temp')).toBeNull();
  });

  it('has reports existence', async () => {
    await using base = new MemoryStorage();
    const store = textValueStore(base);

    await store.set('here', 'yes');
    expect(await store.has('here')).toBe(true);
    expect(await store.has('not-here')).toBe(false);
  });

  it('deletePrefix removes all matching keys and returns the count', async () => {
    await using base = new MemoryStorage();
    const store = textValueStore(base);

    await store.set('jobs:1', 'a');
    await store.set('jobs:2', 'b');
    await store.set('other:1', 'c');

    expect(await store.deletePrefix('jobs:')).toBe(2);
    expect(await store.list('jobs:')).toEqual([]);
    expect(await store.has('other:1')).toBe(true);
  });

  it('deletePrefix returns 0 when no keys match', async () => {
    await using base = new MemoryStorage();
    const store = textValueStore(base);

    expect(await store.deletePrefix('nonexistent:')).toBe(0);
  });

  it('close disposes the underlying storage', async () => {
    const base = new MemoryStorage();
    const store = textValueStore(base);

    await store.set('k', 'v');
    await store.close();

    // MemoryStorage's dispose clears state; a fresh get should now be empty.
    expect(await base.get('k')).toBeNull();
  });

  it('can close without disposing shared underlying storage', async () => {
    const base = new MemoryStorage();
    const store = textValueStore(base, { disposeUnderlyingStorage: false });

    await store.set('k', 'v');
    await store.close();

    expect(await store.get('k')).toBe('v');
    expect(new TextDecoder().decode((await base.get('k'))!)).toBe('v');
  });

  it('conditionalBatch encodes text conditions and set operations', async () => {
    await using base = new MemoryStorage();
    const store: ConditionalTextValueStore = textValueStore(base);

    await store.set('session:1', 'open');

    const committed = await store.conditionalBatch(
      [{ key: 'session:1', expectedValue: 'open' }],
      [
        { type: 'set', key: 'session:1', value: 'closed' },
        { type: 'delete', key: 'session:old' },
      ],
    );

    expect(committed).toBe(true);
    expect(await store.get('session:1')).toBe('closed');

    const stale = await store.conditionalBatch(
      [{ key: 'session:1', expectedValue: 'open' }],
      [{ type: 'set', key: 'session:1', value: 'stale-write' }],
    );

    expect(stale).toBe(false);
    expect(await store.get('session:1')).toBe('closed');
  });

  it('keeps the base TextValueStore type source-compatible without conditionalBatch', () => {
    const store: TextValueStore = {
      async get() {
        return null;
      },
      async set() {},
      async delete() {},
      async list() {
        return [];
      },
      async has() {
        return false;
      },
      async deletePrefix() {
        return 0;
      },
      async close() {},
    };

    expect(typeof store.set).toBe('function');
  });
});

describe('textValueStore (minimal Storage without optional methods)', () => {
  it('has() falls back to get() when adapter omits has()', async () => {
    const base = createCoreStorageAdapter();
    const store = textValueStore(base);

    await store.set('a', 'value');
    expect(await store.has('a')).toBe(true);
    expect(await store.has('missing')).toBe(false);
  });

  it('deletePrefix() falls back to scan + batch when adapter omits deletePrefix()', async () => {
    const base = createCoreStorageAdapter();
    const store = textValueStore(base);

    await store.set('jobs:1', 'a');
    await store.set('jobs:2', 'b');
    await store.set('keep:1', 'c');

    expect(await store.deletePrefix('jobs:')).toBe(2);
    expect(await store.has('jobs:1')).toBe(false);
    expect(await store.has('jobs:2')).toBe(false);
    expect(await store.has('keep:1')).toBe(true);
  });

  it('deletePrefix() fallback returns 0 when no keys match', async () => {
    const base = createCoreStorageAdapter();
    const store = textValueStore(base);

    expect(await store.deletePrefix('nonexistent:')).toBe(0);
  });

  it('list() falls back to scan when adapter omits keys()', async () => {
    const base = createCoreStorageAdapter();
    const store = textValueStore(base);

    await store.set('jobs:a', '1');
    await store.set('jobs:b', '2');

    const keys = await store.list('jobs:');
    expect(keys.toSorted()).toEqual(['jobs:a', 'jobs:b']);
  });
});

for (const backend of storageBackends) {
  describe(`textValueStore (${backend.name})`, () => {
    it('round-trips UTF-8 text and lists keys under a prefix', async () => {
      const { storage, cleanup } = backend.factory();
      try {
        const store = textValueStore(storage);

        await store.set('jobs:a', 'hello');
        await store.set('jobs:b', 'こんにちは 🌍');

        expect(await store.get('jobs:a')).toBe('hello');
        expect(await store.get('jobs:b')).toBe('こんにちは 🌍');

        const listed = await store.list('jobs:');
        expect(listed.toSorted()).toEqual(['jobs:a', 'jobs:b']);

        expect(await store.deletePrefix('jobs:')).toBe(2);
        expect(await store.list('jobs:')).toEqual([]);
      } finally {
        await teardown(undefined, cleanup);
      }
    });
  });
}
