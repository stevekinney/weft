import { describe, expect, it } from 'bun:test';

import { MAX_BATCH_OPERATIONS, StorageBatchOperationLimitExceededError } from './interface';
import { MemoryStorage } from './memory';
import {
  collect,
  decodeText as decode,
  bytes as encode,
  runBasicStorageContract,
  runConcurrentConditionalBatchConformance,
  runStorageCapabilityConformance,
} from './storage-adapter.test-support.ts';

runStorageCapabilityConformance('MemoryStorage', {
  create: () => new MemoryStorage(),
  expected: {
    persistence: 'ephemeral',
    readAfterWrite: 'linearizable',
    scanConsistency: 'snapshot',
    atomicBatch: true,
    conditionalBatch: true,
    boundedRangeDelete: true,
  },
});

runBasicStorageContract('MemoryStorage', { create: () => new MemoryStorage() });
runConcurrentConditionalBatchConformance('MemoryStorage', { create: () => new MemoryStorage() });

describe('MemoryStorage', () => {
  it('delete on nonexistent key is a no-op', async () => {
    const storage = new MemoryStorage();
    await storage.delete('nonexistent');
    expect(storage.size).toBe(0);
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

  it('rejects a batch above MAX_BATCH_OPERATIONS before applying writes', async () => {
    const storage = new MemoryStorage();
    const operations = Array.from({ length: MAX_BATCH_OPERATIONS + 1 }, (_, index) => ({
      type: 'put' as const,
      key: `oversized:${index}`,
      value: encode(String(index)),
    }));

    await expect(storage.batch(operations)).rejects.toBeInstanceOf(
      StorageBatchOperationLimitExceededError,
    );
    expect(await storage.get('oversized:0')).toBeNull();
    expect(await storage.get(`oversized:${MAX_BATCH_OPERATIONS}`)).toBeNull();
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
