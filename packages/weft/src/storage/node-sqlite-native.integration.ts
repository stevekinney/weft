import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { NodeSQLiteStorage } from './node-sqlite.ts';

await describe('NodeSQLiteStorage (integration)', async () => {
  let storage: NodeSQLiteStorage;

  beforeEach(() => {
    storage = new NodeSQLiteStorage(':memory:');
  });

  afterEach(() => {
    storage[Symbol.dispose]();
  });

  await describe('get / put / delete', async () => {
    await it('returns null for a missing key', async () => {
      assert.equal(await storage.get('missing'), null);
    });

    await it('stores and retrieves a value', async () => {
      const value = new Uint8Array([1, 2, 3]);
      await storage.put('key1', value);
      const result = await storage.get('key1');
      assert.deepEqual(result, value);
    });

    await it('overwrites an existing key', async () => {
      await storage.put('key1', new Uint8Array([1]));
      await storage.put('key1', new Uint8Array([2]));
      const result = await storage.get('key1');
      assert.deepEqual(result, new Uint8Array([2]));
    });

    await it('deletes a key', async () => {
      await storage.put('key1', new Uint8Array([1]));
      await storage.delete('key1');
      assert.equal(await storage.get('key1'), null);
    });

    await it('delete on missing key is a no-op', async () => {
      // Should not throw.
      await storage.delete('nonexistent');
    });
  });

  await describe('scan', async () => {
    beforeEach(async () => {
      await storage.put('a:1', new Uint8Array([1]));
      await storage.put('a:2', new Uint8Array([2]));
      await storage.put('a:3', new Uint8Array([3]));
      await storage.put('b:1', new Uint8Array([4]));
    });

    await it('scans all keys with a matching prefix', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:')) {
        results.push(entry);
      }
      assert.equal(results.length, 3);
      assert.equal(results[0]![0], 'a:1');
      assert.equal(results[1]![0], 'a:2');
      assert.equal(results[2]![0], 'a:3');
    });

    await it('respects limit', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { limit: 2 })) {
        results.push(entry);
      }
      assert.equal(results.length, 2);
    });

    await it('supports reverse ordering', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { reverse: true })) {
        results.push(entry);
      }
      assert.equal(results[0]![0], 'a:3');
      assert.equal(results[2]![0], 'a:1');
    });

    await it('supports gt option', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { gt: 'a:1' })) {
        results.push(entry);
      }
      assert.equal(results.length, 2);
      assert.equal(results[0]![0], 'a:2');
    });

    await it('supports lt option', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { lt: 'a:3' })) {
        results.push(entry);
      }
      assert.equal(results.length, 2);
      assert.equal(results[1]![0], 'a:2');
    });

    await it('supports gte option', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { gte: 'a:2' })) {
        results.push(entry);
      }
      assert.equal(results.length, 2);
      assert.equal(results[0]![0], 'a:2');
    });

    await it('supports lte option', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { lte: 'a:2' })) {
        results.push(entry);
      }
      assert.equal(results.length, 2);
      assert.equal(results[1]![0], 'a:2');
    });

    await it('returns empty for non-matching prefix', async () => {
      const results: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('z:')) {
        results.push(entry);
      }
      assert.equal(results.length, 0);
    });

    await it('caches scan statements', async () => {
      // Run two scans with the same shape but different parameters.
      const results1: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { limit: 1 })) {
        results1.push(entry);
      }
      const results2: [string, Uint8Array][] = [];
      for await (const entry of storage.scan('a:', { limit: 2 })) {
        results2.push(entry);
      }

      // Same SQL shape → single cache entry.
      assert.equal(storage.scanStatementCacheSize, 1);
      assert.equal(results1.length, 1);
      assert.equal(results2.length, 2);
    });
  });

  await describe('batch', async () => {
    await it('applies multiple operations atomically', async () => {
      await storage.batch([
        { type: 'put', key: 'k1', value: new Uint8Array([10]) },
        { type: 'put', key: 'k2', value: new Uint8Array([20]) },
        { type: 'put', key: 'k3', value: new Uint8Array([30]) },
      ]);

      assert.deepEqual(await storage.get('k1'), new Uint8Array([10]));
      assert.deepEqual(await storage.get('k2'), new Uint8Array([20]));
      assert.deepEqual(await storage.get('k3'), new Uint8Array([30]));
    });

    await it('handles mixed put and delete operations', async () => {
      await storage.put('existing', new Uint8Array([1]));
      await storage.batch([
        { type: 'put', key: 'new', value: new Uint8Array([2]) },
        { type: 'delete', key: 'existing' },
      ]);

      assert.deepEqual(await storage.get('new'), new Uint8Array([2]));
      assert.equal(await storage.get('existing'), null);
    });

    await it('handles empty batch', async () => {
      // Should not throw.
      await storage.batch([]);
    });
  });

  await describe('conditionalBatch', async () => {
    await it('commits operations when every condition matches', async () => {
      await storage.put('expected', new Uint8Array([1]));

      const committed = await storage.conditionalBatch(
        [{ key: 'expected', expectedValue: new Uint8Array([1]) }],
        [{ type: 'put', key: 'written', value: new Uint8Array([2]) }],
      );

      assert.equal(committed, true);
      assert.deepEqual(await storage.get('written'), new Uint8Array([2]));
    });

    await it('returns false and skips writes when a condition does not match', async () => {
      await storage.put('expected', new Uint8Array([1]));

      const committed = await storage.conditionalBatch(
        [{ key: 'expected', expectedValue: new Uint8Array([9]) }],
        [{ type: 'put', key: 'skipped', value: new Uint8Array([2]) }],
      );

      assert.equal(committed, false);
      assert.equal(await storage.get('skipped'), null);
    });

    await it('supports delete operations inside a committed conditional batch', async () => {
      await storage.put('delete-me', new Uint8Array([1]));

      const committed = await storage.conditionalBatch(
        [{ key: 'missing', expectedValue: null }],
        [{ type: 'delete', key: 'delete-me' }],
      );

      assert.equal(committed, true);
      assert.equal(await storage.get('delete-me'), null);
    });
  });

  await describe('dispose', async () => {
    await it('closes the database cleanly', () => {
      const instance = new NodeSQLiteStorage(':memory:');
      // Should not throw.
      instance[Symbol.dispose]();
    });
  });
});
