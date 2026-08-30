import { describe, expect, it } from 'bun:test';

import { DeadlineTracker } from './deadline-tracker.ts';

describe('DeadlineTracker', () => {
  it('returns undefined when empty', () => {
    const tracker = new DeadlineTracker();
    expect(tracker.peekDeadline()).toBeUndefined();
    expect(tracker.popMin()).toBeUndefined();
    expect(tracker.size).toBe(0);
  });

  it('maintains min-heap ordering', () => {
    const tracker = new DeadlineTracker();
    tracker.add({ operationId: 'c', deadline: 300 });
    tracker.add({ operationId: 'a', deadline: 100 });
    tracker.add({ operationId: 'b', deadline: 200 });

    expect(tracker.peekDeadline()).toBe(100);
    expect(tracker.popMin()?.operationId).toBe('a');
    expect(tracker.popMin()?.operationId).toBe('b');
    expect(tracker.popMin()?.operationId).toBe('c');
    expect(tracker.size).toBe(0);
  });

  it('drains only expired entries', () => {
    const tracker = new DeadlineTracker();
    tracker.add({ operationId: 'a', deadline: 100 });
    tracker.add({ operationId: 'b', deadline: 200 });
    tracker.add({ operationId: 'c', deadline: 300 });

    const expired = tracker.drainExpired(200);
    expect(expired.map((e) => e.operationId)).toEqual(['a', 'b']);
    expect(tracker.size).toBe(1);
    expect(tracker.peekDeadline()).toBe(300);
  });

  it('removes entries by operation ID', () => {
    const tracker = new DeadlineTracker();
    tracker.add({ operationId: 'a', deadline: 100 });
    tracker.add({ operationId: 'b', deadline: 200 });
    tracker.add({ operationId: 'c', deadline: 300 });

    tracker.remove('b');
    expect(tracker.size).toBe(2);

    const all = [tracker.popMin()!, tracker.popMin()!];
    expect(all.map((e) => e.operationId)).toEqual(['a', 'c']);
  });

  it('handles duplicate deadlines', () => {
    const tracker = new DeadlineTracker();
    tracker.add({ operationId: 'a', deadline: 100 });
    tracker.add({ operationId: 'b', deadline: 100 });

    const expired = tracker.drainExpired(100);
    expect(expired).toHaveLength(2);
    expect(tracker.size).toBe(0);
  });

  it('clears all entries', () => {
    const tracker = new DeadlineTracker();
    tracker.add({ operationId: 'a', deadline: 100 });
    tracker.add({ operationId: 'b', deadline: 200 });
    tracker.clear();
    expect(tracker.size).toBe(0);
  });

  it('handles remove on empty tracker', () => {
    const tracker = new DeadlineTracker();
    tracker.remove('nonexistent');
    expect(tracker.size).toBe(0);
  });

  it('handles drainExpired when no entries are expired', () => {
    const tracker = new DeadlineTracker();
    tracker.add({ operationId: 'a', deadline: 500 });
    tracker.add({ operationId: 'b', deadline: 600 });

    const expired = tracker.drainExpired(100);
    expect(expired).toHaveLength(0);
    expect(tracker.size).toBe(2);
  });

  it('correctly reorders after removal of the min element', () => {
    const tracker = new DeadlineTracker();
    tracker.add({ operationId: 'a', deadline: 100 });
    tracker.add({ operationId: 'b', deadline: 200 });
    tracker.add({ operationId: 'c', deadline: 150 });

    tracker.remove('a');
    expect(tracker.peekDeadline()).toBe(150);
    expect(tracker.popMin()?.operationId).toBe('c');
    expect(tracker.popMin()?.operationId).toBe('b');
  });

  it('stays consistent after remove then re-add with a new deadline', () => {
    const tracker = new DeadlineTracker();
    tracker.add({ operationId: 'a', deadline: 100 });
    tracker.add({ operationId: 'b', deadline: 200 });
    tracker.remove('a');
    tracker.add({ operationId: 'a', deadline: 50 });
    expect(tracker.peekDeadline()).toBe(50);
    expect(tracker.size).toBe(2);
    expect(tracker.popMin()?.operationId).toBe('a');
    expect(tracker.popMin()?.operationId).toBe('b');
  });

  it('removes all entries when the same operationId appears multiple times', () => {
    const tracker = new DeadlineTracker();
    tracker.add({ operationId: 'dup', deadline: 100 });
    tracker.add({ operationId: 'dup', deadline: 200 });
    tracker.add({ operationId: 'other', deadline: 150 });
    tracker.remove('dup');
    expect(tracker.size).toBe(1);
    expect(tracker.popMin()?.operationId).toBe('other');
  });
});
