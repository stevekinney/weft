import { describe, expect, it } from 'bun:test';

import { createStorage } from './index.ts';

describe('createStorage', () => {
  it('creates BunSQLiteStorage for sqlite backend', async () => {
    const storage = await createStorage('sqlite', ':memory:');
    expect(storage).toBeDefined();
    expect(typeof storage.get).toBe('function');
    expect(typeof storage.put).toBe('function');
    storage[Symbol.dispose]();
  });

  it('creates MemoryStorage for memory backend', async () => {
    const storage = await createStorage('memory', './unused.db');
    expect(storage).toBeDefined();
    expect(typeof storage.get).toBe('function');
    expect(typeof storage.put).toBe('function');
    storage[Symbol.dispose]();
  });

  it('returns storage implementing get/put/delete/scan', async () => {
    const storage = await createStorage('memory', '');

    await storage.put('test-key', new Uint8Array([1, 2, 3]));
    const result = await storage.get('test-key');
    expect(result).toEqual(new Uint8Array([1, 2, 3]));

    await storage.delete('test-key');
    const deleted = await storage.get('test-key');
    expect(deleted).toBeNull();

    storage[Symbol.dispose]();
  });
});
