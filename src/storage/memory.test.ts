import { describe, expect, it } from 'bun:test';

import { MAX_BATCH_OPERATIONS, StorageBatchOperationLimitExceededError } from './interface';
import { MemoryStorage } from './memory';
import {
  collect,
  decodeText as decode,
  bytes as encode,
  runBasicStorageContract,
  runBinaryAndLargeScanStorageConformance,
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
runBinaryAndLargeScanStorageConformance('MemoryStorage', { create: () => new MemoryStorage() });
runConcurrentConditionalBatchConformance('MemoryStorage', { create: () => new MemoryStorage() });

describe('MemoryStorage', () => {
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
