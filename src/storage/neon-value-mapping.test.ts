import { describe, expect, it } from 'bun:test';

import type { BatchOperation } from './interface.ts';
import {
  affectedRowCount,
  resolveBatchNetEffect,
  toBytea,
  toStorageValue,
} from './neon-value-mapping.ts';

describe('affectedRowCount', () => {
  it('prefers node-postgres rowCount', () => {
    expect(affectedRowCount({ rows: [], rowCount: 7 })).toBe(7);
  });

  it('falls back to PGlite affectedRows when rowCount is absent', () => {
    expect(affectedRowCount({ rows: [], affectedRows: 4 })).toBe(4);
  });

  it('treats a null rowCount as absent and falls through to affectedRows', () => {
    expect(affectedRowCount({ rows: [], rowCount: null, affectedRows: 2 })).toBe(2);
  });

  it('falls back to rows.length when no count field is present', () => {
    expect(affectedRowCount({ rows: [{ key: 'a' }, { key: 'b' }] })).toBe(2);
  });
});

describe('toStorageValue', () => {
  it('copies a Uint8Array into a standalone array', () => {
    const source = new Uint8Array([1, 2, 3]);
    const result = toStorageValue(source);
    expect(result).toEqual(source);
    // A copy, not the same backing buffer: mutating the source must not leak in.
    source[0] = 99;
    expect(result[0]).toBe(1);
  });

  it('copies a Node Buffer view onto a larger pooled ArrayBuffer without aliasing it', () => {
    // The Neon driver can hand back a Buffer that is a window onto a larger pooled
    // ArrayBuffer; the copy must capture only the view's bytes, not the whole pool.
    const pooled = Buffer.from([0xaa, 0x01, 0x02, 0x03, 0xbb]);
    const view = pooled.subarray(1, 4); // bytes [0x01, 0x02, 0x03]
    const result = toStorageValue(view);
    expect(result).toEqual(new Uint8Array([0x01, 0x02, 0x03]));
    // Buffer is a Uint8Array subclass, so the instanceof branch handles it.
    expect(result).toBeInstanceOf(Uint8Array);
  });

  it('coerces a raw ArrayBuffer via the defensive fallback branch', () => {
    // A driver that hands back a bare ArrayBuffer (not a typed-array view) hits the
    // non-Uint8Array fallback, which wraps it without copy semantics applying.
    const buffer = new ArrayBuffer(3);
    new Uint8Array(buffer).set([4, 5, 6]);
    const result = toStorageValue(buffer);
    expect(result).toEqual(new Uint8Array([4, 5, 6]));
  });
});

describe('toBytea', () => {
  it('binds a Uint8Array as a Node Buffer carrying the same bytes', () => {
    const value = new Uint8Array([7, 8, 9]);
    const bound = toBytea(value);
    expect(Buffer.isBuffer(bound)).toBe(true);
    expect([...bound]).toEqual([7, 8, 9]);
  });

  it('round-trips through toStorageValue', () => {
    const value = new Uint8Array([0, 255, 128]);
    expect(toStorageValue(toBytea(value))).toEqual(value);
  });
});

describe('resolveBatchNetEffect', () => {
  const put = (key: string, byte: number): BatchOperation => ({
    type: 'put',
    key,
    value: new Uint8Array([byte]),
  });
  const del = (key: string): BatchOperation => ({ type: 'delete', key });

  it('partitions distinct keys into puts and deletes', () => {
    const { puts, deletes } = resolveBatchNetEffect([put('a', 1), del('b'), put('c', 3)]);
    expect([...puts.keys()].toSorted()).toEqual(['a', 'c']);
    expect(puts.get('a')).toEqual(new Uint8Array([1]));
    expect([...deletes]).toEqual(['b']);
  });

  it('keeps last-write-wins for a key written twice (no duplicate upsert row)', () => {
    const { puts, deletes } = resolveBatchNetEffect([put('a', 1), put('a', 2)]);
    expect(puts.size).toBe(1);
    expect(puts.get('a')).toEqual(new Uint8Array([2]));
    expect(deletes.size).toBe(0);
  });

  it('a put followed by a delete on one key nets to a delete only', () => {
    const { puts, deletes } = resolveBatchNetEffect([put('a', 1), del('a')]);
    expect(puts.has('a')).toBe(false);
    expect([...deletes]).toEqual(['a']);
  });

  it('a delete followed by a put on one key nets to a put only', () => {
    const { puts, deletes } = resolveBatchNetEffect([del('a'), put('a', 9)]);
    expect(puts.get('a')).toEqual(new Uint8Array([9]));
    expect(deletes.has('a')).toBe(false);
  });

  it('keeps the put-set and delete-set disjoint (the commute guarantee)', () => {
    const { puts, deletes } = resolveBatchNetEffect([
      put('a', 1),
      del('a'),
      put('b', 2),
      del('c'),
      put('c', 3),
    ]);
    // No key appears in both sets — the upsert and delete statements never touch
    // the same row, so they commute regardless of emission order.
    for (const key of puts.keys()) {
      expect(deletes.has(key)).toBe(false);
    }
    expect(puts.get('b')).toEqual(new Uint8Array([2]));
    expect(puts.get('c')).toEqual(new Uint8Array([3]));
    expect([...deletes]).toEqual(['a']);
  });

  it('resolves an empty batch to empty sets', () => {
    const { puts, deletes } = resolveBatchNetEffect([]);
    expect(puts.size).toBe(0);
    expect(deletes.size).toBe(0);
  });
});
