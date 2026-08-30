/**
 * Unit tests for the dispatch helper. The integration tests in
 * `src/core/__tests__/parallel-partial-failure.test.ts` exercise this
 * module end-to-end through the engine; these tests pin down the
 * helper-level contract directly.
 */

import { describe, expect, it } from 'bun:test';

import type { ParallelBranchSlot } from '../context/parallel-cache-entry.ts';
import {
  buildEntryFromSlots,
  dispatchBranchesAllSettled,
  valuesFromSlots,
} from './parallel-dispatch.ts';

describe('dispatchBranchesAllSettled', () => {
  it('returns fulfilled slots and no error when every branch succeeds', async () => {
    const result = await dispatchBranchesAllSettled(
      ['op-0', 'op-1', 'op-2'],
      undefined,
      async (i) => `value-${i}`,
    );

    expect(result.hasFirstError).toBe(false);
    expect(result.firstError).toBeUndefined();
    expect(result.slots).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      const slot = result.slots[i];
      expect(slot?.status).toBe('fulfilled');
      if (slot?.status === 'fulfilled') {
        expect(slot.value).toBe(`value-${i}`);
        expect(slot.operationId).toBe(`op-${i}`);
      }
    }
  });

  it('captures both rejections when multiple branches fail simultaneously', async () => {
    const result = await dispatchBranchesAllSettled(['op-0', 'op-1'], undefined, async () => {
      throw new Error('boom');
    });

    expect(result.hasFirstError).toBe(true);
    expect(result.slots).toHaveLength(2);
    expect(result.slots[0]?.status).toBe('rejected');
    expect(result.slots[1]?.status).toBe('rejected');
  });

  it('preserves the first rejection reason as-is (not coerced to Error)', async () => {
    const result = await dispatchBranchesAllSettled(['op-0', 'op-1'], undefined, async (i) => {
      if (i === 0) throw 'plain-string-rejection';
      return 'second-success';
    });

    expect(result.hasFirstError).toBe(true);
    // firstError is the original `unknown` reason, not a wrapped Error.
    expect(result.firstError).toBe('plain-string-rejection');
  });

  it('preserves an undefined rejection reason and signals via hasFirstError', async () => {
    const result = await dispatchBranchesAllSettled(['op-0'], undefined, async () => {
      throw undefined;
    });

    expect(result.hasFirstError).toBe(true);
    expect(result.firstError).toBeUndefined();
  });

  it('normalizes the persisted rejection metadata to { name, message }', async () => {
    const result = await dispatchBranchesAllSettled(['op-0'], undefined, async () => {
      throw new TypeError('bad-type');
    });

    const slot = result.slots[0];
    expect(slot?.status).toBe('rejected');
    if (slot?.status === 'rejected') {
      expect(slot.reason.name).toBe('TypeError');
      expect(slot.reason.message).toBe('bad-type');
    }
  });

  it('does not call executeOne for resumed fulfilled slots', async () => {
    const calls: number[] = [];
    const resumedSlots: ParallelBranchSlot[] = [
      { status: 'fulfilled', value: 'cached-0', operationId: 'op-0' },
      { status: 'pending', operationId: 'op-1' },
    ];

    const result = await dispatchBranchesAllSettled(['op-0', 'op-1'], resumedSlots, async (i) => {
      calls.push(i);
      return `fresh-${i}`;
    });

    // Only index 1 should have been dispatched.
    expect(calls).toEqual([1]);
    expect(result.slots[0]?.status).toBe('fulfilled');
    if (result.slots[0]?.status === 'fulfilled') {
      expect(result.slots[0].value).toBe('cached-0');
    }
    if (result.slots[1]?.status === 'fulfilled') {
      expect(result.slots[1].value).toBe('fresh-1');
    }
  });

  it('re-dispatches non-fulfilled resumed slots (rejected, pending, aborted)', async () => {
    const calls: number[] = [];
    const resumedSlots: ParallelBranchSlot[] = [
      { status: 'rejected', reason: { name: 'Error', message: 'old' }, operationId: 'op-0' },
      { status: 'pending', operationId: 'op-1' },
      { status: 'aborted', operationId: 'op-2' },
    ];

    const result = await dispatchBranchesAllSettled(
      ['op-0', 'op-1', 'op-2'],
      resumedSlots,
      async (i) => {
        calls.push(i);
        return `fresh-${i}`;
      },
    );

    expect(calls.toSorted((a, b) => a - b)).toEqual([0, 1, 2]);
    for (let i = 0; i < 3; i++) {
      expect(result.slots[i]?.status).toBe('fulfilled');
    }
  });

  it('handles an empty branch list cleanly', async () => {
    const result = await dispatchBranchesAllSettled([], undefined, async () => {
      throw new Error('should never be called');
    });

    expect(result.hasFirstError).toBe(false);
    expect(result.firstError).toBeUndefined();
    expect(result.slots).toHaveLength(0);
  });
});

describe('buildEntryFromSlots', () => {
  it('builds a v2 cache entry with the right shape for ctx.all', () => {
    const slots: ParallelBranchSlot[] = [
      { status: 'fulfilled', value: 1, operationId: 'a' },
      { status: 'fulfilled', value: 2, operationId: 'b' },
    ];

    const entry = buildEntryFromSlots('all', slots);

    expect(entry.__weftParallelOperationCache).toBe(true);
    expect(entry.formatVersion).toBe(2);
    expect(entry.variant).toBe('all');
    expect(entry.subOperationCount).toBe(2);
    expect(entry.branches).toEqual(slots);
    expect(entry.branchNames).toBeUndefined();
  });

  it('attaches branchNames for run-all variant', () => {
    const slots: ParallelBranchSlot[] = [
      { status: 'fulfilled', value: 'x', operationId: 'a' },
      { status: 'fulfilled', value: 'y', operationId: 'b' },
    ];

    const entry = buildEntryFromSlots('run-all', slots, ['first', 'second']);

    expect(entry.variant).toBe('run-all');
    expect(entry.branchNames).toEqual(['first', 'second']);
  });
});

describe('valuesFromSlots', () => {
  it('returns the values from a fully-fulfilled slot table', () => {
    const slots: ParallelBranchSlot[] = [
      { status: 'fulfilled', value: 1, operationId: 'a' },
      { status: 'fulfilled', value: 'two', operationId: 'b' },
    ];

    expect(valuesFromSlots(slots)).toEqual([1, 'two']);
  });

  it('throws when any slot is non-fulfilled', () => {
    const slots: ParallelBranchSlot[] = [
      { status: 'fulfilled', value: 1, operationId: 'a' },
      { status: 'pending', operationId: 'b' },
    ];

    expect(() => valuesFromSlots(slots)).toThrow(/pending/);
  });

  it('throws on a rejected slot with a useful message', () => {
    const slots: ParallelBranchSlot[] = [
      { status: 'rejected', reason: { name: 'Error', message: 'boom' }, operationId: 'a' },
    ];

    expect(() => valuesFromSlots(slots)).toThrow(/rejected/);
  });
});
