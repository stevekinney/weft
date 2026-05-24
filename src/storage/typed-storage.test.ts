import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { MemoryStorage } from './memory.ts';
import {
  collect,
  createCoreStorageAdapter,
  createFullStorageAdapter,
} from './storage-adapter.test-support.ts';
import {
  type JsonValue,
  type MessagePackValue,
  jsonCodec,
  msgpackCodec,
  withCodec,
} from './typed-storage.ts';

describe('withCodec', () => {
  it('withCodec(storage, jsonCodec) round-trips structured values without TextEncoder boilerplate', async () => {
    const storage = withCodec(
      new MemoryStorage(),
      jsonCodec(
        z.object({
          name: z.string(),
          count: z.number(),
        }).parse,
      ),
    );

    await storage.put('profile', { name: 'alice', count: 2 });

    expect(await storage.get('profile')).toEqual({ name: 'alice', count: 2 });
  });

  it('withCodec(storage, msgpackCodec) round-trips richer structured-clone values', async () => {
    const storage = withCodec(
      new MemoryStorage(),
      msgpackCodec(
        z.object({
          createdAt: z.date(),
          tags: z.set(z.string()),
        }).parse,
      ),
    );

    const value = {
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      tags: new Set(['durable', 'workflow']),
    };

    await storage.put('metadata', value);

    const result = await storage.get('metadata');
    expect(result).toEqual(value);
  });

  it('withCodec(storage, codec) forwards batch, scan, keys, count, and deletePrefix through the codec wrapper', async () => {
    const storage = withCodec(
      createCoreStorageAdapter(),
      jsonCodec(
        z.object({
          value: z.string(),
        }).parse,
      ),
    );

    await storage.batch([
      { type: 'put', key: 'items:a', value: { value: 'a' } },
      { type: 'put', key: 'items:b', value: { value: 'b' } },
      { type: 'put', key: 'other:c', value: { value: 'c' } },
    ]);

    expect(await collect(storage.keys('items:'))).toEqual(['items:a', 'items:b']);
    expect(await storage.count('items:')).toBe(2);
    expect(await collect(storage.scan('items:'))).toEqual([
      ['items:a', { value: 'a' }],
      ['items:b', { value: 'b' }],
    ]);
    expect(await storage.deletePrefix('items:')).toBe(2);
    expect(await storage.count('items:')).toBe(0);
  });

  it('withCodec(storage, codec) forwards put, delete, has, and dispose through the codec wrapper', async () => {
    const underlyingStorage = createCoreStorageAdapter();
    const storage = withCodec(
      underlyingStorage,
      jsonCodec(
        z.object({
          value: z.string(),
        }).parse,
      ),
    );

    await storage.put('item', { value: 'present' });
    expect(await storage.has('item')).toBe(true);

    await storage.delete('item');
    expect(await storage.has('item')).toBe(false);

    expect(() => storage[Symbol.dispose]()).not.toThrow();
  });

  it('jsonCodec without a parser rejects unsupported values before serialization', () => {
    const codec = jsonCodec();

    expect(() => codec.encode(undefined as unknown as JsonValue)).toThrow(
      'jsonCodec only supports JSON-serializable values.',
    );
  });

  it('msgpackCodec without a parser rejects non-cloneable values before serialization', () => {
    const codec = msgpackCodec();

    expect(() =>
      codec.encode({
        handler: () => 'nope',
      } as unknown as MessagePackValue),
    ).toThrow('msgpackCodec only supports structuredClone-compatible values.');
  });

  it('jsonCodec requires validation before typed data crosses the storage boundary', async () => {
    const storage = new MemoryStorage();
    await storage.put(
      'profile',
      new TextEncoder().encode(JSON.stringify({ name: 42, count: 'x' })),
    );

    const typedStorage = withCodec(
      storage,
      jsonCodec(
        z.object({
          name: z.string(),
          count: z.number(),
        }).parse,
      ),
    );

    await expect(typedStorage.get('profile')).rejects.toThrow();
  });

  it('forwards put, delete, has, and dispose through the codec wrapper', async () => {
    const adapter = createFullStorageAdapter();
    const storage = withCodec(
      adapter.storage,
      jsonCodec(
        z.object({
          value: z.string(),
        }).parse,
      ),
    );

    await storage.put('item', { value: 'a' });
    expect(await storage.has?.('item')).toBe(true);

    await storage.delete('item');
    expect(await storage.has?.('item')).toBe(false);

    storage[Symbol.dispose]();
    expect(adapter.wasDisposed()).toBe(true);
  });
});
