import { describe, expect, it } from 'bun:test';

import { affectedRowCount, toBytea, toStorageValue } from './neon-value-mapping.ts';

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
