import { describe, expect, it } from 'bun:test';

import { storageBackends } from '../testing/storage-backends.ts';

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

for (const backend of storageBackends) {
  describe(`${backend.name} storage ergonomics`, () => {
    it('Storage.has(key) returns true for existing keys across built-in adapters', async () => {
      const { storage, cleanup } = backend.factory();

      try {
        expect(storage.has).toBeDefined();

        await storage.put('has:present', encode('value'));

        expect(await storage.has?.('has:present')).toBe(true);
        expect(await storage.has?.('has:missing')).toBe(false);
      } finally {
        cleanup();
      }
    });

    it('Storage.keys(prefix, options?) returns matching keys without values across built-in adapters', async () => {
      const { storage, cleanup } = backend.factory();

      try {
        expect(storage.keys).toBeDefined();

        await storage.batch([
          { type: 'put', key: 'keys:a', value: encode('a') },
          { type: 'put', key: 'keys:b', value: encode('b') },
          { type: 'put', key: 'keys:c', value: encode('c') },
          { type: 'put', key: 'other:z', value: encode('z') },
        ]);

        const matchingKeys = await collect(storage.keys!('keys:', { gt: 'keys:a', reverse: true }));

        expect(matchingKeys).toEqual(['keys:c', 'keys:b']);
      } finally {
        cleanup();
      }
    });

    it('Storage.count(prefix) returns the number of matching keys across built-in adapters', async () => {
      const { storage, cleanup } = backend.factory();

      try {
        expect(storage.count).toBeDefined();

        await storage.batch([
          { type: 'put', key: 'count:a', value: encode('a') },
          { type: 'put', key: 'count:b', value: encode('b') },
          { type: 'put', key: 'count:c', value: encode('c') },
          { type: 'put', key: 'other:d', value: encode('d') },
        ]);

        expect(await storage.count?.('count:')).toBe(3);
        expect(await storage.count?.('missing:')).toBe(0);
      } finally {
        cleanup();
      }
    });

    it('Storage.deletePrefix(prefix) removes matching keys and returns deleted count across built-in adapters', async () => {
      const { storage, cleanup } = backend.factory();

      try {
        expect(storage.deletePrefix).toBeDefined();

        await storage.batch([
          { type: 'put', key: 'delete:one', value: encode('1') },
          { type: 'put', key: 'delete:two', value: encode('2') },
          { type: 'put', key: 'keep:three', value: encode('3') },
        ]);

        expect(await storage.deletePrefix?.('delete:')).toBe(2);
        expect(await storage.get('delete:one')).toBeNull();
        expect(await storage.get('delete:two')).toBeNull();
        expect(await storage.get('keep:three')).toEqual(encode('3'));
        expect(await storage.count?.('delete:')).toBe(0);
      } finally {
        cleanup();
      }
    });

    it('Storage.scoped(prefix) isolates keys across built-in adapters', async () => {
      const { storage, cleanup } = backend.factory();

      try {
        expect(storage.scoped).toBeDefined();

        const scoped = storage.scoped?.('scope');
        if (!scoped?.keys) {
          throw new Error('Scoped storage should expose keys(prefix, options?).');
        }

        await scoped.put('profile', encode('alice'));
        await scoped.put('scoped:item', encode('value'));
        await storage.put('outside', encode('global'));

        expect(await collect(scoped.keys(''))).toEqual(['profile', 'scoped:item']);
        expect(await scoped.get('profile')).toEqual(encode('alice'));
        expect(await scoped.get('scoped:item')).toEqual(encode('value'));
        expect(await storage.get('scope:profile')).toEqual(encode('alice'));
        expect(await storage.get('scope:scoped:item')).toEqual(encode('value'));
      } finally {
        cleanup();
      }
    });
  });
}
