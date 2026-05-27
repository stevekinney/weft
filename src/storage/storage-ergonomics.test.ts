import { describe, expect, it } from 'bun:test';

import { storageBackends } from '../testing/storage-backends.test-support.ts';
import { storageDeleteRange, type DeleteRangeOptions } from './delete-range.ts';
import { KEYS } from './interface.ts';

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/**
 * Cross-adapter cases for deleteRange. Each seeds `range:1..5` then deletes with
 * the given bounds and asserts the count removed and the keys that survive.
 */
const deleteRangeCases: ReadonlyArray<{
  name: string;
  options: DeleteRangeOptions;
  deleted: number;
  survivors: string[];
}> = [
  {
    name: 'gt lower bound',
    options: { gt: 'range:2' },
    deleted: 3,
    survivors: ['range:1', 'range:2'],
  },
  {
    name: 'gte lower bound',
    options: { gte: 'range:2' },
    deleted: 4,
    survivors: ['range:1'],
  },
  {
    name: 'lt upper bound',
    options: { lt: 'range:3' },
    deleted: 2,
    survivors: ['range:3', 'range:4', 'range:5'],
  },
  {
    name: 'lte upper bound',
    options: { lte: 'range:3' },
    deleted: 3,
    survivors: ['range:4', 'range:5'],
  },
  {
    name: 'combined lower and upper bound',
    options: { gt: 'range:1', lt: 'range:4' },
    deleted: 2,
    survivors: ['range:1', 'range:4', 'range:5'],
  },
  {
    name: 'limit 0 deletes nothing',
    options: { gte: 'range:1', limit: 0 },
    deleted: 0,
    survivors: ['range:1', 'range:2', 'range:3', 'range:4', 'range:5'],
  },
  {
    name: 'limit below match count deletes the lowest keys',
    options: { gte: 'range:1', limit: 2 },
    deleted: 2,
    survivors: ['range:3', 'range:4', 'range:5'],
  },
  {
    name: 'impossible range deletes nothing',
    options: { gt: 'range:9', lt: 'range:0' },
    deleted: 0,
    survivors: ['range:1', 'range:2', 'range:3', 'range:4', 'range:5'],
  },
  {
    name: 'smuggled reverse does not flip which keys the limit selects',
    options: { gte: 'range:1', limit: 2, reverse: true } as DeleteRangeOptions,
    deleted: 2,
    survivors: ['range:3', 'range:4', 'range:5'],
  },
];

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

    it('Storage.deleteRange(prefix, options) honors bounds and limit across built-in adapters', async () => {
      for (const testCase of deleteRangeCases) {
        const { storage, cleanup } = backend.factory();
        try {
          expect(storage.deleteRange).toBeDefined();

          await storage.batch(
            [1, 2, 3, 4, 5].map((n) => ({
              type: 'put' as const,
              key: `range:${n}`,
              value: encode(String(n)),
            })),
          );

          const deleted = await storage.deleteRange?.('range:', testCase.options);
          expect(deleted, testCase.name).toBe(testCase.deleted);

          const survivors = await collect(storage.keys!('range:'));
          expect(survivors, testCase.name).toEqual(testCase.survivors);
        } finally {
          cleanup();
        }
      }
    });

    it('storageDeleteRange truncates events below a sequence watermark via KEYS.event', async () => {
      const { storage, cleanup } = backend.factory();
      try {
        for (let sequence = 1; sequence <= 5; sequence++) {
          await storage.put(KEYS.event('wf', sequence), encode(String(sequence)));
        }

        // Exactly how the downstream truncation task calls it: delete events with
        // sequence strictly below the cutoff (3), leaving 3..5.
        const deleted = await storageDeleteRange(storage, KEYS.eventPrefix('wf'), {
          lt: KEYS.event('wf', 3),
        });
        expect(deleted).toBe(2);
        expect(await storage.get(KEYS.event('wf', 1))).toBeNull();
        expect(await storage.get(KEYS.event('wf', 2))).toBeNull();
        expect(await storage.get(KEYS.event('wf', 3))).not.toBeNull();
        expect(await storage.get(KEYS.event('wf', 5))).not.toBeNull();
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
