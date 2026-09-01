/**
 * The canonical payload digest (WFT-84).
 *
 * The whole point of this module is that two logically equal payloads built in
 * a different order produce the same digest — otherwise an ordinary client
 * retry would look like an idempotency conflict. These tests pin that for every
 * unordered container the structured-clone codec can carry, and pin the
 * fail-closed behavior for values it cannot order at all.
 */

import { describe, expect, it } from 'bun:test';

import {
  computeIdentityDigest,
  computePayloadDigest,
  PayloadDigestError,
} from './application-payload-digest.ts';

describe('computePayloadDigest ordering', () => {
  it('ignores object key insertion order, at any depth', async () => {
    const left = await computePayloadDigest({ a: 1, b: { x: true, y: [1, 2] }, c: 'z' });
    const right = await computePayloadDigest({ c: 'z', b: { y: [1, 2], x: true }, a: 1 });
    expect(left).toBe(right);
    expect(left).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores Map entry order but respects Map values', async () => {
    const left = await computePayloadDigest(
      new Map([
        ['env', 'prod'],
        ['region', 'us'],
      ]),
    );
    const right = await computePayloadDigest(
      new Map([
        ['region', 'us'],
        ['env', 'prod'],
      ]),
    );
    const different = await computePayloadDigest(
      new Map([
        ['region', 'eu'],
        ['env', 'prod'],
      ]),
    );
    expect(left).toBe(right);
    expect(left).not.toBe(different);
  });

  it('ignores Set member order but respects membership', async () => {
    const left = await computePayloadDigest(new Set(['admin', 'auditor', 'reader']));
    const right = await computePayloadDigest(new Set(['reader', 'admin', 'auditor']));
    const different = await computePayloadDigest(new Set(['admin', 'auditor']));
    expect(left).toBe(right);
    expect(left).not.toBe(different);
  });

  it('sorts Set members and Map keys of unequal encoded length deterministically', async () => {
    const left = await computePayloadDigest(new Set([1, 'a', 'aa', 'aaa', 22222]));
    const right = await computePayloadDigest(new Set(['aaa', 22222, 'a', 1, 'aa']));
    expect(left).toBe(right);
  });

  it('sorts equal-length members by their bytes', async () => {
    // Same encoded length, so ordering falls to the byte-by-byte comparison.
    const left = await computePayloadDigest(new Set(['bbb', 'aaa', 'ccc']));
    const right = await computePayloadDigest(new Set(['ccc', 'bbb', 'aaa']));
    expect(left).toBe(right);
    expect(left).not.toBe(await computePayloadDigest(new Set(['aaa', 'bbb', 'ddd'])));
  });

  it('keeps distinct members whose encodings are identical', async () => {
    // Two structurally equal objects are distinct Set members with byte-equal
    // encodings, so the comparison must report a tie rather than drop one.
    const digest = await computePayloadDigest(new Set([{ a: 1 }, { a: 1 }]));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toBe(await computePayloadDigest(new Set([{ a: 1 }])));
  });

  it('surfaces a digest failure from the platform rather than mislabeling it', async () => {
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const failure = new Error('subtle crypto unavailable');
    // A platform failure is not a payload problem, so it must propagate as-is.
    Object.defineProperty(crypto.subtle, 'digest', {
      configurable: true,
      value: () => Promise.reject(failure),
    });
    try {
      await expect(computePayloadDigest({ ok: true })).rejects.toThrow(failure);
    } finally {
      Object.defineProperty(crypto.subtle, 'digest', {
        configurable: true,
        value: originalDigest,
      });
    }
  });

  it('respects array order, which is meaningful', async () => {
    expect(await computePayloadDigest([1, 2])).not.toBe(await computePayloadDigest([2, 1]));
  });

  it('digests binary payloads by their bytes rather than coercing them to text', async () => {
    const left = await computePayloadDigest({ asset: new Uint8Array([1, 2, 3]) });
    const same = await computePayloadDigest({ asset: new Uint8Array([1, 2, 3]) });
    const different = await computePayloadDigest({ asset: new Uint8Array([1, 2, 4]) });
    const asText = await computePayloadDigest({ asset: '1,2,3' });
    expect(left).toBe(same);
    expect(left).not.toBe(different);
    expect(left).not.toBe(asText);
  });

  it('carries Date and ArrayBuffer identity through the digest', async () => {
    const instant = new Date('2026-09-01T00:00:00.000Z');
    expect(await computePayloadDigest({ at: instant })).toBe(
      await computePayloadDigest({ at: new Date('2026-09-01T00:00:00.000Z') }),
    );
    expect(await computePayloadDigest({ at: instant })).not.toBe(
      await computePayloadDigest({ at: new Date('2026-09-02T00:00:00.000Z') }),
    );
    expect(await computePayloadDigest(new Uint8Array([9]).buffer)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('digests primitives and null-prototype objects', async () => {
    for (const value of [null, true, false, 0, -1.5, '', 'text']) {
      expect(await computePayloadDigest(value)).toMatch(/^[0-9a-f]{64}$/);
    }
    const bare = Object.create(null) as Record<string, unknown>;
    bare['b'] = 2;
    bare['a'] = 1;
    expect(await computePayloadDigest(bare)).toBe(await computePayloadDigest({ a: 1, b: 2 }));
  });
});

describe('computePayloadDigest fail-closed behavior', () => {
  it('rejects a cycle rather than looping', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    await expect(computePayloadDigest(cyclic)).rejects.toThrow(PayloadDigestError);
    await expect(computePayloadDigest(cyclic)).rejects.toThrow(/cycle/);
  });

  it('rejects a cycle reached through an array or a Set', async () => {
    const array: unknown[] = [];
    array.push(array);
    await expect(computePayloadDigest(array)).rejects.toThrow(/cycle/);

    const set = new Set<unknown>();
    set.add(set);
    await expect(computePayloadDigest(set)).rejects.toThrow(/cycle/);
  });

  it('allows the same object to appear twice, which is sharing rather than a cycle', async () => {
    const shared = { id: 1 };
    expect(await computePayloadDigest({ left: shared, right: shared })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a function or symbol value', async () => {
    await expect(computePayloadDigest({ run: () => 1 })).rejects.toThrow(/non-cloneable function/);
    await expect(computePayloadDigest({ tag: Symbol('x') })).rejects.toThrow(
      /non-cloneable symbol/,
    );
  });

  it('rejects a class instance it cannot order', async () => {
    class Ticket {
      constructor(readonly id: string) {}
    }
    await expect(computePayloadDigest({ ticket: new Ticket('t-1') })).rejects.toThrow(
      /class instance/,
    );
  });

  it('rejects nesting past the depth ceiling', async () => {
    let deep: unknown = 'leaf';
    for (let level = 0; level < 70; level += 1) deep = { deep };
    await expect(computePayloadDigest(deep)).rejects.toThrow(/nesting exceeds/);

    // Just inside the ceiling still digests.
    let shallow: unknown = 'leaf';
    for (let level = 0; level < 60; level += 1) shallow = { shallow };
    expect(await computePayloadDigest(shallow)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('carries a stable code so callers can branch on it', () => {
    expect(new PayloadDigestError('boom').code).toBe('PayloadDigestError');
    expect(new PayloadDigestError('boom').name).toBe('PayloadDigestError');
  });
});

describe('computeIdentityDigest', () => {
  it('is stable, order-sensitive, and immune to separator forgery', async () => {
    expect(await computeIdentityDigest(['a', 'b', 'c'])).toBe(
      await computeIdentityDigest(['a', 'b', 'c']),
    );
    expect(await computeIdentityDigest(['a', 'b', 'c'])).not.toBe(
      await computeIdentityDigest(['c', 'b', 'a']),
    );
    // Two components cannot be forged into one by embedding a separator.
    expect(await computeIdentityDigest(['a:b', 'c'])).not.toBe(
      await computeIdentityDigest(['a', 'b:c']),
    );
    expect(await computeIdentityDigest([])).toMatch(/^[0-9a-f]{64}$/);
  });
});
