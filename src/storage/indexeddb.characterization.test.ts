import { describe, expect, it } from 'bun:test';
import 'fake-indexeddb/auto';

import { IndexedDBStorage } from './indexeddb';

/** Helper to encode a string as Uint8Array. */
function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** Collect all entries from an async iterable into an array. */
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iterable) {
    results.push(item);
  }
  return results;
}

/** Collect only keys from a scan result. */
async function collectKeys(iterable: AsyncIterable<[string, Uint8Array]>): Promise<string[]> {
  const keys: string[] = [];
  for await (const [key] of iterable) {
    keys.push(key);
  }
  return keys;
}

describe('IndexedDBStorage scan — characterization tests', () => {
  describe('empty-string prefix boundary', () => {
    it('empty prefix on empty storage yields nothing', async () => {
      const storage = new IndexedDBStorage(`char-test-${crypto.randomUUID()}`);
      const entries = await collect(storage.scan(''));
      expect(entries).toHaveLength(0);
    });

    it('empty prefix returns all keys in lexicographic order', async () => {
      const storage = new IndexedDBStorage(`char-test-${crypto.randomUUID()}`);
      await storage.put('a:1', encode('v1'));
      await storage.put('b:2', encode('v2'));
      await storage.put('c:3', encode('v3'));

      const keys = await collectKeys(storage.scan(''));
      expect(keys).toEqual(['a:1', 'b:2', 'c:3']);
    });

    it('empty prefix with limit stops after N entries', async () => {
      const storage = new IndexedDBStorage(`char-test-${crypto.randomUUID()}`);
      await storage.put('a:1', encode('v1'));
      await storage.put('b:2', encode('v2'));
      await storage.put('c:3', encode('v3'));

      const keys = await collectKeys(storage.scan('', { limit: 2 }));
      expect(keys).toEqual(['a:1', 'b:2']);
    });
  });

  describe('exact-prefix-end key boundary', () => {
    it('key equal to prefix end (exclusive) is excluded', async () => {
      const storage = new IndexedDBStorage(`char-test-${crypto.randomUUID()}`);
      // 'p:' prefix end is 'p;' — put 'p;' and verify it does not appear
      await storage.put('p:a', encode('a'));
      await storage.put('p;', encode('boundary'));

      const keys = await collectKeys(storage.scan('p:'));
      expect(keys).toEqual(['p:a']);
      expect(keys).not.toContain('p;');
    });

    it('key just before prefix start is excluded', async () => {
      const storage = new IndexedDBStorage(`char-test-${crypto.randomUUID()}`);
      // character just before 'p' is 'o'
      await storage.put('o:z', encode('before'));
      await storage.put('p:a', encode('a'));

      const keys = await collectKeys(storage.scan('p:'));
      expect(keys).toEqual(['p:a']);
      expect(keys).not.toContain('o:z');
    });
  });

  describe('gt (exclusive lower bound)', () => {
    it('gt excludes the exact boundary key', async () => {
      const storage = new IndexedDBStorage(`char-test-${crypto.randomUUID()}`);
      await storage.put('p:a', encode('a'));
      await storage.put('p:b', encode('b'));
      await storage.put('p:c', encode('c'));

      const keys = await collectKeys(storage.scan('p:', { gt: 'p:a' }));
      expect(keys).toEqual(['p:b', 'p:c']);
    });

    it('gt greater than all keys yields nothing', async () => {
      const storage = new IndexedDBStorage(`char-test-${crypto.randomUUID()}`);
      await storage.put('p:a', encode('a'));
      await storage.put('p:b', encode('b'));

      const keys = await collectKeys(storage.scan('p:', { gt: 'p:z' }));
      expect(keys).toHaveLength(0);
    });
  });

  describe('gte (inclusive lower bound)', () => {
    it('gte includes the exact boundary key', async () => {
      const storage = new IndexedDBStorage(`char-test-${crypto.randomUUID()}`);
      await storage.put('p:a', encode('a'));
      await storage.put('p:b', encode('b'));
      await storage.put('p:c', encode('c'));

      const keys = await collectKeys(storage.scan('p:', { gte: 'p:b' }));
      expect(keys).toEqual(['p:b', 'p:c']);
    });

    it('gte greater than all keys yields nothing', async () => {
      const storage = new IndexedDBStorage(`char-test-${crypto.randomUUID()}`);
      await storage.put('p:a', encode('a'));

      const keys = await collectKeys(storage.scan('p:', { gte: 'p:z' }));
      expect(keys).toHaveLength(0);
    });
  });

  describe('lt (exclusive upper bound)', () => {
    it('lt excludes the exact boundary key', async () => {
      const storage = new IndexedDBStorage(`char-test-${crypto.randomUUID()}`);
      await storage.put('p:a', encode('a'));
      await storage.put('p:b', encode('b'));
      await storage.put('p:c', encode('c'));

      const keys = await collectKeys(storage.scan('p:', { lt: 'p:c' }));
      expect(keys).toEqual(['p:a', 'p:b']);
    });

    it('lt less than all keys yields nothing', async () => {
      const storage = new IndexedDBStorage(`char-test-${crypto.randomUUID()}`);
      await storage.put('p:b', encode('b'));
      await storage.put('p:c', encode('c'));

      const keys = await collectKeys(storage.scan('p:', { lt: 'p:a' }));
      expect(keys).toHaveLength(0);
    });
  });

  describe('lte (inclusive upper bound)', () => {
    it('lte includes the exact boundary key', async () => {
      const storage = new IndexedDBStorage(`char-test-${crypto.randomUUID()}`);
      await storage.put('p:a', encode('a'));
      await storage.put('p:b', encode('b'));
      await storage.put('p:c', encode('c'));

      const keys = await collectKeys(storage.scan('p:', { lte: 'p:b' }));
      expect(keys).toEqual(['p:a', 'p:b']);
    });

    it('lte less than all keys yields nothing', async () => {
      const storage = new IndexedDBStorage(`char-test-${crypto.randomUUID()}`);
      await storage.put('p:b', encode('b'));
      await storage.put('p:c', encode('c'));

      const keys = await collectKeys(storage.scan('p:', { lte: 'p:a' }));
      expect(keys).toHaveLength(0);
    });
  });

  describe('combined gt and lt bounds', () => {
    it('gt and lt produce open interval', async () => {
      const storage = new IndexedDBStorage(`char-test-${crypto.randomUUID()}`);
      await storage.put('p:a', encode('a'));
      await storage.put('p:b', encode('b'));
      await storage.put('p:c', encode('c'));
      await storage.put('p:d', encode('d'));

      const keys = await collectKeys(storage.scan('p:', { gt: 'p:a', lt: 'p:d' }));
      expect(keys).toEqual(['p:b', 'p:c']);
    });

    it('gte and lte produce closed interval', async () => {
      const storage = new IndexedDBStorage(`char-test-${crypto.randomUUID()}`);
      await storage.put('p:a', encode('a'));
      await storage.put('p:b', encode('b'));
      await storage.put('p:c', encode('c'));
      await storage.put('p:d', encode('d'));

      const keys = await collectKeys(storage.scan('p:', { gte: 'p:b', lte: 'p:c' }));
      expect(keys).toEqual(['p:b', 'p:c']);
    });

    it('gte and lt produce half-open interval', async () => {
      const storage = new IndexedDBStorage(`char-test-${crypto.randomUUID()}`);
      await storage.put('p:a', encode('a'));
      await storage.put('p:b', encode('b'));
      await storage.put('p:c', encode('c'));

      const keys = await collectKeys(storage.scan('p:', { gte: 'p:b', lt: 'p:c' }));
      expect(keys).toEqual(['p:b']);
    });

    it('gt and lte produce half-open interval from other side', async () => {
      const storage = new IndexedDBStorage(`char-test-${crypto.randomUUID()}`);
      await storage.put('p:a', encode('a'));
      await storage.put('p:b', encode('b'));
      await storage.put('p:c', encode('c'));

      const keys = await collectKeys(storage.scan('p:', { gt: 'p:a', lte: 'p:b' }));
      expect(keys).toEqual(['p:b']);
    });

    it('inverted bounds (gt > lt) yields nothing', async () => {
      const storage = new IndexedDBStorage(`char-test-${crypto.randomUUID()}`);
      await storage.put('p:a', encode('a'));
      await storage.put('p:b', encode('b'));

      const keys = await collectKeys(storage.scan('p:', { gt: 'p:b', lt: 'p:a' }));
      expect(keys).toHaveLength(0);
    });
  });

  describe('reverse iteration with bounds', () => {
    it('reverse=true returns all prefix entries in reverse order', async () => {
      const storage = new IndexedDBStorage(`char-test-${crypto.randomUUID()}`);
      await storage.put('p:a', encode('a'));
      await storage.put('p:b', encode('b'));
      await storage.put('p:c', encode('c'));

      const keys = await collectKeys(storage.scan('p:', { reverse: true }));
      expect(keys).toEqual(['p:c', 'p:b', 'p:a']);
    });

    it('reverse with gt bound excludes boundary key', async () => {
      const storage = new IndexedDBStorage(`char-test-${crypto.randomUUID()}`);
      await storage.put('p:a', encode('a'));
      await storage.put('p:b', encode('b'));
      await storage.put('p:c', encode('c'));

      const keys = await collectKeys(storage.scan('p:', { reverse: true, gt: 'p:a' }));
      expect(keys).toEqual(['p:c', 'p:b']);
    });

    it('reverse past prefix does not return keys outside prefix', async () => {
      const storage = new IndexedDBStorage(`char-test-${crypto.randomUUID()}`);
      await storage.put('p:a', encode('a'));
      await storage.put('p:b', encode('b'));
      await storage.put('q:z', encode('z'));

      const keys = await collectKeys(storage.scan('p:', { reverse: true }));
      expect(keys).toEqual(['p:b', 'p:a']);
      expect(keys).not.toContain('q:z');
    });

    it('reverse with limit stops after N entries from the end', async () => {
      const storage = new IndexedDBStorage(`char-test-${crypto.randomUUID()}`);
      await storage.put('p:a', encode('a'));
      await storage.put('p:b', encode('b'));
      await storage.put('p:c', encode('c'));
      await storage.put('p:d', encode('d'));

      const keys = await collectKeys(storage.scan('p:', { reverse: true, limit: 2 }));
      expect(keys).toEqual(['p:d', 'p:c']);
    });
  });

  describe('limit=0', () => {
    it('limit=0 yields nothing even when matching keys exist', async () => {
      const storage = new IndexedDBStorage(`char-test-${crypto.randomUUID()}`);
      await storage.put('p:a', encode('a'));
      await storage.put('p:b', encode('b'));

      const keys = await collectKeys(storage.scan('p:', { limit: 0 }));
      expect(keys).toHaveLength(0);
    });

    it('limit=0 with reverse yields nothing', async () => {
      const storage = new IndexedDBStorage(`char-test-${crypto.randomUUID()}`);
      await storage.put('p:a', encode('a'));

      const keys = await collectKeys(storage.scan('p:', { limit: 0, reverse: true }));
      expect(keys).toHaveLength(0);
    });
  });

  describe('values are returned correctly', () => {
    it('scan yields correct [key, value] pairs', async () => {
      const storage = new IndexedDBStorage(`char-test-${crypto.randomUUID()}`);
      await storage.put('p:a', encode('alpha'));
      await storage.put('p:b', encode('beta'));

      const entries = await collect(storage.scan('p:'));
      expect(entries).toHaveLength(2);
      expect(entries[0]![0]).toBe('p:a');
      expect(new TextDecoder().decode(entries[0]![1])).toBe('alpha');
      expect(entries[1]![0]).toBe('p:b');
      expect(new TextDecoder().decode(entries[1]![1])).toBe('beta');
    });
  });
});
