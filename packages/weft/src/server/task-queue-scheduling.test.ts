import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import type { PendingTask } from './task-queue-types.ts';
import { resetLifoStarvationWarningForTesting, TaskQueue } from './task-queue.ts';

function makeTask(id: string, priority?: number): PendingTask {
  const task: PendingTask = {
    operationId: id,
    activityName: 'sendEmail',
    input: {},
  };
  if (priority !== undefined) task.priority = priority;
  return task;
}

describe('TaskQueue scheduling policies', () => {
  describe("'priority' (default)", () => {
    it('dequeues higher priority first even if queued later', async () => {
      const queue = new TaskQueue();
      queue.enqueue('default', makeTask('low', 0));
      queue.enqueue('default', makeTask('high', 10));

      const first = await queue.poll('default', ['sendEmail'], 10);
      expect(first?.operationId).toBe('high');
      const second = await queue.poll('default', ['sendEmail'], 10);
      expect(second?.operationId).toBe('low');
    });

    it('keeps FIFO order within a single priority band', async () => {
      const queue = new TaskQueue();
      queue.enqueue('default', makeTask('first', 5));
      queue.enqueue('default', makeTask('second', 5));
      queue.enqueue('default', makeTask('third', 5));

      const a = await queue.poll('default', ['sendEmail'], 10);
      const b = await queue.poll('default', ['sendEmail'], 10);
      const c = await queue.poll('default', ['sendEmail'], 10);
      expect([a?.operationId, b?.operationId, c?.operationId]).toEqual([
        'first',
        'second',
        'third',
      ]);
    });
  });

  describe("'fifo'", () => {
    it('dequeues oldest-first, ignoring priority', async () => {
      const queue = new TaskQueue({ schedulingPolicy: 'fifo' });
      queue.enqueue('default', makeTask('low-early', 0));
      queue.enqueue('default', makeTask('high-later', 10));
      queue.enqueue('default', makeTask('mid-latest', 5));

      const a = await queue.poll('default', ['sendEmail'], 10);
      const b = await queue.poll('default', ['sendEmail'], 10);
      const c = await queue.poll('default', ['sendEmail'], 10);
      expect([a?.operationId, b?.operationId, c?.operationId]).toEqual([
        'low-early',
        'high-later',
        'mid-latest',
      ]);
    });
  });

  describe("'lifo'", () => {
    it('dequeues newest-first, ignoring priority', async () => {
      const queue = new TaskQueue({ schedulingPolicy: 'lifo' });
      queue.enqueue('default', makeTask('a'));
      queue.enqueue('default', makeTask('b'));
      queue.enqueue('default', makeTask('c'));

      const first = await queue.poll('default', ['sendEmail'], 10);
      const second = await queue.poll('default', ['sendEmail'], 10);
      const third = await queue.poll('default', ['sendEmail'], 10);
      expect([first?.operationId, second?.operationId, third?.operationId]).toEqual([
        'c',
        'b',
        'a',
      ]);
    });

    it('peekPending reflects the LIFO ordering', () => {
      const queue = new TaskQueue({ schedulingPolicy: 'lifo' });
      queue.enqueue('default', makeTask('a'));
      queue.enqueue('default', makeTask('b'));
      queue.enqueue('default', makeTask('c'));

      expect(queue.peekPending('default').map((t) => t.operationId)).toEqual(['c', 'b', 'a']);
    });
  });

  it('exposes the configured scheduling policy', () => {
    expect(new TaskQueue().schedulingPolicy).toBe('priority');
    expect(new TaskQueue({ schedulingPolicy: 'fifo' }).schedulingPolicy).toBe('fifo');
    expect(new TaskQueue({ schedulingPolicy: 'lifo' }).schedulingPolicy).toBe('lifo');
  });

  describe('LIFO + finite TTL starvation warning', () => {
    let warnSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      resetLifoStarvationWarningForTesting();
      warnSpy = spyOn(console, 'warn').mockImplementation(mock(() => {}));
    });

    afterEach(() => {
      warnSpy.mockRestore();
      resetLifoStarvationWarningForTesting();
    });

    it('warns once when LIFO is paired with the default finite TTL', () => {
      const lifoQueue = new TaskQueue({ schedulingPolicy: 'lifo' });
      expect(lifoQueue.schedulingPolicy).toBe('lifo');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0]?.[0] ?? '');
      expect(message).toContain("schedulingPolicy='lifo'");
      expect(message).toContain('pendingTaskTimeToLive');
    });

    it('warns at most once even when many LIFO queues are constructed', () => {
      const queues = [
        new TaskQueue({ schedulingPolicy: 'lifo' }),
        new TaskQueue({ schedulingPolicy: 'lifo', pendingTaskTimeToLive: 1000 }),
        new TaskQueue({ schedulingPolicy: 'lifo' }),
      ];
      expect(queues).toHaveLength(3);

      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('does not warn when LIFO is paired with Infinity TTL', () => {
      const queue = new TaskQueue({ schedulingPolicy: 'lifo', pendingTaskTimeToLive: Infinity });
      expect(queue.schedulingPolicy).toBe('lifo');

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not warn when LIFO expiration is disabled with 0', () => {
      const queue = new TaskQueue({ schedulingPolicy: 'lifo', pendingTaskTimeToLive: 0 });
      expect(queue.schedulingPolicy).toBe('lifo');

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not warn for FIFO or priority policies with finite TTL', () => {
      const queues = [
        new TaskQueue({ schedulingPolicy: 'fifo' }),
        new TaskQueue({ schedulingPolicy: 'priority' }),
        new TaskQueue(),
      ];
      expect(queues).toHaveLength(3);

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
