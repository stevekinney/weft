// ---------------------------------------------------------------------------
// Characterization tests for TaskQueue.getQueueSummaries()
//
// These tests pin the byte-identical output of getQueueSummaries() across a
// curated set of registry states. If the projection logic changes in a way
// that alters the observable output these tests will catch it.
// ---------------------------------------------------------------------------

import { describe, expect, it } from 'bun:test';
import { buildQueueSummaries } from './task-queue-summary.ts';
import type { PendingTask } from './task-queue.ts';
import { TaskQueue } from './task-queue.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let opCounter = 0;
function makeTask(overrides: Partial<PendingTask> = {}): PendingTask {
  opCounter += 1;
  return {
    operationId: overrides.operationId ?? `op-${String(opCounter).padStart(4, '0')}`,
    activityName: overrides.activityName ?? 'process',
    input: overrides.input ?? {},
    enqueuedAt: overrides.enqueuedAt,
    priority: overrides.priority,
    attempt: overrides.attempt,
  };
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe('TaskQueue.getQueueSummaries() — empty queue', () => {
  it('returns an empty array when nothing has been enqueued', () => {
    const queue = new TaskQueue();
    expect(queue.getQueueSummaries()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Single queue, varying backlog depths
// ---------------------------------------------------------------------------

describe('TaskQueue.getQueueSummaries() — single queue backlog', () => {
  it('reports backlog=1 and oldest enqueuedAt for a single pending task', () => {
    const queue = new TaskQueue({ pendingTaskTimeToLive: Infinity });
    const task = makeTask({ enqueuedAt: 1_000_000 });
    queue.enqueue('alpha', task);

    const summaries = queue.getQueueSummaries();

    expect(summaries).toEqual([
      {
        queue: 'alpha',
        backlog: 1,
        oldestEnqueuedAt: 1_000_000,
        waitingPollers: 0,
        schedulingPolicy: 'priority',
      },
    ]);
  });

  it('reports the minimum enqueuedAt as oldestEnqueuedAt across multiple tasks', () => {
    const queue = new TaskQueue({ pendingTaskTimeToLive: Infinity });

    queue.enqueue('alpha', makeTask({ enqueuedAt: 3_000_000 }));
    queue.enqueue('alpha', makeTask({ enqueuedAt: 1_000_000 })); // oldest
    queue.enqueue('alpha', makeTask({ enqueuedAt: 2_000_000 }));

    const [summary] = queue.getQueueSummaries();
    expect(summary?.backlog).toBe(3);
    expect(summary?.oldestEnqueuedAt).toBe(1_000_000);
  });

  it('reports oldestEnqueuedAt=null when no pending task carries enqueuedAt', () => {
    // Tasks without enqueuedAt are set by enqueue via `??=`, so we cannot
    // easily construct this state through the public API. We verify via the
    // pure buildQueueSummaries function directly.
    const snapshot = {
      pending: new Map([['alpha', [{ enqueuedAt: undefined }]]]),
      waiters: new Map<string, unknown[]>(),
      schedulingPolicy: 'priority' as const,
    };

    const summaries = buildQueueSummaries(snapshot);
    expect(summaries[0]?.oldestEnqueuedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Multiple queues — sort order
// ---------------------------------------------------------------------------

describe('TaskQueue.getQueueSummaries() — multiple queues sorted by name', () => {
  it('returns queues sorted ascending by queue name', () => {
    const queue = new TaskQueue({ pendingTaskTimeToLive: Infinity });

    queue.enqueue('zebra', makeTask({ enqueuedAt: 1_000 }));
    queue.enqueue('alpha', makeTask({ enqueuedAt: 2_000 }));
    queue.enqueue('middle', makeTask({ enqueuedAt: 3_000 }));

    const names = queue.getQueueSummaries().map((s) => s.queue);
    expect(names).toEqual(['alpha', 'middle', 'zebra']);
  });
});

// ---------------------------------------------------------------------------
// Drained workers (waiters only, no backlog)
// ---------------------------------------------------------------------------

describe('TaskQueue.getQueueSummaries() — waiting pollers, drained backlog', () => {
  it('includes queues that have parked pollers but no pending tasks', async () => {
    const queue = new TaskQueue({ pendingTaskTimeToLive: Infinity });

    // Park two pollers on "workers" queue — they will never resolve in this test
    const controller = new AbortController();
    const p1 = queue.poll('workers', ['run'], 60_000, controller.signal);
    const p2 = queue.poll('workers', ['run'], 60_000, controller.signal);

    const summaries = queue.getQueueSummaries();

    expect(summaries).toEqual([
      {
        queue: 'workers',
        backlog: 0,
        oldestEnqueuedAt: null,
        waitingPollers: 2,
        schedulingPolicy: 'priority',
      },
    ]);

    // Clean up parked pollers
    controller.abort();
    await Promise.allSettled([p1, p2]);
  });

  it('merges waitingPollers into an existing pending-task entry for the same queue', async () => {
    const queue = new TaskQueue({ pendingTaskTimeToLive: Infinity });

    // One pending task for activity "alpha"
    queue.enqueue('default', makeTask({ activityName: 'alpha', enqueuedAt: 5_000 }));

    // One poller waiting for "beta" (no matching task, so it parks)
    const controller = new AbortController();
    const pollPromise = queue.poll('default', ['beta'], 60_000, controller.signal);

    const [summary] = queue.getQueueSummaries();

    expect(summary).toEqual({
      queue: 'default',
      backlog: 1,
      oldestEnqueuedAt: 5_000,
      waitingPollers: 1,
      schedulingPolicy: 'priority',
    });

    controller.abort();
    await pollPromise;
  });
});

// ---------------------------------------------------------------------------
// In-flight counts (dispatched tasks are not in the backlog)
// ---------------------------------------------------------------------------

describe('TaskQueue.getQueueSummaries() — in-flight / dispatched tasks', () => {
  it('does not count a dispatched task in the backlog', async () => {
    const queue = new TaskQueue({ pendingTaskTimeToLive: Infinity });

    // Park a poller first so the task is dispatched immediately on enqueue
    const pollPromise = queue.poll('default', ['work'], 60_000);

    queue.enqueue('default', makeTask({ activityName: 'work', enqueuedAt: 1_000 }));

    // Consume the dispatched task from the poll
    const dispatched = await pollPromise;
    expect(dispatched).not.toBeNull();

    // Queue should now show no backlog and no waiters
    expect(queue.getQueueSummaries()).toEqual([]);
  });

  it('reports the queue only for genuinely pending tasks after some are dispatched', async () => {
    const queue = new TaskQueue({ pendingTaskTimeToLive: Infinity });

    // Enqueue two tasks; dispatch one
    const dispatchedTask = makeTask({ activityName: 'work', enqueuedAt: 1_000 });
    const pendingTask = makeTask({ activityName: 'work', enqueuedAt: 2_000 });

    queue.enqueue('default', dispatchedTask);
    queue.enqueue('default', pendingTask);

    // Poll consumes the first task (lowest index in priority queue = enqueued first)
    await queue.poll('default', ['work'], 0);

    const [summary] = queue.getQueueSummaries();
    expect(summary?.backlog).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Scheduling policy surfaces in summaries
// ---------------------------------------------------------------------------

describe('TaskQueue.getQueueSummaries() — schedulingPolicy field', () => {
  it.each([['fifo'], ['lifo'], ['priority']] as const)('reports schedulingPolicy=%s', (policy) => {
    const queue = new TaskQueue({ schedulingPolicy: policy, pendingTaskTimeToLive: Infinity });
    queue.enqueue('q', makeTask({ enqueuedAt: 1_000 }));

    const [summary] = queue.getQueueSummaries();
    expect(summary?.schedulingPolicy).toBe(policy);
  });
});
