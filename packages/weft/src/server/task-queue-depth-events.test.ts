import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';

import {
  advanceTimersByTime,
  restoreRealTimers,
  useFakeTimers,
} from "../../test-support/embedded/testing/src/fake-timers.ts";
import { QueueDepthChangedEvent } from '../core/events/fleet-state-events.ts';
import {
  QUEUE_DEPTH_EVENT_INTERVAL_MILLISECONDS,
  TaskQueueDepthAnnouncer,
} from './task-queue-depth-announcer.ts';
import type { PendingTask } from './task-queue-types.ts';
import { TaskQueue } from './task-queue.ts';

const INTERVAL = QUEUE_DEPTH_EVENT_INTERVAL_MILLISECONDS;

function task(operationId: string, activityName = 'charge'): PendingTask {
  return { operationId, activityName, input: {} };
}

/** Collects the `[queue, depth]` pairs of every `queue:depth-changed` event dispatched. */
function recorder() {
  const seen: Array<[string, number]> = [];
  const dispatchEvent = (event: Event) => {
    expect(event).toBeInstanceOf(QueueDepthChangedEvent);
    const { queue, depth } = event as QueueDepthChangedEvent;
    seen.push([queue, depth]);
  };
  return { seen, dispatchEvent };
}

beforeEach(() => {
  useFakeTimers();
});

afterEach(() => {
  restoreRealTimers();
});

describe('QueueDepthChangedEvent', () => {
  it('carries the queue name and depth only', () => {
    const event = new QueueDepthChangedEvent('payments', 4);

    expect(event.type).toBe('queue:depth-changed');
    expect(Object.keys(event).toSorted()).toEqual(['depth', 'isTrusted', 'queue']);
    expect(event.queue).toBe('payments');
    expect(event.depth).toBe(4);
  });
});

describe('TaskQueueDepthAnnouncer', () => {
  it('announces the first change at once and nothing for an unchanged depth', () => {
    const { seen, dispatchEvent } = recorder();
    let depth = 0;
    using announcer = new TaskQueueDepthAnnouncer(() => depth, dispatchEvent);

    announcer.changed('q');
    expect(seen).toEqual([]);

    depth = 2;
    announcer.changed('q');
    expect(seen).toEqual([['q', 2]]);
  });

  it('collapses a burst into the first change and one trailing event with the latest depth', async () => {
    const { seen, dispatchEvent } = recorder();
    let depth = 0;
    using announcer = new TaskQueueDepthAnnouncer(() => depth, dispatchEvent);

    for (const next of [1, 2, 3, 4, 5]) {
      depth = next;
      announcer.changed('q');
    }
    expect(seen).toEqual([['q', 1]]);

    await advanceTimersByTime(INTERVAL - 1);
    expect(seen).toEqual([['q', 1]]);

    await advanceTimersByTime(1);
    expect(seen).toEqual([
      ['q', 1],
      ['q', 5],
    ]);
  });

  it('emits 0 at the end of a burst that drains the queue', async () => {
    const { seen, dispatchEvent } = recorder();
    let depth = 0;
    using announcer = new TaskQueueDepthAnnouncer(() => depth, dispatchEvent);

    for (let step = 0; step < 10; step++) {
      depth = step + 1;
      announcer.changed('q');
    }
    for (let step = 9; step >= 0; step--) {
      depth = step;
      announcer.changed('q');
    }
    expect(seen).toEqual([['q', 1]]);

    await advanceTimersByTime(INTERVAL);
    expect(seen).toEqual([
      ['q', 1],
      ['q', 0],
    ]);
    // The queue is empty and quiet again, so no further window fires.
    await advanceTimersByTime(INTERVAL * 5);
    expect(seen).toHaveLength(2);
  });

  it('stays silent when the depth returns to the announced value inside the window', async () => {
    const { seen, dispatchEvent } = recorder();
    let depth = 1;
    using announcer = new TaskQueueDepthAnnouncer(() => depth, dispatchEvent);

    announcer.changed('q');
    depth = 3;
    announcer.changed('q');
    depth = 1;
    announcer.changed('q');
    await advanceTimersByTime(INTERVAL * 3);

    expect(seen).toEqual([['q', 1]]);
  });

  it('emits at most once per interval while the depth keeps changing', async () => {
    const { seen, dispatchEvent } = recorder();
    let depth = 0;
    using announcer = new TaskQueueDepthAnnouncer(() => depth, dispatchEvent);

    for (let second = 0; second < 4; second++) {
      depth += 1;
      announcer.changed('q');
      depth += 1;
      announcer.changed('q');
      await advanceTimersByTime(INTERVAL);
    }

    // One event at second 0, then one trailing event per closed window.
    expect(seen.map(([, announced]) => announced)).toEqual([1, 2, 4, 6, 8]);
  });

  it('announces a change after a quiet interval at once', async () => {
    const { seen, dispatchEvent } = recorder();
    let depth = 1;
    using announcer = new TaskQueueDepthAnnouncer(() => depth, dispatchEvent);

    announcer.changed('q');
    await advanceTimersByTime(INTERVAL);
    depth = 2;
    announcer.changed('q');

    expect(seen).toEqual([
      ['q', 1],
      ['q', 2],
    ]);
  });

  it('keeps queues independent', async () => {
    const { seen, dispatchEvent } = recorder();
    const depths = new Map([
      ['a', 0],
      ['b', 0],
    ]);
    using announcer = new TaskQueueDepthAnnouncer((queue) => depths.get(queue) ?? 0, dispatchEvent);

    depths.set('a', 1);
    announcer.changed('a');
    depths.set('a', 2);
    announcer.changed('a');
    depths.set('b', 7);
    announcer.changed('b');

    expect(seen).toEqual([
      ['a', 1],
      ['b', 7],
    ]);

    await advanceTimersByTime(INTERVAL);
    expect(seen).toEqual([
      ['a', 1],
      ['b', 7],
      ['a', 2],
    ]);
  });

  it('cancels open windows and ignores later changes after dispose', async () => {
    const { seen, dispatchEvent } = recorder();
    let depth = 1;
    const announcer = new TaskQueueDepthAnnouncer(() => depth, dispatchEvent);

    announcer.changed('q');
    depth = 4;
    announcer.changed('q');
    announcer[Symbol.dispose]();
    announcer[Symbol.dispose]();
    announcer.changed('q');
    await advanceTimersByTime(INTERVAL * 3);

    expect(seen).toEqual([['q', 1]]);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('TaskQueue depth events', () => {
  it('announces an enqueue and a claim', async () => {
    const { seen, dispatchEvent } = recorder();
    using queue = new TaskQueue({ dispatchEvent });

    queue.enqueue('q', task('a'));
    expect(seen).toEqual([['q', 1]]);

    await advanceTimersByTime(INTERVAL);
    await queue.poll('q', ['charge'], 10);
    expect(seen).toEqual([
      ['q', 1],
      ['q', 0],
    ]);
  });

  it('raises nothing when a task goes straight to a parked worker', async () => {
    const { seen, dispatchEvent } = recorder();
    using queue = new TaskQueue({ dispatchEvent });

    const parked = queue.poll('q', ['charge'], INTERVAL * 10);
    queue.enqueue('q', task('a'));
    expect(await parked).toMatchObject({ operationId: 'a' });
    await advanceTimersByTime(INTERVAL * 2);

    expect(seen).toEqual([]);
  });

  it('announces withdrawPending and restorePending', async () => {
    const { seen, dispatchEvent } = recorder();
    using queue = new TaskQueue({ dispatchEvent });

    queue.enqueue('q', task('a'));
    await advanceTimersByTime(INTERVAL);
    const withdrawn = queue.withdrawPending('q', () => true)!;
    expect(seen).toEqual([
      ['q', 1],
      ['q', 0],
    ]);

    await advanceTimersByTime(INTERVAL);
    expect(queue.restorePending(withdrawn)).toBe(true);
    expect(seen).toEqual([
      ['q', 1],
      ['q', 0],
      ['q', 1],
    ]);
  });

  it('raises nothing when restorePending hands the task to a parked worker', async () => {
    const { seen, dispatchEvent } = recorder();
    using queue = new TaskQueue({ dispatchEvent });

    queue.enqueue('q', task('a'));
    await advanceTimersByTime(INTERVAL);
    const withdrawn = queue.withdrawPending('q', () => true)!;
    await advanceTimersByTime(INTERVAL);
    seen.length = 0;
    const parked = queue.poll('q', ['charge'], INTERVAL * 10);

    expect(queue.restorePending(withdrawn)).toBe(true);
    expect(await parked).toMatchObject({ operationId: 'a' });
    expect(seen).toEqual([]);
  });

  it('announces an expiry', async () => {
    const { seen, dispatchEvent } = recorder();
    using queue = new TaskQueue({ dispatchEvent, pendingTaskTimeToLive: INTERVAL * 2 });

    queue.enqueue('q', task('a'));
    expect(seen).toEqual([['q', 1]]);

    await advanceTimersByTime(INTERVAL * 2);
    expect(seen).toEqual([
      ['q', 1],
      ['q', 0],
    ]);
  });

  it('announces the depth after removeStale for every queue it shrank, and only those', async () => {
    const { seen, dispatchEvent } = recorder();
    using queue = new TaskQueue({ dispatchEvent, pendingTaskTimeToLive: Infinity });

    queue.enqueue('stale', { ...task('s1'), enqueuedAt: 0 });
    queue.enqueue('mixed', { ...task('m1'), enqueuedAt: 0 });
    queue.enqueue('mixed', { ...task('m2'), enqueuedAt: Date.now() + INTERVAL * 100 });
    queue.enqueue('fresh', { ...task('f1'), enqueuedAt: Date.now() + INTERVAL * 100 });
    // Two intervals: the trailing event for 'mixed' opens a second window, which must close too.
    await advanceTimersByTime(INTERVAL * 2);
    seen.length = 0;

    expect(queue.removeStale(1)).toHaveLength(2);

    expect(seen).toEqual([
      ['stale', 0],
      ['mixed', 1],
    ]);
  });

  it('reports a burst of enqueues and claims that ends at 0 as a trailing 0', async () => {
    const { seen, dispatchEvent } = recorder();
    using queue = new TaskQueue({ dispatchEvent });

    for (let index = 0; index < 5; index++) queue.enqueue('q', task(`op-${index}`));
    for (let index = 0; index < 5; index++) await queue.poll('q', ['charge'], 10);
    expect(seen).toEqual([['q', 1]]);

    await advanceTimersByTime(INTERVAL);

    expect(seen).toEqual([
      ['q', 1],
      ['q', 0],
    ]);
  });

  it('keeps queues independent', async () => {
    const { seen, dispatchEvent } = recorder();
    using queue = new TaskQueue({ dispatchEvent });

    queue.enqueue('a', task('a1'));
    queue.enqueue('a', task('a2'));
    queue.enqueue('b', task('b1'));

    expect(seen).toEqual([
      ['a', 1],
      ['b', 1],
    ]);
    await advanceTimersByTime(INTERVAL);
    expect(seen).toEqual([
      ['a', 1],
      ['b', 1],
      ['a', 2],
    ]);
  });

  it('raises nothing when no dispatchEvent is configured', async () => {
    using queue = new TaskQueue();

    queue.enqueue('q', task('a'));
    await advanceTimersByTime(INTERVAL * 2);

    expect(queue.pendingCount('q')).toBe(1);
  });

  it('clears its coalescing timers on dispose and announces nothing afterwards', async () => {
    const { seen, dispatchEvent } = recorder();
    const queue = new TaskQueue({ dispatchEvent, pendingTaskTimeToLive: Infinity });

    queue.enqueue('q', task('a'));
    queue.enqueue('q', task('b'));
    expect(jest.getTimerCount()).toBe(1);

    queue[Symbol.dispose]();
    expect(jest.getTimerCount()).toBe(0);

    queue.enqueue('q', task('c'));
    await advanceTimersByTime(INTERVAL * 3);
    expect(seen).toEqual([['q', 1]]);
    expect(jest.getTimerCount()).toBe(0);
  });
});
