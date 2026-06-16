import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import {
  createGatedLeaseHolderWriteStorage,
  createLeaseHolderReadProbeStorage,
} from './lease.test-support.ts';

function createStorageWithoutConditionalBatch(baseStorage: MemoryStorage) {
  return {
    [Symbol.dispose]: () => baseStorage[Symbol.dispose](),
    batch: baseStorage.batch.bind(baseStorage),
    capabilities: baseStorage.capabilities.bind(baseStorage),
    conditionalBatch: undefined,
    delete: baseStorage.delete.bind(baseStorage),
    get: baseStorage.get.bind(baseStorage),
    put: baseStorage.put.bind(baseStorage),
    scan: baseStorage.scan.bind(baseStorage),
  };
}

describe('lease test-support helpers', () => {
  it('proxies the gated holder-write storage methods and pauses the configured holder write', async () => {
    const baseStorage = new MemoryStorage();
    const gated = createGatedLeaseHolderWriteStorage(baseStorage, {
      gateOnHolderPut: 1,
      phase: 'beforeCommit',
    });
    const holderValue = encode({ holderId: 'engine-a' });

    expect(gated.storage.capabilities()).toEqual(baseStorage.capabilities());
    await gated.storage.put('lease-helper:put', encode('put'));
    expect(await gated.storage.get('lease-helper:put')).toEqual(encode('put'));

    const holderWrite = gated.storage.conditionalBatch?.(
      [],
      [{ type: 'put', key: KEYS.leaseHolder(), value: holderValue }],
    );

    await gated.reached;
    expect(gated.holderPutCount()).toBe(1);
    expect(await baseStorage.get(KEYS.leaseHolder())).toBeNull();

    gated.release();
    await expect(holderWrite).resolves.toBe(true);
    expect(await baseStorage.get(KEYS.leaseHolder())).toEqual(holderValue);

    await gated.storage.delete('lease-helper:put');
    expect(await gated.storage.get('lease-helper:put')).toBeNull();

    await gated.storage.batch([{ type: 'put', key: 'lease-helper:batch', value: encode('batch') }]);
    const scannedKeys: string[] = [];
    for await (const [key] of gated.storage.scan('lease-helper:')) {
      scannedKeys.push(key);
    }
    expect(scannedKeys).toEqual(['lease-helper:batch']);

    gated.storage[Symbol.dispose]();
  });

  it('throws a clear error when the gated holder-write storage lacks conditionalBatch support', async () => {
    const baseStorage = new MemoryStorage();
    const gated = createGatedLeaseHolderWriteStorage(
      createStorageWithoutConditionalBatch(baseStorage) as never,
      { gateOnHolderPut: 1, phase: 'beforeCommit' },
    );

    await expect(gated.storage.conditionalBatch?.([], [])).rejects.toThrow(
      'Lease holder write gate requires conditionalBatch support.',
    );
  });

  it('throws a clear error when the holder-read probe storage lacks conditionalBatch support', async () => {
    const baseStorage = new MemoryStorage();
    const probed = createLeaseHolderReadProbeStorage(
      createStorageWithoutConditionalBatch(baseStorage) as never,
    );

    expect(() => probed.storage.conditionalBatch?.([], [])).toThrow(
      'Lease holder read probe requires conditionalBatch support.',
    );
  });

  it('proxies the holder-read probe storage methods and signals after the configured reads', async () => {
    const baseStorage = new MemoryStorage();
    const holderValue = encode({ holderId: 'engine-b' });
    await baseStorage.put(KEYS.leaseHolder(), holderValue);
    const probed = createLeaseHolderReadProbeStorage(baseStorage, 2);

    expect(probed.storage.capabilities()).toEqual(baseStorage.capabilities());
    await probed.storage.put('lease-probe:put', encode('put'));
    expect(await probed.storage.get('lease-probe:put')).toEqual(encode('put'));

    await expect(probed.storage.get(KEYS.leaseHolder())).resolves.toEqual(holderValue);
    const parkedPromise = probed.parked;
    await expect(probed.storage.get(KEYS.leaseHolder())).resolves.toEqual(holderValue);
    await parkedPromise;

    await probed.storage.batch([{ type: 'put', key: 'lease-probe:batch', value: encode('batch') }]);
    const conditionalCommitted = await probed.storage.conditionalBatch?.(
      [],
      [{ type: 'put', key: 'lease-probe:conditional', value: encode('conditional') }],
    );
    expect(conditionalCommitted).toBe(true);

    const scannedKeys: string[] = [];
    for await (const [key] of probed.storage.scan('lease-probe:')) {
      scannedKeys.push(key);
    }
    expect(scannedKeys).toEqual([
      'lease-probe:batch',
      'lease-probe:conditional',
      'lease-probe:put',
    ]);

    await probed.storage.delete('lease-probe:put');
    expect(await probed.storage.get('lease-probe:put')).toBeNull();

    probed.storage[Symbol.dispose]();
  });
});
