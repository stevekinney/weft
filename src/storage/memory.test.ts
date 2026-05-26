import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from './memory';
import { runStorageCapabilityConformance } from './storage-adapter.test-support.ts';

runStorageCapabilityConformance('MemoryStorage', {
  create: () => new MemoryStorage(),
  expected: {
    readAfterWrite: 'linearizable',
    scanConsistency: 'snapshot',
    atomicBatch: true,
    conditionalBatch: true,
    boundedRangeDelete: true,
  },
});

/** Helper to encode a string as Uint8Array. */
function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** Helper to decode a Uint8Array to string. */
function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

/** Collect all entries from an async iterable into an array. */
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iterable) {
    results.push(item);
  }
  return results;
}

describe('MemoryStorage', () => {
  it('get on empty storage returns null', async () => {
    const storage = new MemoryStorage();
    const result = await storage.get('nonexistent');
    expect(result).toBeNull();
  });

  it('put then get returns same bytes', async () => {
    const storage = new MemoryStorage();
    const value = encode('hello');
    await storage.put('key', value);
    const result = await storage.get('key');
    expect(result).toEqual(value);
  });

  it('put with same key overwrites previous value', async () => {
    const storage = new MemoryStorage();
    await storage.put('key', encode('first'));
    await storage.put('key', encode('second'));
    const result = await storage.get('key');
    expect(decode(result!)).toBe('second');
  });

  it('delete removes key, subsequent get returns null', async () => {
    const storage = new MemoryStorage();
    await storage.put('key', encode('value'));
    await storage.delete('key');
    const result = await storage.get('key');
    expect(result).toBeNull();
  });

  it('delete on nonexistent key is a no-op', async () => {
    const storage = new MemoryStorage();
    await storage.delete('nonexistent');
    expect(storage.size).toBe(0);
  });

  it('scan with prefix returns only matching keys, sorted lexicographically', async () => {
    const storage = new MemoryStorage();
    await storage.put('wf:b', encode('b'));
    await storage.put('wf:a', encode('a'));
    await storage.put('wf:c', encode('c'));
    await storage.put('other:x', encode('x'));

    const entries = await collect(storage.scan('wf:'));
    expect(entries.map(([key]) => key)).toEqual(['wf:a', 'wf:b', 'wf:c']);
  });

  it('scan with limit returns at most N entries', async () => {
    const storage = new MemoryStorage();
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));

    const entries = await collect(storage.scan('p:', { limit: 2 }));
    expect(entries).toHaveLength(2);
    expect(entries.map(([key]) => key)).toEqual(['p:a', 'p:b']);
  });

  it('scan with reverse returns in reverse order', async () => {
    const storage = new MemoryStorage();
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));

    const entries = await collect(storage.scan('p:', { reverse: true }));
    expect(entries.map(([key]) => key)).toEqual(['p:c', 'p:b', 'p:a']);
  });

  it('scan with gt/lt bounds', async () => {
    const storage = new MemoryStorage();
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));
    await storage.put('p:d', encode('d'));

    const entries = await collect(storage.scan('p:', { gt: 'p:a', lt: 'p:d' }));
    expect(entries.map(([key]) => key)).toEqual(['p:b', 'p:c']);
  });

  it('scan with gte/lte bounds', async () => {
    const storage = new MemoryStorage();
    await storage.put('p:a', encode('a'));
    await storage.put('p:b', encode('b'));
    await storage.put('p:c', encode('c'));
    await storage.put('p:d', encode('d'));

    const entries = await collect(storage.scan('p:', { gte: 'p:b', lte: 'p:c' }));
    expect(entries.map(([key]) => key)).toEqual(['p:b', 'p:c']);
  });

  it('scan with empty prefix returns all keys', async () => {
    const storage = new MemoryStorage();
    await storage.put('alpha', encode('a'));
    await storage.put('beta', encode('b'));
    await storage.put('gamma', encode('c'));

    const entries = await collect(storage.scan(''));
    expect(entries.map(([key]) => key)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('scan with no matches yields zero entries', async () => {
    const storage = new MemoryStorage();
    await storage.put('other:a', encode('a'));

    const entries = await collect(storage.scan('wf:'));
    expect(entries).toHaveLength(0);
  });

  it('batch with multiple puts: all keys exist after', async () => {
    const storage = new MemoryStorage();
    await storage.batch([
      { type: 'put', key: 'a', value: encode('1') },
      { type: 'put', key: 'b', value: encode('2') },
      { type: 'put', key: 'c', value: encode('3') },
    ]);

    expect(await storage.get('a')).toEqual(encode('1'));
    expect(await storage.get('b')).toEqual(encode('2'));
    expect(await storage.get('c')).toEqual(encode('3'));
  });

  it('batch with mixed puts and deletes: correct final state', async () => {
    const storage = new MemoryStorage();
    await storage.put('keep', encode('keep'));
    await storage.put('remove', encode('remove'));

    await storage.batch([
      { type: 'put', key: 'new', value: encode('new') },
      { type: 'delete', key: 'remove' },
    ]);

    expect(await storage.get('keep')).toEqual(encode('keep'));
    expect(await storage.get('remove')).toBeNull();
    expect(await storage.get('new')).toEqual(encode('new'));
  });

  it('batch with empty array is a no-op', async () => {
    const storage = new MemoryStorage();
    await storage.put('key', encode('value'));
    await storage.batch([]);
    expect(await storage.get('key')).toEqual(encode('value'));
    expect(storage.size).toBe(1);
  });

  it('[Symbol.dispose] clears all data', () => {
    const storage = new MemoryStorage();
    storage.put('a', encode('1'));
    storage.put('b', encode('2'));
    storage[Symbol.dispose]();
    expect(storage.size).toBe(0);
  });

  it('size reflects entry count', async () => {
    const storage = new MemoryStorage();
    expect(storage.size).toBe(0);
    await storage.put('a', encode('1'));
    expect(storage.size).toBe(1);
    await storage.put('b', encode('2'));
    expect(storage.size).toBe(2);
    await storage.delete('a');
    expect(storage.size).toBe(1);
  });

  it('snapshot returns independent copy', async () => {
    const storage = new MemoryStorage();
    await storage.put('key', encode('original'));

    const snap = storage.snapshot();
    await storage.put('key', encode('modified'));

    expect(decode(snap.get('key')!)).toBe('original');
    expect(decode((await storage.get('key'))!)).toBe('modified');
  });

  it('binary values: put Uint8Array with various byte values, verify identical on get', async () => {
    const storage = new MemoryStorage();
    const binaryData = new Uint8Array([0, 1, 127, 128, 255, 42, 0, 13, 10]);
    await storage.put('binary', binaryData);
    const result = await storage.get('binary');
    expect(result).toEqual(binaryData);
  });

  it('large key count (1000 entries): scan returns all in correct order', async () => {
    const storage = new MemoryStorage();
    const operations = Array.from({ length: 1000 }, (_, index) => ({
      type: 'put' as const,
      key: `item:${String(index).padStart(4, '0')}`,
      value: encode(String(index)),
    }));
    await storage.batch(operations);

    const entries = await collect(storage.scan('item:'));
    expect(entries).toHaveLength(1000);

    // Verify sorted order
    for (let index = 0; index < entries.length; index++) {
      expect(entries[index]![0]).toBe(`item:${String(index).padStart(4, '0')}`);
    }
  });

  it('has returns true for existing keys, false otherwise', async () => {
    const storage = new MemoryStorage();
    await storage.put('exists', encode('value'));
    expect(await storage.has('exists')).toBe(true);
    expect(await storage.has('missing')).toBe(false);
  });

  it('keys returns all key names sorted', async () => {
    const storage = new MemoryStorage();
    await storage.put('c', encode('3'));
    await storage.put('a', encode('1'));
    await storage.put('b', encode('2'));

    expect(await collect(storage.keys(''))).toEqual(['a', 'b', 'c']);
  });

  it('clear removes all entries', async () => {
    const storage = new MemoryStorage();
    await storage.put('a', encode('1'));
    await storage.put('b', encode('2'));
    storage.clear();
    expect(storage.size).toBe(0);
    expect(await storage.get('a')).toBeNull();
  });
});
