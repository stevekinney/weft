import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { JSONValue } from '../core/json.ts';
// Pin the public surface: `JSONValue` must remain exported from both the
// package root barrel and the `@lostgradient/weft/storage` subpath barrel. If either export
// is dropped or renamed, these imports stop resolving and the file fails
// `bun run typecheck`. (This does not detect a *reintroduced* lowercase
// `JsonValue` — TypeScript treats it as a distinct name; the absence of that
// duplicate is enforced by the repo-wide grep in the implementation plan.)
import type { JSONValue as JSONValueFromRoot } from '../index.ts';
import type { JSONValue as JSONValueFromStorageBarrel } from './index.ts';

import { MemoryStorage } from './memory.ts';
import {
  collect,
  createCoreStorageAdapter,
  createFullStorageAdapter,
} from './storage-adapter.test-support.ts';
import {
  type ConditionalTypedStorage,
  type MessagePackValue,
  type TypedStorage,
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

  it('withCodec(storage, codec) forwards deleteRange, honoring bounds without touching the codec', async () => {
    const storage = withCodec(
      createCoreStorageAdapter(),
      jsonCodec(
        z.object({
          value: z.string(),
        }).parse,
      ),
    );

    await storage.batch([
      { type: 'put', key: 'ev:wf:01', value: { value: '1' } },
      { type: 'put', key: 'ev:wf:02', value: { value: '2' } },
      { type: 'put', key: 'ev:wf:03', value: { value: '3' } },
    ]);

    if (!storage.deleteRange) {
      throw new Error('Typed storage should expose deleteRange(prefix, options).');
    }

    expect(await storage.deleteRange('ev:wf:', { lt: 'ev:wf:03' })).toBe(2);
    expect(await collect(storage.keys('ev:wf:'))).toEqual(['ev:wf:03']);
    expect(await storage.get('ev:wf:03')).toEqual({ value: '3' });
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

  it('withCodec(storage, codec, { disposeUnderlyingStorage: false }) leaves shared storage open', async () => {
    const underlyingStorage = new MemoryStorage();
    const storage = withCodec(
      underlyingStorage,
      jsonCodec(
        z.object({
          value: z.string(),
        }).parse,
      ),
      { disposeUnderlyingStorage: false },
    );

    await storage.put('item', { value: 'present' });
    storage[Symbol.dispose]();

    expect(await storage.get('item')).toEqual({ value: 'present' });
    expect(await underlyingStorage.get('item')).not.toBeNull();
  });

  it('withCodec(storage, codec) forwards conditionalBatch through the codec wrapper', async () => {
    const storage: ConditionalTypedStorage<{ count: number }> = withCodec(
      new MemoryStorage(),
      jsonCodec(
        z.object({
          count: z.number(),
        }).parse,
      ),
    );

    await storage.put('counter', { count: 1 });

    const committed = await storage.conditionalBatch(
      [{ key: 'counter', expectedValue: { count: 1 } }],
      [{ type: 'put', key: 'counter', value: { count: 2 } }],
    );

    expect(committed).toBe(true);
    expect(await storage.get('counter')).toEqual({ count: 2 });

    const stale = await storage.conditionalBatch(
      [{ key: 'counter', expectedValue: { count: 1 } }],
      [{ type: 'put', key: 'counter', value: { count: 3 } }],
    );

    expect(stale).toBe(false);
    expect(await storage.get('counter')).toEqual({ count: 2 });
  });

  it('keeps the base TypedStorage interface source-compatible without conditionalBatch', () => {
    const storage: TypedStorage<string> = {
      async get() {
        return null;
      },
      async put() {},
      async delete() {},
      async *scan() {},
      async batch() {},
      async has() {
        return false;
      },
      async deletePrefix() {
        return 0;
      },
      async *keys() {},
      async count() {
        return 0;
      },
      [Symbol.dispose]() {},
    };

    expect(typeof storage.batch).toBe('function');
  });

  it('withCodec(storage, codec) treats null conditionalBatch expectations as key absence', async () => {
    const storage = withCodec(
      new MemoryStorage(),
      jsonCodec(
        z.object({
          value: z.string(),
        }).parse,
      ),
    );

    const committed = await storage.conditionalBatch(
      [{ key: 'created', expectedValue: null }],
      [{ type: 'put', key: 'created', value: { value: 'yes' } }],
    );

    expect(committed).toBe(true);
    expect(await storage.get('created')).toEqual({ value: 'yes' });
  });

  it('jsonCodec without a parser rejects unsupported values before serialization', () => {
    const codec = jsonCodec();

    expect(() => codec.encode(undefined as unknown as JSONValue)).toThrow(
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

describe('JSONValue is the single canonical public JSON value type', () => {
  // These assertions are compile-time: they fail `bun run typecheck` if the
  // canonical readonly `JSONValue` ever stops accepting the value shapes it must,
  // or if `jsonCodec`'s generic bound is accidentally over-tightened. The runtime
  // body is incidental — type-checking the fixtures is the actual test.

  it('accepts mutable arrays, readonly arrays, and nested objects', () => {
    const mutableArray: JSONValue = { rows: [1, 2, 3] satisfies number[] };
    const readonlyArray: JSONValue = { rows: [1, 2, 3] as readonly number[] };
    const nested: JSONValue = { a: { b: { c: [{ d: true }, null, 'x'] } } };

    // Assigning a JSONValue into the root- and storage-barrel aliases proves
    // both barrels re-export a type that accepts the canonical JSONValue.
    const fromRoot: JSONValueFromRoot = mutableArray;
    const fromStorage: JSONValueFromStorageBarrel = readonlyArray;

    // Runtime body is incidental — the assignments above are the real (compile-time) test.
    expect(JSON.stringify([mutableArray, readonlyArray, nested, fromRoot, fromStorage])).toContain(
      'rows',
    );
  });

  it('jsonCodec generic bound still accepts mutable user value types', () => {
    // `{ tags: string[] }` has a mutable array but must still satisfy
    // `Value extends JSONValue` — guards against the readonly switch tightening
    // the bound and rejecting previously-valid codec value types.
    type MutableUserValue = { id: number; tags: string[] };
    const codec = jsonCodec<MutableUserValue>((value) => value as MutableUserValue);
    const encoded = codec.encode({ id: 1, tags: ['a', 'b'] });

    expect(codec.decode(encoded)).toEqual({ id: 1, tags: ['a', 'b'] });
  });

  it('jsonCodec() without a parser yields a StorageCodec<JSONValue>', () => {
    // Pins the no-argument overload's return type: decode output must be
    // assignable to JSONValue, not silently widened to `unknown`/`any`.
    const codec = jsonCodec();
    const roundTripped: JSONValue = codec.decode(codec.encode({ ok: true, rows: [1, 2] }));

    expect(roundTripped).toEqual({ ok: true, rows: [1, 2] });
  });

  it('the canonical JSONValue uses readonly arrays (not the old mutable shape)', () => {
    // The defining property of the canonical type: its array branch is
    // ReadonlyArray. The deleted duplicate used mutable `JsonValue[]`. A
    // ReadonlyArray<JSONValue> must be assignable to JSONValue; a value typed as
    // JSONValue must NOT be writable as a mutable array. If a mutable-array
    // duplicate were ever reintroduced as the canonical type, this assignment
    // would fail to compile — a structural guard the import-name check cannot give.
    const readonlyArrayValue: ReadonlyArray<JSONValue> = [1, 'a', true, null];
    const asJsonValue: JSONValue = readonlyArrayValue;
    // @ts-expect-error — JSONValue's array branch is readonly; mutable assignment must be rejected.
    const mutable: JSONValue[] = asJsonValue;
    void mutable;

    expect(Array.isArray(asJsonValue)).toBe(true);
  });
});
