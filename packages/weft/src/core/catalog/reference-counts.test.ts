import { describe, expect, it } from 'bun:test';

import {
  decrementNestedRevisionCount,
  incrementNestedRevisionCount,
  readNestedRevisionCount,
  totalWorkflowRevisionReferences,
  type WorkflowRevisionReferenceCounts,
} from './reference-counts.ts';

describe('nested revision count helpers', () => {
  it('increments a (name, revision) count from absent, creating the inner map', () => {
    const counts = new Map<string, Map<string, number>>();
    incrementNestedRevisionCount(counts, 'checkout', 'r1');
    expect(readNestedRevisionCount(counts, 'checkout', 'r1')).toBe(1);
    incrementNestedRevisionCount(counts, 'checkout', 'r1');
    expect(readNestedRevisionCount(counts, 'checkout', 'r1')).toBe(2);
  });

  it('keeps distinct (name, revision) keys independent', () => {
    const counts = new Map<string, Map<string, number>>();
    incrementNestedRevisionCount(counts, 'checkout', 'r1');
    incrementNestedRevisionCount(counts, 'checkout', 'r2');
    incrementNestedRevisionCount(counts, 'billing', 'r1');

    expect(readNestedRevisionCount(counts, 'checkout', 'r1')).toBe(1);
    expect(readNestedRevisionCount(counts, 'checkout', 'r2')).toBe(1);
    expect(readNestedRevisionCount(counts, 'billing', 'r1')).toBe(1);
  });

  it('decrementing to zero removes the revision entry rather than leaving a stale 0', () => {
    const counts = new Map<string, Map<string, number>>();
    incrementNestedRevisionCount(counts, 'checkout', 'r1');
    decrementNestedRevisionCount(counts, 'checkout', 'r1');

    expect(readNestedRevisionCount(counts, 'checkout', 'r1')).toBe(0);
    expect(counts.get('checkout')).toBeUndefined();
  });

  it('decrementing above zero leaves a positive count and the inner map intact', () => {
    const counts = new Map<string, Map<string, number>>();
    incrementNestedRevisionCount(counts, 'checkout', 'r1');
    incrementNestedRevisionCount(counts, 'checkout', 'r1');
    decrementNestedRevisionCount(counts, 'checkout', 'r1');

    expect(readNestedRevisionCount(counts, 'checkout', 'r1')).toBe(1);
    expect(counts.get('checkout')).toBeDefined();
  });

  it('decrementing an absent (name, revision) is a no-op, never negative', () => {
    const counts = new Map<string, Map<string, number>>();
    decrementNestedRevisionCount(counts, 'checkout', 'r1');
    expect(readNestedRevisionCount(counts, 'checkout', 'r1')).toBe(0);
    expect(counts.size).toBe(0);
  });

  it('decrementing one revision leaves a sibling revision under the same name untouched', () => {
    const counts = new Map<string, Map<string, number>>();
    incrementNestedRevisionCount(counts, 'checkout', 'r1');
    incrementNestedRevisionCount(counts, 'checkout', 'r2');
    decrementNestedRevisionCount(counts, 'checkout', 'r1');

    expect(readNestedRevisionCount(counts, 'checkout', 'r1')).toBe(0);
    expect(readNestedRevisionCount(counts, 'checkout', 'r2')).toBe(1);
  });

  it('readNestedRevisionCount on an absent name or revision returns 0', () => {
    const counts = new Map<string, Map<string, number>>();
    incrementNestedRevisionCount(counts, 'checkout', 'r1');

    expect(readNestedRevisionCount(counts, 'unknown-name', 'r1')).toBe(0);
    expect(readNestedRevisionCount(counts, 'checkout', 'unknown-revision')).toBe(0);
  });

  it('handles __proto__/toString-shaped names and revisions safely', () => {
    const counts = new Map<string, Map<string, number>>();
    incrementNestedRevisionCount(counts, '__proto__', 'toString');
    expect(readNestedRevisionCount(counts, '__proto__', 'toString')).toBe(1);
    expect(readNestedRevisionCount(counts, 'toString', '__proto__')).toBe(0);
  });
});

describe('totalWorkflowRevisionReferences', () => {
  const zero: WorkflowRevisionReferenceCounts = {
    registeredDefinitions: 0,
    inFlightStarts: 0,
    nonTerminalRuns: 0,
    pinnedSchedules: 0,
    pendingDispatches: 0,
    activeExecutionRealms: 0,
    retainedRecoveryRecords: 0,
  };

  it('sums to 0 when every field is 0', () => {
    expect(totalWorkflowRevisionReferences(zero)).toBe(0);
  });

  it('sums every field', () => {
    const counts: WorkflowRevisionReferenceCounts = {
      registeredDefinitions: 1,
      inFlightStarts: 2,
      nonTerminalRuns: 3,
      pinnedSchedules: 4,
      pendingDispatches: 5,
      activeExecutionRealms: 6,
      retainedRecoveryRecords: 7,
    };
    expect(totalWorkflowRevisionReferences(counts)).toBe(28);
  });

  it('is nonzero when only one field is nonzero', () => {
    expect(totalWorkflowRevisionReferences({ ...zero, inFlightStarts: 1 })).toBe(1);
  });
});
