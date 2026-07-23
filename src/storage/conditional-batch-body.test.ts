import { describe, expect, it } from 'bun:test';

import { runConditionalBatchBody } from './conditional-batch-body.ts';
import type { BatchOperation, ConditionalBatchCondition } from './interface.ts';

function createStore(initial: Readonly<Record<string, Uint8Array>> = {}) {
  const values = new Map(Object.entries(initial));
  const writes: string[] = [];

  return {
    values,
    writes,
    operations: {
      read: (key: string) => values.get(key) ?? null,
      put: (key: string, value: Uint8Array) => {
        writes.push(`put:${key}`);
        values.set(key, value);
      },
      delete: (key: string) => {
        writes.push(`delete:${key}`);
        values.delete(key);
      },
    },
  };
}

describe('runConditionalBatchBody', () => {
  it('returns false and performs no writes when a condition mismatches', () => {
    const store = createStore({ existing: new Uint8Array([1]) });

    const committed = runConditionalBatchBody(
      [{ key: 'existing', expectedValue: new Uint8Array([2]) }],
      [{ type: 'put', key: 'created', value: new Uint8Array([3]) }],
      store.operations,
    );

    expect(committed).toBe(false);
    expect(store.writes).toEqual([]);
    expect(store.values.has('created')).toBe(false);
  });

  it('treats null as absence and compares bytes by value', () => {
    const store = createStore({ existing: new Uint8Array([1, 2]) });
    const conditions: ConditionalBatchCondition[] = [
      { key: 'missing', expectedValue: null },
      { key: 'existing', expectedValue: new Uint8Array([1, 2]) },
    ];

    expect(runConditionalBatchBody(conditions, [], store.operations)).toBe(true);
  });

  it('checks every condition before applying any operation', () => {
    const store = createStore({ first: new Uint8Array([1]), second: new Uint8Array([2]) });

    const committed = runConditionalBatchBody(
      [
        { key: 'first', expectedValue: new Uint8Array([1]) },
        { key: 'second', expectedValue: new Uint8Array([9]) },
      ],
      [{ type: 'delete', key: 'first' }],
      store.operations,
    );

    expect(committed).toBe(false);
    expect(store.writes).toEqual([]);
    expect(store.values.has('first')).toBe(true);
  });

  it('applies matching operations in their supplied order', () => {
    const store = createStore();
    const operations: BatchOperation[] = [
      { type: 'put', key: 'first', value: new Uint8Array([1]) },
      { type: 'delete', key: 'first' },
      { type: 'put', key: 'second', value: new Uint8Array([2]) },
    ];

    expect(runConditionalBatchBody([], operations, store.operations)).toBe(true);
    expect(store.writes).toEqual(['put:first', 'delete:first', 'put:second']);
    expect(store.values.has('first')).toBe(false);
    expect(store.values.get('second')).toEqual(new Uint8Array([2]));
  });

  it('propagates write errors so the transaction wrapper can roll back', () => {
    const error = new Error('write failed');
    const store = createStore();

    expect(() =>
      runConditionalBatchBody([], [{ type: 'put', key: 'first', value: new Uint8Array([1]) }], {
        ...store.operations,
        put: () => {
          throw error;
        },
      }),
    ).toThrow(error);
  });
});
