import { describe, expect, it } from 'bun:test';

import type { TaskResultMessage } from './protocol.ts';
import { isOutboxFull, MAX_BUFFERED_TASK_RESULTS, TaskResultOutbox } from './task-result-outbox.ts';

function completed(operationId: string, value: string): TaskResultMessage {
  return { type: 'taskResult', operationId, status: 'completed', value };
}

describe('isOutboxFull', () => {
  it('reports true at or above the ceiling', () => {
    expect(isOutboxFull(0, 1)).toBe(false);
    expect(isOutboxFull(1, 1)).toBe(true);
    expect(isOutboxFull(2, 1)).toBe(true);
    expect(isOutboxFull(MAX_BUFFERED_TASK_RESULTS - 1, MAX_BUFFERED_TASK_RESULTS)).toBe(false);
    expect(isOutboxFull(MAX_BUFFERED_TASK_RESULTS, MAX_BUFFERED_TASK_RESULTS)).toBe(true);
  });
});

describe('TaskResultOutbox', () => {
  it('defaults to the shared ceiling', () => {
    const outbox = new TaskResultOutbox();
    expect(outbox.size).toBe(0);
    expect(outbox.full).toBe(false);
  });

  it('dedupes by operationId and preserves insertion order', () => {
    const outbox = new TaskResultOutbox();
    outbox.buffer(completed('a', 'first'));
    outbox.buffer(completed('b', 'second'));
    outbox.buffer(completed('a', 'replacement'));

    expect(outbox.size).toBe(2);
    const order = outbox.drainOrder();
    expect(order.map((m) => m.operationId)).toEqual(['a', 'b']);
    // The replacement value wins for the deduped key.
    expect(order[0]).toMatchObject({ operationId: 'a', value: 'replacement' });
  });

  it('delete removes a buffered entry', () => {
    const outbox = new TaskResultOutbox();
    outbox.buffer(completed('a', 'x'));
    outbox.delete('a');
    expect(outbox.size).toBe(0);
    expect(outbox.drainOrder()).toEqual([]);
  });

  it('reports full once the ceiling is reached', () => {
    const outbox = new TaskResultOutbox(2);
    expect(outbox.full).toBe(false);
    outbox.buffer(completed('a', 'x'));
    expect(outbox.full).toBe(false);
    outbox.buffer(completed('b', 'y'));
    expect(outbox.full).toBe(true);
  });

  it('warns at most once per full episode', () => {
    const outbox = new TaskResultOutbox(1);
    outbox.buffer(completed('a', 'x'));
    expect(outbox.full).toBe(true);
    expect(outbox.shouldWarnFull()).toBe(true);
    expect(outbox.shouldWarnFull()).toBe(false);

    // Draining below the cap re-arms the warning for the next full episode.
    outbox.delete('a');
    expect(outbox.full).toBe(false);
    outbox.buffer(completed('b', 'y'));
    expect(outbox.shouldWarnFull()).toBe(true);
  });

  it('clear re-arms the full warning', () => {
    const outbox = new TaskResultOutbox(1);
    outbox.buffer(completed('a', 'x'));
    expect(outbox.shouldWarnFull()).toBe(true);
    outbox.clear();
    outbox.buffer(completed('b', 'y'));
    expect(outbox.shouldWarnFull()).toBe(true);
  });

  it('rejects an invalid ceiling', () => {
    expect(() => new TaskResultOutbox(-1)).toThrow(RangeError);
    expect(() => new TaskResultOutbox(1.5)).toThrow(RangeError);
    expect(() => new TaskResultOutbox(Number.NaN)).toThrow(RangeError);
    expect(() => new TaskResultOutbox(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => new TaskResultOutbox(0)).not.toThrow();
  });

  it('clear discards everything', () => {
    const outbox = new TaskResultOutbox();
    outbox.buffer(completed('a', 'x'));
    outbox.buffer(completed('b', 'y'));
    outbox.clear();
    expect(outbox.size).toBe(0);
    expect(outbox.drainOrder()).toEqual([]);
  });
});
