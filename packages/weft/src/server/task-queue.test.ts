import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  restoreRealTimers,
  sleepForTesting,
  useFakeTimers,
} from '../testing/fake-timers.test-support.ts';

import type { PendingTask, TaskResult } from './task-queue-types.ts';
import { TaskQueue } from './task-queue.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<PendingTask> = {}): PendingTask {
  return {
    operationId: overrides.operationId ?? `op-${crypto.randomUUID().slice(0, 8)}`,
    activityName: overrides.activityName ?? 'charge',
    input: overrides.input ?? { amount: 100 },
    attempt: overrides.attempt,
    priority: overrides.priority,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskQueue', () => {
  describe('enqueue and poll', () => {
    it('returns a queued task immediately when a matching poll arrives', async () => {
      const queue = new TaskQueue();
      const task = makeTask({ activityName: 'charge' });

      queue.enqueue('default', task);

      const result = await queue.poll('default', ['charge'], 1000);

      expect(result).toEqual(task);
    });

    it('returns null when no matching task exists and timeout expires', async () => {
      const queue = new TaskQueue();

      const result = await queue.poll('default', ['charge'], 50);

      expect(result).toBeNull();
    });

    it('dispatches directly to a waiting poller when a task is enqueued', async () => {
      const queue = new TaskQueue();

      // Start a poll that will block
      const pollPromise = queue.poll('default', ['charge'], 5000);

      // Enqueue a task — should resolve the waiting poll immediately
      const task = makeTask({ activityName: 'charge' });
      queue.enqueue('default', task);

      const result = await pollPromise;
      expect(result).toEqual(task);
    });

    it('respects activity filtering on poll', async () => {
      const queue = new TaskQueue();

      queue.enqueue('default', makeTask({ activityName: 'ship' }));

      // Poll for 'charge' — should not match the 'ship' task
      const result = await queue.poll('default', ['charge'], 50);

      expect(result).toBeNull();
      expect(queue.pendingCount('default')).toBe(1);
    });

    it('respects activity filtering on enqueue with waiters', async () => {
      const queue = new TaskQueue();

      // Waiter wants 'charge' only
      const pollPromise = queue.poll('default', ['charge'], 5000);

      // Enqueue a 'ship' task — should not match the waiter
      queue.enqueue('default', makeTask({ activityName: 'ship' }));

      // Enqueue a 'charge' task — should match
      const chargeTask = makeTask({ activityName: 'charge' });
      queue.enqueue('default', chargeTask);

      const result = await pollPromise;
      expect(result).toEqual(chargeTask);
      // The 'ship' task should still be pending
      expect(queue.pendingCount('default')).toBe(1);
    });

    it('isolates tasks by queue name', async () => {
      const queue = new TaskQueue();

      queue.enqueue('billing', makeTask({ activityName: 'charge' }));

      const result = await queue.poll('shipping', ['charge'], 50);

      expect(result).toBeNull();
      expect(queue.pendingCount('billing')).toBe(1);
    });

    it('serves tasks in FIFO order', async () => {
      const queue = new TaskQueue();

      const first = makeTask({ operationId: 'first', activityName: 'charge' });
      const second = makeTask({ operationId: 'second', activityName: 'charge' });
      queue.enqueue('default', first);
      queue.enqueue('default', second);

      const result1 = await queue.poll('default', ['charge'], 100);
      const result2 = await queue.poll('default', ['charge'], 100);

      expect(result1?.operationId).toBe('first');
      expect(result2?.operationId).toBe('second');
    });

    it('resolves the earliest waiter when multiple are waiting', async () => {
      const queue = new TaskQueue();

      const poll1 = queue.poll('default', ['charge'], 5000);
      const poll2 = queue.poll('default', ['charge'], 5000);

      const task = makeTask({ activityName: 'charge' });
      queue.enqueue('default', task);

      const result1 = await poll1;
      expect(result1).toEqual(task);

      // Second poller is still waiting — enqueue another task
      const task2 = makeTask({ activityName: 'charge' });
      queue.enqueue('default', task2);

      const result2 = await poll2;
      expect(result2).toEqual(task2);
    });

    it('supports multiple activities in a single poll', async () => {
      const queue = new TaskQueue();

      const task = makeTask({ activityName: 'ship' });
      queue.enqueue('default', task);

      const result = await queue.poll('default', ['charge', 'ship', 'refund'], 100);

      expect(result).toEqual(task);
    });
  });

  describe('abort signal', () => {
    it('resolves null when the signal is aborted', async () => {
      const queue = new TaskQueue();
      const controller = new AbortController();

      const pollPromise = queue.poll('default', ['charge'], 60_000, controller.signal);

      controller.abort();

      const result = await pollPromise;
      expect(result).toBeNull();
    });

    it('resolves null immediately when the signal is already aborted (no parked waiter)', async () => {
      const queue = new TaskQueue();
      const controller = new AbortController();
      controller.abort();

      // An already-aborted signal must not park a waiter: AbortSignal does not
      // re-fire `abort` for late listeners, so a parked waiter would wait out
      // the full timeout.
      const result = await queue.poll('default', ['charge'], 60_000, controller.signal);

      expect(result).toBeNull();
      expect(queue.hasWaiter('default', 'charge')).toBe(false);
    });

    it('does not hand a pending task to an already-aborted poll; the task stays queued', async () => {
      const queue = new TaskQueue();
      const controller = new AbortController();
      controller.abort();

      queue.enqueue('default', makeTask({ operationId: 'queued', activityName: 'charge' }));

      // The caller has already disconnected — it must not claim the task.
      const result = await queue.poll('default', ['charge'], 60_000, controller.signal);

      expect(result).toBeNull();
      // The task remains available for a live worker to claim.
      expect(queue.pendingCount('default')).toBe(1);
      expect(queue.isTracked('queued')).toBe(true);
    });

    it('cleans up the waiter after abort', async () => {
      const queue = new TaskQueue();
      const controller = new AbortController();

      const pollPromise = queue.poll('default', ['charge'], 60_000, controller.signal);
      expect(queue.hasWaiter('default', 'charge')).toBe(true);

      controller.abort();
      await pollPromise;

      expect(queue.hasWaiter('default', 'charge')).toBe(false);
    });

    it('does not accumulate abort listeners across many polls on the same signal', async () => {
      const queue = new TaskQueue();
      const controller = new AbortController();

      // Wrap the real signal so we can count `addEventListener` /
      // `removeEventListener` calls. The wrapper forwards every other
      // AbortSignal API to the underlying signal so the queue treats it
      // identically.
      let addedAbortListeners = 0;
      let removedAbortListeners = 0;
      const realSignal = controller.signal;
      const countingSignal = new Proxy(realSignal, {
        get(target, property) {
          if (property === 'addEventListener') {
            return (
              type: string,
              listener: EventListenerOrEventListenerObject,
              options?: AddEventListenerOptions | boolean,
            ) => {
              if (type === 'abort') addedAbortListeners += 1;
              target.addEventListener(type, listener, options);
            };
          }
          if (property === 'removeEventListener') {
            return (
              type: string,
              listener: EventListenerOrEventListenerObject,
              options?: EventListenerOptions | boolean,
            ) => {
              if (type === 'abort') removedAbortListeners += 1;
              target.removeEventListener(type, listener, options);
            };
          }
          // Read off `target`, not `receiver`: getters like `aborted` are
          // native AbortSignal accessors that throw when invoked with the
          // proxy as `this`. `Reflect.get(target, property, target)` runs them
          // against the real signal.
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      // Poll many times with a tight timeout so each call settles via the
      // timer path (not via abort). Every settled poll must remove its
      // listener — otherwise the count grows linearly.
      const iterations = 50;
      for (let i = 0; i < iterations; i += 1) {
        const result = await queue.poll('default', ['charge'], 1, countingSignal);
        expect(result).toBeNull();
      }

      expect(addedAbortListeners).toBe(iterations);
      expect(removedAbortListeners).toBe(iterations);
    });
  });

  describe('complete', () => {
    it('invokes the completion callback registered during enqueue', () => {
      const queue = new TaskQueue();
      const results: TaskResult[] = [];

      const task = makeTask({ operationId: 'op-1' });
      queue.enqueue('default', task, (result) => results.push(result));

      const found = queue.complete({
        operationId: 'op-1',
        status: 'completed',
        value: 42,
      });

      expect(found).toBe(true);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        operationId: 'op-1',
        status: 'completed',
        value: 42,
      });
    });

    it('returns false when no callback is registered', () => {
      const queue = new TaskQueue();

      const found = queue.complete({
        operationId: 'op-unknown',
        status: 'completed',
        value: null,
      });

      expect(found).toBe(false);
    });

    it('removes the callback after invocation', () => {
      const queue = new TaskQueue();
      let callCount = 0;

      const task = makeTask({ operationId: 'op-once' });
      queue.enqueue('default', task, () => {
        callCount += 1;
      });

      queue.complete({ operationId: 'op-once', status: 'completed' });
      queue.complete({ operationId: 'op-once', status: 'completed' });

      expect(callCount).toBe(1);
    });

    it('forwards failure results to the callback', () => {
      const queue = new TaskQueue();
      const results: TaskResult[] = [];

      const task = makeTask({ operationId: 'op-fail' });
      queue.enqueue('default', task, (result) => results.push(result));

      queue.complete({
        operationId: 'op-fail',
        status: 'failed',
        error: 'something broke',
      });

      expect(results[0]?.status).toBe('failed');
      expect(results[0]?.error).toBe('something broke');
    });
  });

  describe('hasWaiter', () => {
    it('returns true when a waiter can handle the activity', async () => {
      const queue = new TaskQueue();

      // Start a poll that will block
      const pollPromise = queue.poll('default', ['charge', 'ship'], 5000);

      expect(queue.hasWaiter('default', 'charge')).toBe(true);
      expect(queue.hasWaiter('default', 'ship')).toBe(true);
      expect(queue.hasWaiter('default', 'refund')).toBe(false);

      // Clean up
      queue.enqueue('default', makeTask({ activityName: 'charge' }));
      await pollPromise;
    });

    it('returns false when no waiters exist', () => {
      const queue = new TaskQueue();

      expect(queue.hasWaiter('default', 'charge')).toBe(false);
    });
  });

  describe('deduplication', () => {
    it('rejects a second enqueue with the same operationId', () => {
      const queue = new TaskQueue();

      const first = queue.enqueue('default', makeTask({ operationId: 'op-1' }));
      const second = queue.enqueue('default', makeTask({ operationId: 'op-1' }));

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(queue.pendingCount('default')).toBe(1);
    });

    it('rejects duplicate even when first was dispatched to a waiter', async () => {
      const queue = new TaskQueue();

      // Start a poll that will block
      const pollPromise = queue.poll('default', ['charge'], 5000);

      // Enqueue — dispatched directly to waiter
      const first = queue.enqueue(
        'default',
        makeTask({ operationId: 'dup-1', activityName: 'charge' }),
      );
      expect(first).toBe(true);
      await pollPromise;

      // Second enqueue with same operationId should be rejected
      const second = queue.enqueue(
        'default',
        makeTask({ operationId: 'dup-1', activityName: 'charge' }),
      );
      expect(second).toBe(false);
    });

    it('allows re-enqueue after completion', () => {
      const queue = new TaskQueue();

      queue.enqueue('default', makeTask({ operationId: 'op-reuse' }), () => {});
      queue.complete({ operationId: 'op-reuse', status: 'completed', value: null });

      // After completion the operationId should be available again
      const result = queue.enqueue('default', makeTask({ operationId: 'op-reuse' }));
      expect(result).toBe(true);
    });

    it('isTracked returns true for pending tasks', () => {
      const queue = new TaskQueue();

      expect(queue.isTracked('op-1')).toBe(false);

      queue.enqueue('default', makeTask({ operationId: 'op-1' }));
      expect(queue.isTracked('op-1')).toBe(true);
    });

    it('isTracked returns false after task is completed', () => {
      const queue = new TaskQueue();

      queue.enqueue('default', makeTask({ operationId: 'op-1' }), () => {});
      queue.complete({ operationId: 'op-1', status: 'completed' });

      expect(queue.isTracked('op-1')).toBe(false);
    });
  });

  describe('removeStale', () => {
    it('removes tasks older than maxAge and invokes completion callbacks with failed status', () => {
      const queue = new TaskQueue();
      const results: TaskResult[] = [];

      const task = makeTask({ operationId: 'stale-1' });
      // Backdate the enqueuedAt so the task appears old
      task.enqueuedAt = Date.now() - 10_000;

      queue.enqueue('default', task, (result) => results.push(result));

      const removed = queue.removeStale(5_000);

      expect(removed).toHaveLength(1);
      expect(removed[0]?.operationId).toBe('stale-1');
      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe('failed');
      expect(results[0]?.error).toContain('expired');
      expect(queue.pendingCount('default')).toBe(0);
      expect(queue.isTracked('stale-1')).toBe(false);
    });

    it('does not remove tasks younger than maxAge', () => {
      const queue = new TaskQueue();
      const task = makeTask({ operationId: 'fresh-1' });

      queue.enqueue('default', task);

      const removed = queue.removeStale(60_000);

      expect(removed).toHaveLength(0);
      expect(queue.pendingCount('default')).toBe(1);
      expect(queue.isTracked('fresh-1')).toBe(true);
    });

    it('allows re-enqueue of a stale operationId after removal', () => {
      const queue = new TaskQueue();
      const task = makeTask({ operationId: 'reuse-stale' });
      task.enqueuedAt = Date.now() - 10_000;

      queue.enqueue('default', task);
      queue.removeStale(5_000);

      expect(queue.isTracked('reuse-stale')).toBe(false);

      const reEnqueued = queue.enqueue('default', makeTask({ operationId: 'reuse-stale' }));
      expect(reEnqueued).toBe(true);
      expect(queue.pendingCount('default')).toBe(1);
    });
  });

  describe('pendingCount', () => {
    it('tracks the number of pending tasks', () => {
      const queue = new TaskQueue();

      expect(queue.pendingCount('default')).toBe(0);

      queue.enqueue('default', makeTask());
      queue.enqueue('default', makeTask());

      expect(queue.pendingCount('default')).toBe(2);
    });

    it('decrements when tasks are polled', async () => {
      const queue = new TaskQueue();

      queue.enqueue('default', makeTask({ activityName: 'charge' }));
      queue.enqueue('default', makeTask({ activityName: 'charge' }));

      await queue.poll('default', ['charge'], 100);

      expect(queue.pendingCount('default')).toBe(1);
    });

    it('returns 0 for unknown queues', () => {
      const queue = new TaskQueue();

      expect(queue.pendingCount('nonexistent')).toBe(0);
    });
  });

  describe('pending task expiration', () => {
    beforeEach(() => {
      useFakeTimers();
    });

    afterEach(() => {
      restoreRealTimers();
    });

    it('removes a pending task after the TTL expires', async () => {
      const queue = new TaskQueue({ pendingTaskTimeToLive: 50 });

      queue.enqueue('default', makeTask({ operationId: 'ttl-1', activityName: 'charge' }));
      expect(queue.pendingCount('default')).toBe(1);
      expect(queue.isTracked('ttl-1')).toBe(true);

      // Wait for the TTL to fire
      await sleepForTesting(100);

      expect(queue.pendingCount('default')).toBe(0);
      expect(queue.isTracked('ttl-1')).toBe(false);
    });

    it('invokes the completion callback with a failure on expiration', async () => {
      const queue = new TaskQueue({ pendingTaskTimeToLive: 50 });
      const results: TaskResult[] = [];

      queue.enqueue('default', makeTask({ operationId: 'ttl-cb' }), (result) =>
        results.push(result),
      );

      await sleepForTesting(100);

      expect(results).toHaveLength(1);
      expect(results[0]?.operationId).toBe('ttl-cb');
      expect(results[0]?.status).toBe('failed');
      expect(results[0]?.error).toContain('expired');
    });

    it('does not expire a task that was polled before the TTL', async () => {
      const queue = new TaskQueue({ pendingTaskTimeToLive: 100 });
      const results: TaskResult[] = [];

      queue.enqueue(
        'default',
        makeTask({ operationId: 'ttl-polled', activityName: 'charge' }),
        (result) => results.push(result),
      );

      // Poll the task before expiration
      const task = await queue.poll('default', ['charge'], 1000);
      expect(task?.operationId).toBe('ttl-polled');

      // Wait past the original TTL
      await sleepForTesting(150);

      // Callback should not have been invoked by expiration
      expect(results).toHaveLength(0);
      // The task is no longer pending (it was polled), but still tracked as dispatched
      expect(queue.pendingCount('default')).toBe(0);
    });

    it('does not expire a task dispatched directly to a waiter', async () => {
      const queue = new TaskQueue({ pendingTaskTimeToLive: 50 });
      const results: TaskResult[] = [];

      // Start a poll that will block
      const pollPromise = queue.poll('default', ['charge'], 5000);

      // Enqueue — dispatched directly to the waiter, never enters #pending
      queue.enqueue(
        'default',
        makeTask({ operationId: 'ttl-direct', activityName: 'charge' }),
        (result) => results.push(result),
      );

      const task = await pollPromise;
      expect(task?.operationId).toBe('ttl-direct');

      // Wait past TTL
      await sleepForTesting(100);

      // No expiration callback should have fired
      expect(results).toHaveLength(0);
    });

    it('allows re-enqueue after a task expires', async () => {
      const queue = new TaskQueue({ pendingTaskTimeToLive: 50 });

      queue.enqueue('default', makeTask({ operationId: 'ttl-reuse' }));

      // Wait for expiration
      await sleepForTesting(100);

      expect(queue.isTracked('ttl-reuse')).toBe(false);

      // Should be able to re-enqueue
      const result = queue.enqueue('default', makeTask({ operationId: 'ttl-reuse' }));
      expect(result).toBe(true);
    });

    it('does not expire tasks when TTL is Infinity', async () => {
      const queue = new TaskQueue({ pendingTaskTimeToLive: Infinity });

      queue.enqueue('default', makeTask({ operationId: 'ttl-inf', activityName: 'charge' }));

      await sleepForTesting(50);

      expect(queue.pendingCount('default')).toBe(1);
      expect(queue.isTracked('ttl-inf')).toBe(true);
    });

    it('does not expire tasks when TTL is 0', async () => {
      const queue = new TaskQueue({ pendingTaskTimeToLive: 0 });

      queue.enqueue('default', makeTask({ operationId: 'ttl-zero', activityName: 'charge' }));

      await sleepForTesting(50);

      expect(queue.pendingCount('default')).toBe(1);
      expect(queue.isTracked('ttl-zero')).toBe(true);
    });

    it('cleans up completion callback when task expires without one', async () => {
      const queue = new TaskQueue({ pendingTaskTimeToLive: 50 });

      // Enqueue without a callback
      queue.enqueue('default', makeTask({ operationId: 'ttl-no-cb' }));

      await sleepForTesting(100);

      // Task should be cleaned up without errors
      expect(queue.pendingCount('default')).toBe(0);
      expect(queue.isTracked('ttl-no-cb')).toBe(false);

      // Calling complete on an expired task should return false (no callback)
      const found = queue.complete({ operationId: 'ttl-no-cb', status: 'completed' });
      expect(found).toBe(false);
    });
  });

  describe('abort and dispose', () => {
    it('settles a poll promptly when its signal aborts, without dispatching to the gone client', async () => {
      const queue = new TaskQueue();
      const controller = new AbortController();

      // Park a long-lived poll; only the abort signal can settle it within the test.
      const pollPromise = queue.poll('q', ['charge'], 60_000, controller.signal);

      controller.abort();

      // Resolves to null immediately — the 60s timer is never advanced.
      await expect(pollPromise).resolves.toBeNull();
      expect(queue.hasWaiter('q', 'charge')).toBe(false);

      // A task enqueued afterwards is queued, not handed to the aborted waiter.
      const enqueued = queue.enqueue(
        'q',
        makeTask({ operationId: 'after-abort', activityName: 'charge' }),
      );
      expect(enqueued).toBe(true);
      expect(queue.pendingCount('q')).toBe(1);
      // It is tracked as pending — not dispatched-then-lost to the gone client.
      expect(queue.isTracked('after-abort')).toBe(true);
    });

    it('resolves every outstanding waiter with null on dispose', async () => {
      const queue = new TaskQueue();

      // Park waiters on two different queues so dispose exercises iteration
      // across the #waiters map keys, not just a single per-queue array.
      const first = queue.poll('q1', ['x'], 60_000);
      const second = queue.poll('q2', ['y'], 60_000);

      queue[Symbol.dispose]();

      await expect(Promise.all([first, second])).resolves.toEqual([null, null]);
      expect(queue.hasWaiter('q1', 'x')).toBe(false);
      expect(queue.hasWaiter('q2', 'y')).toBe(false);
    });

    it('is idempotent — a second dispose does not throw or re-settle waiters', async () => {
      const queue = new TaskQueue();
      const pollPromise = queue.poll('q', ['charge'], 60_000);

      queue[Symbol.dispose]();
      expect(() => queue[Symbol.dispose]()).not.toThrow();

      await expect(pollPromise).resolves.toBeNull();
    });

    describe('with fake timers', () => {
      beforeEach(() => {
        useFakeTimers();
      });

      afterEach(() => {
        restoreRealTimers();
      });

      it('clears pending-task expiration timers and drops tasks silently', async () => {
        // Spy on clearTimeout so we can assert the expiration timer is actually
        // cleared. Asserting only that the completion callback stays silent is
        // insufficient: dispose clears #completionCallbacks too, so a surviving
        // (uncleared) timer's #expireTask would find no callback and stay quiet
        // anyway. The spy is what falsifies a regression that drops the
        // clearTimeout loop from dispose.
        const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout');
        try {
          const queue = new TaskQueue({ pendingTaskTimeToLive: 1000 });
          const results: TaskResult[] = [];

          queue.enqueue('default', makeTask({ operationId: 'disposed-ttl' }), (result) =>
            results.push(result),
          );
          expect(queue.totalPendingCount()).toBe(1);

          clearTimeoutSpy.mockClear();
          queue[Symbol.dispose]();
          // The pending task's expiration timer was cleared by dispose.
          expect(clearTimeoutSpy).toHaveBeenCalled();

          // Advance well past the TTL: no expiration callback fires.
          await sleepForTesting(5000);

          expect(results).toHaveLength(0);
          expect(queue.totalPendingCount()).toBe(0);
          expect(queue.isTracked('disposed-ttl')).toBe(false);
        } finally {
          clearTimeoutSpy.mockRestore();
        }
      });
    });
  });

  describe('priority queuing', () => {
    it('dequeues high-priority tasks before low-priority tasks', async () => {
      const queue = new TaskQueue();

      const low = makeTask({ operationId: 'low', activityName: 'charge', priority: 0 });
      const high = makeTask({ operationId: 'high', activityName: 'charge', priority: 10 });

      queue.enqueue('default', low);
      queue.enqueue('default', high);

      const result1 = await queue.poll('default', ['charge'], 100);
      const result2 = await queue.poll('default', ['charge'], 100);

      expect(result1?.operationId).toBe('high');
      expect(result2?.operationId).toBe('low');
    });

    it('maintains FIFO order for same-priority tasks', async () => {
      const queue = new TaskQueue();

      const first = makeTask({ operationId: 'first', activityName: 'charge', priority: 10 });
      const second = makeTask({ operationId: 'second', activityName: 'charge', priority: 10 });
      const third = makeTask({ operationId: 'third', activityName: 'charge', priority: 10 });

      queue.enqueue('default', first);
      queue.enqueue('default', second);
      queue.enqueue('default', third);

      const r1 = await queue.poll('default', ['charge'], 100);
      const r2 = await queue.poll('default', ['charge'], 100);
      const r3 = await queue.poll('default', ['charge'], 100);

      expect(r1?.operationId).toBe('first');
      expect(r2?.operationId).toBe('second');
      expect(r3?.operationId).toBe('third');
    });

    it('handles mixed priorities correctly', async () => {
      const queue = new TaskQueue();

      const p0a = makeTask({ operationId: 'p0a', activityName: 'charge', priority: 0 });
      const p10a = makeTask({ operationId: 'p10a', activityName: 'charge', priority: 10 });
      const p0b = makeTask({ operationId: 'p0b', activityName: 'charge', priority: 0 });
      const p5 = makeTask({ operationId: 'p5', activityName: 'charge', priority: 5 });
      const p10b = makeTask({ operationId: 'p10b', activityName: 'charge', priority: 10 });

      queue.enqueue('default', p0a);
      queue.enqueue('default', p10a);
      queue.enqueue('default', p0b);
      queue.enqueue('default', p5);
      queue.enqueue('default', p10b);

      const results: string[] = [];
      for (let i = 0; i < 5; i++) {
        const task = await queue.poll('default', ['charge'], 100);
        results.push(task!.operationId);
      }

      expect(results).toEqual(['p10a', 'p10b', 'p5', 'p0a', 'p0b']);
    });

    it('defaults to priority 0 when not specified', async () => {
      const queue = new TaskQueue();

      const noPriority = makeTask({ operationId: 'no-prio', activityName: 'charge' });
      const highPriority = makeTask({
        operationId: 'high-prio',
        activityName: 'charge',
        priority: 10,
      });

      queue.enqueue('default', noPriority);
      queue.enqueue('default', highPriority);

      const result1 = await queue.poll('default', ['charge'], 100);
      expect(result1?.operationId).toBe('high-prio');
    });
  });

  describe('enqueue timestamp default', () => {
    it('defaults enqueuedAt to the current wall clock when the caller omits it', () => {
      const queue = new TaskQueue();
      const task = makeTask({ operationId: 'op-no-ts' });
      expect(task.enqueuedAt).toBeUndefined();

      const before = Date.now();
      queue.enqueue('default', task);
      const after = Date.now();

      expect(task.enqueuedAt).toBeGreaterThanOrEqual(before);
      expect(task.enqueuedAt).toBeLessThanOrEqual(after);
    });

    it('preserves a caller-supplied enqueuedAt instead of overwriting it', () => {
      const queue = new TaskQueue();
      const task: PendingTask = {
        ...makeTask({ operationId: 'op-pinned' }),
        enqueuedAt: 12345,
      };

      queue.enqueue('default', task);

      expect(task.enqueuedAt).toBe(12345);
    });
  });

  describe('getQueueSummaries', () => {
    function pinnedTask(operationId: string, enqueuedAt: number): PendingTask {
      return { ...makeTask({ operationId }), enqueuedAt };
    }

    it('reports backlog and oldest enqueue time per pending queue, sorted by name', () => {
      const queue = new TaskQueue();
      queue.enqueue('alpha', pinnedTask('a1', 1000));
      queue.enqueue('alpha', pinnedTask('a2', 500));
      queue.enqueue('zebra', pinnedTask('z1', 2000));

      const summaries = queue.getQueueSummaries();

      expect(summaries.map((s) => s.queue)).toEqual(['alpha', 'zebra']);
      expect(summaries[0]).toEqual({
        queue: 'alpha',
        backlog: 2,
        oldestEnqueuedAt: 500,
        waitingPollers: 0,
        schedulingPolicy: 'priority',
      });
      expect(summaries[1]).toEqual({
        queue: 'zebra',
        backlog: 1,
        oldestEnqueuedAt: 2000,
        waitingPollers: 0,
        schedulingPolicy: 'priority',
      });
    });

    it('includes queues with only waiting pollers, with backlog 0 and null oldestEnqueuedAt', async () => {
      const queue = new TaskQueue();
      const controller = new AbortController();
      const pollPromise = queue.poll('idle-queue', ['never-matches'], 30_000, controller.signal);

      // Yield once so the poll registers as a waiter.
      await Promise.resolve();

      const summaries = queue.getQueueSummaries();
      const entry = summaries.find((s) => s.queue === 'idle-queue');
      expect(entry).toEqual({
        queue: 'idle-queue',
        backlog: 0,
        oldestEnqueuedAt: null,
        waitingPollers: 1,
        schedulingPolicy: 'priority',
      });

      controller.abort();
      await pollPromise;
    });

    it('returns an empty array when neither pending tasks nor waiters exist', () => {
      const queue = new TaskQueue();
      expect(queue.getQueueSummaries()).toEqual([]);
    });

    it('carries the configured schedulingPolicy through each summary', () => {
      const queue = new TaskQueue({ schedulingPolicy: 'fifo' });
      queue.enqueue('alpha', makeTask({ operationId: 'a1' }));
      const summaries = queue.getQueueSummaries();
      expect(summaries[0]?.schedulingPolicy).toBe('fifo');
    });
  });
});
