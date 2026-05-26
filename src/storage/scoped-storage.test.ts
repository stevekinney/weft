import { describe, expect, it } from 'bun:test';

import type { BatchOperation, Storage } from './interface.ts';
import { MemoryStorage } from './memory.ts';
import { scopedStorage } from './scoped-storage.ts';
import {
  collect,
  createCoreStorageAdapter,
  createFullStorageAdapter,
} from './storage-adapter.test-support.ts';

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

async function writeEntries(storage: Storage, operations: BatchOperation[]): Promise<void> {
  await storage.batch(operations);
}

describe('scopedStorage', () => {
  it('storage.scoped(prefix) prefixes writes and strips prefixes on reads', async () => {
    const storage = new MemoryStorage();
    if (!storage.scoped) {
      throw new Error('MemoryStorage should expose storage.scoped(prefix).');
    }

    const scoped = storage.scoped('tenant');

    await scoped.put('profile', encode('alice'));

    expect(decode((await storage.get('tenant:profile'))!)).toBe('alice');
    expect(decode((await scoped.get('profile'))!)).toBe('alice');

    const scannedEntries = await collect(scoped.scan(''));
    expect(scannedEntries).toEqual([['profile', encode('alice')]]);
  });

  it("storage.scoped('a').scoped('b') composes under a:b: prefixes", async () => {
    const storage = new MemoryStorage();
    const firstScope = storage.scoped?.('a');
    if (!firstScope?.scoped) {
      throw new Error('Scoped storage should support nested storage.scoped(prefix) calls.');
    }

    const nested = firstScope.scoped('b');
    if (!nested.keys) {
      throw new Error('Nested scoped storage should expose keys(prefix, options?).');
    }

    await nested.put('key', encode('value'));

    expect(decode((await storage.get('a:b:key'))!)).toBe('value');
    expect(await collect(nested.keys(''))).toEqual(['key']);
  });

  it('storage.scoped(prefix) forwards deletePrefix and count within the namespace only', async () => {
    const storage = new MemoryStorage();
    if (!storage.scoped) {
      throw new Error('MemoryStorage should expose storage.scoped(prefix).');
    }

    const scoped = storage.scoped('tenant');

    await storage.batch([
      { type: 'put', key: 'tenant:item:1', value: encode('1') },
      { type: 'put', key: 'tenant:item:2', value: encode('2') },
      { type: 'put', key: 'other:item:3', value: encode('3') },
    ]);

    if (!scoped.count || !scoped.deletePrefix) {
      throw new Error('Scoped storage should expose count(prefix) and deletePrefix(prefix).');
    }

    expect(await scoped.count('item:')).toBe(2);
    expect(await scoped.deletePrefix('item:')).toBe(2);
    expect(await storage.get('other:item:3')).toEqual(encode('3'));
    expect(await scoped.count('item:')).toBe(0);
  });

  it('storage.scoped(prefix) translates bounds, reverse ordering, and limit within the namespace', async () => {
    const storage = new MemoryStorage();
    if (!storage.scoped) {
      throw new Error('MemoryStorage should expose storage.scoped(prefix).');
    }

    await writeEntries(storage, [
      { type: 'put', key: 'tenant:item:1', value: encode('1') },
      { type: 'put', key: 'tenant:item:2', value: encode('2') },
      { type: 'put', key: 'tenant:item:3', value: encode('3') },
      { type: 'put', key: 'tenant:item:4', value: encode('4') },
      { type: 'put', key: 'other:item:3', value: encode('outside') },
    ]);

    const scoped = storage.scoped('tenant');
    if (!scoped.keys) {
      throw new Error('Scoped storage should expose keys(prefix, options?).');
    }

    expect(
      await collect(scoped.keys('item:', { gt: 'item:1', lte: 'item:3', reverse: true, limit: 1 })),
    ).toEqual(['item:3']);
    expect(
      await collect(scoped.scan('item:', { gte: 'item:2', lt: 'item:4', reverse: true, limit: 1 })),
    ).toEqual([['item:3', encode('3')]]);
  });

  it('scopedStorage(storage, prefix) falls back to core-five storage implementations', async () => {
    const storage = createCoreStorageAdapter();
    const scoped = scopedStorage(storage, 'tenant');

    await writeEntries(storage, [
      { type: 'put', key: 'tenant:item:1', value: encode('1') },
      { type: 'put', key: 'tenant:item:2', value: encode('2') },
      { type: 'put', key: 'other:item:3', value: encode('3') },
    ]);

    expect(await scoped.has('item:1')).toBe(true);
    expect(await collect(scoped.keys('item:'))).toEqual(['item:1', 'item:2']);
    expect(await scoped.count('item:')).toBe(2);
    expect(await scoped.deletePrefix('item:')).toBe(2);
    expect(await storage.get('other:item:3')).toEqual(encode('3'));
  });

  it('scopedStorage(storage, prefix) forwards put, delete, batch, count, and dispose for core adapters', async () => {
    const storage = createCoreStorageAdapter();
    const scoped = scopedStorage(storage, 'tenant');

    await scoped.put('single', encode('one'));
    expect(decode((await storage.get('tenant:single'))!)).toBe('one');

    await scoped.delete('single');
    expect(await storage.get('tenant:single')).toBeNull();

    await scoped.batch([
      { type: 'put', key: 'batch:a', value: encode('a') },
      { type: 'delete', key: 'batch:missing' },
    ]);

    expect(await storage.get('tenant:batch:a')).toEqual(encode('a'));
    expect(await scoped.count('batch:')).toBe(1);

    expect(() => scoped[Symbol.dispose]()).not.toThrow();
  });

  it('forwards delete, batch key rewriting, and dispose through a full adapter', async () => {
    const adapter = createFullStorageAdapter();
    const scoped = scopedStorage(adapter.storage, 'tenant');

    await scoped.batch([
      { type: 'put', key: 'item:1', value: encode('1') },
      { type: 'put', key: 'item:2', value: encode('2') },
    ]);

    expect(await adapter.inner.get('tenant:item:1')).toEqual(encode('1'));
    expect(await adapter.inner.get('tenant:item:2')).toEqual(encode('2'));

    await scoped.delete('item:1');
    expect(await adapter.inner.get('tenant:item:1')).toBeNull();

    scoped[Symbol.dispose]();
    expect(adapter.wasDisposed()).toBe(true);
  });
});

describe('scopedStorage capabilities()', () => {
  it('delegates verbatim to the inner store', () => {
    const inner = new MemoryStorage();
    const scoped = scopedStorage(inner, 'tenant');
    expect(scoped.capabilities()).toEqual(inner.capabilities());
  });

  it('reflects a downgraded inner capability profile unchanged', () => {
    const core = createCoreStorageAdapter();
    const scoped = scopedStorage(core, 'tenant');
    // ScopedStorage only rewrites keys, so it must not alter any capability.
    expect(scoped.capabilities()).toEqual(core.capabilities());
    expect(scoped.capabilities().conditionalBatch).toBe(false);
  });
});
