/**
 * Cross-backend regression for prefix operations whose range has no upper bound.
 *
 * An empty prefix matches every key, but its range end used to be the sentinel
 * `'\xff'`, so every backend dropped keys that sort above it: any key starting
 * with a character past U+00FF, such as a CJK character or an emoji. These
 * tests write `a`, `é`, `日` and `😀`, which sort in that order under both
 * UTF-8 byte order (SQLite, PostgreSQL's `"C"` collation, LMDB) and UTF-16
 * code-unit order (in-memory, IndexedDB), and expect every operation on the
 * empty prefix to see all four.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import {
  storageCount,
  storageDeletePrefix,
  storageDeleteRange,
  storageKeys,
  type Storage,
} from "../embedded/storage/src/index.ts";
import {
  collectKeys,
  storageBackends,
  teardown,
} from '../testing/storage-backends.test-support.ts';

const keysInOrder = ['a', 'é', '日', '😀'];

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iterable) results.push(item);
  return results;
}

for (const backend of storageBackends) {
  describe(`empty-prefix operations over non-ASCII leading characters [${backend.name}]`, () => {
    let cleanup: (() => void | Promise<void>) | undefined;

    async function createPopulatedStorage(): Promise<Storage> {
      const created = backend.factory();
      cleanup = created.cleanup;
      for (const key of keysInOrder) {
        await created.storage.put(key, encode(`value:${key}`));
      }
      return created.storage;
    }

    afterEach(async () => {
      await teardown(undefined, cleanup);
      cleanup = undefined;
    });

    it('keys returns every key, in both directions and under limit', async () => {
      const active = await createPopulatedStorage();

      expect(await collectKeys(active, '')).toEqual(keysInOrder);
      expect(await collect(storageKeys(active, '', { reverse: true }))).toEqual(
        keysInOrder.toReversed(),
      );
      expect(await collect(storageKeys(active, '', { limit: 3 }))).toEqual(['a', 'é', '日']);
      expect(await collect(storageKeys(active, '', { reverse: true, limit: 2 }))).toEqual([
        '😀',
        '日',
      ]);
    });

    it('count and scan cover every key, values included, in both directions', async () => {
      const active = await createPopulatedStorage();

      expect(await storageCount(active, '')).toBe(keysInOrder.length);

      const forward = await collect(active.scan(''));
      expect(forward.map(([key]) => key)).toEqual(keysInOrder);
      expect(forward.map(([, value]) => new TextDecoder().decode(value))).toEqual(
        keysInOrder.map((key) => `value:${key}`),
      );
      const reversed = await collect(active.scan('', { reverse: true }));
      expect(reversed.map(([key]) => key)).toEqual(keysInOrder.toReversed());
    });

    it('scan and keys honour gt and lte bounds on an empty prefix', async () => {
      const active = await createPopulatedStorage();

      expect(await collect(storageKeys(active, '', { gt: 'é' }))).toEqual(['日', '😀']);
      expect(await collect(storageKeys(active, '', { gte: 'é', lte: '日' }))).toEqual(['é', '日']);
      const afterCjk = await collect(active.scan('', { gt: '日' }));
      expect(afterCjk.map(([key]) => key)).toEqual(['😀']);
    });

    it('deleteRange with only a lower bound deletes through the last key', async () => {
      const active = await createPopulatedStorage();

      expect(await storageDeleteRange(active, '', { gte: 'é' })).toBe(3);
      expect(await collectKeys(active, '')).toEqual(['a']);
    });

    it('deleteRange with only an upper bound deletes from the first key', async () => {
      const active = await createPopulatedStorage();

      expect(await storageDeleteRange(active, '', { lte: '日' })).toBe(3);
      expect(await collectKeys(active, '')).toEqual(['😀']);
    });

    it('deleteRange on the empty prefix deletes the lowest keys first under a limit', async () => {
      const active = await createPopulatedStorage();

      expect(await storageDeleteRange(active, '', { gte: 'é', limit: 2 })).toBe(2);
      expect(await collectKeys(active, '')).toEqual(['a', '😀']);
    });

    it('deletePrefix on the empty prefix deletes every key', async () => {
      const active = await createPopulatedStorage();

      expect(await storageDeletePrefix(active, '')).toBe(keysInOrder.length);
      expect(await collectKeys(active, '')).toEqual([]);
      expect(await storageCount(active, '')).toBe(0);
    });
  });
}
