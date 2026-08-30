import { describe, expect, it } from 'bun:test';

import type { BatchOperation, ConditionalBatchCondition, Storage } from './interface.ts';
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

class RecordingStorage extends MemoryStorage {
  batches: BatchOperation[][] = [];
  conditionalBatches: {
    conditions: ConditionalBatchCondition[];
    operations: BatchOperation[];
  }[] = [];

  override async batch(operations: BatchOperation[]): Promise<void> {
    this.batches.push(operations);
    await super.batch(operations);
  }

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    this.conditionalBatches.push({ conditions, operations });
    return super.conditionalBatch(conditions, operations);
  }
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

    const scoped = storage.scoped('scope');

    await scoped.put('profile', encode('alice'));

    expect(decode((await storage.get('scope:profile'))!)).toBe('alice');
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

    const scoped = storage.scoped('scope');

    await storage.batch([
      { type: 'put', key: 'scope:item:1', value: encode('1') },
      { type: 'put', key: 'scope:item:2', value: encode('2') },
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

  it('storage.scoped(prefix) forwards deleteRange, translating bounds within the namespace only', async () => {
    const storage = new MemoryStorage();
    const scoped = storage.scoped('scope');

    await writeEntries(storage, [
      { type: 'put', key: 'scope:item:1', value: encode('1') },
      { type: 'put', key: 'scope:item:2', value: encode('2') },
      { type: 'put', key: 'scope:item:3', value: encode('3') },
      { type: 'put', key: 'other:item:2', value: encode('outside') },
    ]);

    if (!scoped.deleteRange) {
      throw new Error('Scoped storage should expose deleteRange(prefix, options).');
    }

    // Public bound 'item:3' is translated to inner 'scope:item:3'; the delete
    // must not touch the unscoped 'other:item:2'.
    expect(await scoped.deleteRange('item:', { lt: 'item:3' })).toBe(2);
    expect(await scoped.get('item:1')).toBeNull();
    expect(await scoped.get('item:2')).toBeNull();
    expect(await scoped.get('item:3')).toEqual(encode('3'));
    expect(await storage.get('other:item:2')).toEqual(encode('outside'));
  });

  it('storage.scoped(prefix).deleteRange ignores a smuggled reverse flag', async () => {
    const storage = new MemoryStorage();
    const scoped = storage.scoped('scope');

    await writeEntries(
      storage,
      [1, 2, 3, 4].map((n) => ({
        type: 'put' as const,
        key: `scope:item:${n}`,
        value: encode(String(n)),
      })),
    );

    // reverse must not flip which keys the limit selects: still the lowest two.
    await scoped.deleteRange!('item:', {
      gte: 'item:1',
      limit: 2,
      reverse: true,
    } as never);
    expect(await scoped.get('item:1')).toBeNull();
    expect(await scoped.get('item:2')).toBeNull();
    expect(await scoped.get('item:3')).toEqual(encode('3'));
    expect(await scoped.get('item:4')).toEqual(encode('4'));
  });

  it.each([
    ['gt', { gt: 'item:1' }, ['item:2', 'item:3', 'item:4'], ['item:1']],
    ['gte', { gte: 'item:2' }, ['item:2', 'item:3', 'item:4'], ['item:1']],
    ['lt', { lt: 'item:4' }, ['item:1', 'item:2', 'item:3'], ['item:4']],
    ['lte', { lte: 'item:3' }, ['item:1', 'item:2', 'item:3'], ['item:4']],
  ] as const)(
    'rewrites the %s bound consistently across range operations',
    async (_, options, expected, remaining) => {
      const storage = new MemoryStorage();
      const outer = storage.scoped('outer');
      if (!outer?.scoped) throw new Error('Scoped storage should support nested scopes.');
      const scoped = outer.scoped('inner');
      if (!scoped.keys || !scoped.deleteRange) {
        throw new Error('Scoped storage should expose keys and deleteRange.');
      }
      const expectedKeys = [...expected];
      const remainingKeys = [...remaining];

      await writeEntries(storage, [
        ...[1, 2, 3, 4].map((n) => ({
          type: 'put' as const,
          key: `outer:inner:item:${n}`,
          value: encode(String(n)),
        })),
        { type: 'put', key: 'outer:other:item:2', value: encode('outside') },
      ]);

      expect(await collect(scoped.keys('item:', { ...options, limit: 3 }))).toEqual(expectedKeys);
      expect(await collect(scoped.scan('item:', { ...options, limit: 3 }))).toEqual(
        expectedKeys.map((key) => [key, encode(key.slice(-1))]),
      );

      expect(await scoped.deleteRange('item:', { ...options, limit: 3 })).toBe(3);
      expect(await collect(scoped.keys('item:'))).toEqual(remainingKeys);
      expect(await storage.get('outer:other:item:2')).toEqual(encode('outside'));
    },
  );

  it('storage.scoped(prefix) translates bounds, reverse ordering, and limit within the namespace', async () => {
    const storage = new MemoryStorage();
    if (!storage.scoped) {
      throw new Error('MemoryStorage should expose storage.scoped(prefix).');
    }

    await writeEntries(storage, [
      { type: 'put', key: 'scope:item:1', value: encode('1') },
      { type: 'put', key: 'scope:item:2', value: encode('2') },
      { type: 'put', key: 'scope:item:3', value: encode('3') },
      { type: 'put', key: 'scope:item:4', value: encode('4') },
      { type: 'put', key: 'other:item:3', value: encode('outside') },
    ]);

    const scoped = storage.scoped('scope');
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
    const scoped = scopedStorage(storage, 'scope');

    await writeEntries(storage, [
      { type: 'put', key: 'scope:item:1', value: encode('1') },
      { type: 'put', key: 'scope:item:2', value: encode('2') },
      { type: 'put', key: 'other:item:3', value: encode('3') },
    ]);

    expect(await scoped.has('item:1')).toBe(true);
    expect(await collect(scoped.keys('item:'))).toEqual(['item:1', 'item:2']);
    expect(await scoped.count('item:')).toBe(2);
    expect(await scoped.deleteRange('item:', { gt: 'item:1' })).toBe(1); // fallback path: only item:2
    expect(await scoped.deletePrefix('item:')).toBe(1); // item:1 remains
    expect(await storage.get('other:item:3')).toEqual(encode('3'));
  });

  it('scopedStorage(storage, prefix) forwards put, delete, batch, count, and dispose for core adapters', async () => {
    const storage = createCoreStorageAdapter();
    const scoped = scopedStorage(storage, 'scope');

    await scoped.put('single', encode('one'));
    expect(decode((await storage.get('scope:single'))!)).toBe('one');

    await scoped.delete('single');
    expect(await storage.get('scope:single')).toBeNull();

    await scoped.batch([
      { type: 'put', key: 'batch:a', value: encode('a') },
      { type: 'delete', key: 'batch:missing' },
    ]);

    expect(await storage.get('scope:batch:a')).toEqual(encode('a'));
    expect(await scoped.count('batch:')).toBe(1);

    expect(() => scoped[Symbol.dispose]()).not.toThrow();
  });

  it('forwards delete, batch key rewriting, and dispose through a full adapter', async () => {
    const adapter = createFullStorageAdapter();
    const scoped = scopedStorage(adapter.storage, 'scope');

    await scoped.batch([
      { type: 'put', key: 'item:1', value: encode('1') },
      { type: 'put', key: 'item:2', value: encode('2') },
    ]);

    expect(await adapter.inner.get('scope:item:1')).toEqual(encode('1'));
    expect(await adapter.inner.get('scope:item:2')).toEqual(encode('2'));

    await scoped.delete('item:1');
    expect(await adapter.inner.get('scope:item:1')).toBeNull();

    scoped[Symbol.dispose]();
    expect(adapter.wasDisposed()).toBe(true);
  });

  it('forwards conditionalBatch, rewriting condition and operation keys into the namespace', async () => {
    const inner = new MemoryStorage();
    const scoped = scopedStorage(inner, 'scope');

    await scoped.put('counter', encode('start'));

    // Mismatched precondition: nothing applies, returns false.
    expect(
      await scoped.conditionalBatch(
        [{ key: 'counter', expectedValue: encode('wrong') }],
        [{ type: 'put', key: 'counter', value: encode('changed') }],
      ),
    ).toBe(false);
    expect(decode((await scoped.get('counter'))!)).toBe('start');

    // Matching precondition: a put and a delete both rewrite into the namespace.
    await scoped.put('stale', encode('old'));
    expect(
      await scoped.conditionalBatch(
        [{ key: 'counter', expectedValue: encode('start') }],
        [
          { type: 'put', key: 'counter', value: encode('next') },
          { type: 'delete', key: 'stale' },
        ],
      ),
    ).toBe(true);
    expect(decode((await scoped.get('counter'))!)).toBe('next');
    expect(await scoped.get('stale')).toBeNull();
    // Writes landed under the scope prefix in the inner store.
    expect(decode((await inner.get('scope:counter'))!)).toBe('next');
    expect(await inner.get('scope:stale')).toBeNull();
  });

  it('shares operation rewriting while preserving order, values, and empty scoped keys', async () => {
    const inner = new RecordingStorage();
    const scoped = scopedStorage(inner, 'scope:');
    const firstValue = encode('first');
    const secondValue = encode('second');
    const operations: BatchOperation[] = [
      { type: 'put', key: '', value: firstValue },
      { type: 'delete', key: 'middle' },
      { type: 'put', key: 'last', value: secondValue },
    ];

    await scoped.batch(operations);

    expect(inner.batches).toHaveLength(1);
    expect(inner.batches[0]).toEqual([
      { type: 'put', key: 'scope:', value: firstValue },
      { type: 'delete', key: 'scope:middle' },
      { type: 'put', key: 'scope:last', value: secondValue },
    ]);
    expect(inner.batches[0]![0]).toMatchObject({ value: firstValue });
    expect(inner.batches[0]![2]).toMatchObject({ value: secondValue });

    const expectedValue = encode('first');
    expect(
      await scoped.conditionalBatch(
        [{ key: '', expectedValue }],
        [{ type: 'delete', key: 'last' }],
      ),
    ).toBe(true);

    expect(inner.conditionalBatches).toHaveLength(1);
    expect(inner.conditionalBatches[0]).toEqual({
      conditions: [{ key: 'scope:', expectedValue }],
      operations: [{ type: 'delete', key: 'scope:last' }],
    });
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
