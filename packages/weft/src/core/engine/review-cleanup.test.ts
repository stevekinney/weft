import { describe, expect, it } from 'bun:test';

import { KEYS, type BatchOperation } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import { completedReviewStorageKey } from './completed-review-storage.ts';
import type { EngineInternals } from './internals.ts';
import { cleanupReviews } from './review-cleanup.ts';

const seed = async (storage: MemoryStorage): Promise<string[]> => {
  const keys = [KEYS.review('w', 'pending'), completedReviewStorageKey('w', 'done')];
  for (const key of keys) await storage.put(key, encode({ placeholder: true }));
  await storage.put(KEYS.review('other', 'pending'), encode({ placeholder: true }));
  return keys;
};

const internalsFor = (storage: MemoryStorage): EngineInternals =>
  ({ storage }) as unknown as EngineInternals;

describe('cleanupReviews', () => {
  it("deletes a workflow's pending and completed reviews with the native prefix delete", async () => {
    const storage = new MemoryStorage();
    const keys = await seed(storage);

    await cleanupReviews(internalsFor(storage), 'w');

    for (const key of keys) expect(await storage.get(key)).toBeNull();
    expect(await storage.get(KEYS.review('other', 'pending'))).not.toBeNull();
  });

  it('falls back to scan-and-batch deletion when the storage has no prefix delete', async () => {
    const storage = new MemoryStorage();
    Object.defineProperty(storage, 'deletePrefix', { configurable: true, value: undefined });
    const keys = await seed(storage);

    await cleanupReviews(internalsFor(storage), 'w');

    for (const key of keys) expect(await storage.get(key)).toBeNull();
    expect(await storage.get(KEYS.review('other', 'pending'))).not.toBeNull();
  });

  it('with a fenced commit, lists the keys and deletes exactly those through it', async () => {
    const storage = new MemoryStorage();
    const keys = await seed(storage);
    const committed: BatchOperation[][] = [];

    await cleanupReviews(internalsFor(storage), 'w', async (operations) => {
      committed.push(operations);
      return true;
    });

    expect(
      committed
        .flat()
        .map((operation) => operation.key)
        .toSorted(),
    ).toEqual(keys.toSorted());
    // The fenced commit owns the delete, so nothing was removed directly.
    for (const key of keys) expect(await storage.get(key)).not.toBeNull();
  });
});
