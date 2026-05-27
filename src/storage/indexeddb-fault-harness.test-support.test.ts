import 'fake-indexeddb/auto';

import { describe, expect, it } from 'bun:test';

import {
  createFakeTransaction,
  withFakeIndexedDb,
} from './indexeddb-fault-harness.test-support.ts';

describe('IndexedDB fault harness support', () => {
  it('fires the fake transaction complete handler synchronously', () => {
    let completed = false;
    const transaction = createFakeTransaction({
      store: () => ({}),
    });

    transaction.oncomplete = () => {
      completed = true;
    };

    transaction.fireComplete();

    expect(completed).toBe(true);
  });

  it('drives upgrade before success only when the requested version advances the fake database', async () => {
    await withFakeIndexedDb(
      {
        transaction: createFakeTransaction({
          store: () => ({}),
        }),
      },
      async () => {
        const databaseName = `test-${crypto.randomUUID()}`;
        const firstRequest = indexedDB.open(databaseName, 3);
        const firstLifecycle: string[] = [];

        firstRequest.onupgradeneeded = (event) => {
          firstLifecycle.push('upgrade');
          expect(event.oldVersion).toBe(0);
          expect(event.newVersion).toBe(3);
          expect(firstRequest.result.objectStoreNames.contains('kv')).toBe(true);
        };

        firstRequest.onsuccess = () => {
          firstLifecycle.push('success');
        };

        await Promise.resolve();
        expect(firstLifecycle).toEqual(['upgrade', 'success']);

        const secondRequest = indexedDB.open(databaseName, 3);
        const secondLifecycle: string[] = [];

        secondRequest.onupgradeneeded = () => {
          secondLifecycle.push('upgrade');
        };

        secondRequest.onsuccess = () => {
          secondLifecycle.push('success');
        };

        await Promise.resolve();
        expect(secondLifecycle).toEqual(['success']);
      },
    );
  });
});
