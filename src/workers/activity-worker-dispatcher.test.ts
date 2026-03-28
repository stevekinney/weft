import { afterEach, describe, expect, it } from 'bun:test';

import type { ActivityExecutionRequest } from './activity-runner.ts';
import { ActivityWorkerDispatcher } from './activity-worker-dispatcher.ts';
import { WorkerPool } from './pool.ts';

const workerUrl = new URL('./test-activity-worker.ts', import.meta.url);

describe('ActivityWorkerDispatcher', () => {
  let pool: WorkerPool;
  let dispatcher: ActivityWorkerDispatcher;

  afterEach(() => {
    dispatcher?.[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // Successful execution
  // ---------------------------------------------------------------------------

  describe('successful execution', () => {
    it('executes a synchronous activity and returns the result', async () => {
      pool = new WorkerPool({ concurrency: 2, workerUrl });
      dispatcher = new ActivityWorkerDispatcher(pool);

      const request: ActivityExecutionRequest = {
        operationId: 'op-1',
        activityName: 'greet',
        input: 'world',
        attempt: 1,
      };

      const result = await dispatcher.execute(request);

      expect(result.operationId).toBe('op-1');
      expect(result.status).toBe('completed');
      expect(result.value).toBe('hello world');
    });

    it('executes an async activity and returns the result', async () => {
      pool = new WorkerPool({ concurrency: 2, workerUrl });
      dispatcher = new ActivityWorkerDispatcher(pool);

      const request: ActivityExecutionRequest = {
        operationId: 'op-2',
        activityName: 'asyncDouble',
        input: 21,
        attempt: 1,
      };

      const result = await dispatcher.execute(request);

      expect(result.operationId).toBe('op-2');
      expect(result.status).toBe('completed');
      expect(result.value).toBe(42);
    });

    it('handles numeric results correctly', async () => {
      pool = new WorkerPool({ concurrency: 2, workerUrl });
      dispatcher = new ActivityWorkerDispatcher(pool);

      const request: ActivityExecutionRequest = {
        operationId: 'op-3',
        activityName: 'double',
        input: 5,
        attempt: 1,
      };

      const result = await dispatcher.execute(request);

      expect(result.operationId).toBe('op-3');
      expect(result.status).toBe('completed');
      expect(result.value).toBe(10);
    });
  });

  // ---------------------------------------------------------------------------
  // Failed execution
  // ---------------------------------------------------------------------------

  describe('failed execution', () => {
    it('returns failed for an unknown activity', async () => {
      pool = new WorkerPool({ concurrency: 2, workerUrl });
      dispatcher = new ActivityWorkerDispatcher(pool);

      const request: ActivityExecutionRequest = {
        operationId: 'op-4',
        activityName: 'nonexistent',
        input: null,
        attempt: 1,
      };

      const result = await dispatcher.execute(request);

      expect(result.operationId).toBe('op-4');
      expect(result.status).toBe('failed');
      expect(result.error).toContain('nonexistent');
    });

    it('returns failed when the activity throws', async () => {
      pool = new WorkerPool({ concurrency: 2, workerUrl });
      dispatcher = new ActivityWorkerDispatcher(pool);

      const request: ActivityExecutionRequest = {
        operationId: 'op-5',
        activityName: 'failingActivity',
        input: null,
        attempt: 1,
      };

      const result = await dispatcher.execute(request);

      expect(result.operationId).toBe('op-5');
      expect(result.status).toBe('failed');
      expect(result.error).toContain('activity-failure');
    });
  });

  // ---------------------------------------------------------------------------
  // Pool size / concurrency
  // ---------------------------------------------------------------------------

  describe('configurable pool size', () => {
    it('respects pool concurrency of 1', async () => {
      pool = new WorkerPool({ concurrency: 1, workerUrl });
      dispatcher = new ActivityWorkerDispatcher(pool);

      // Run two activities concurrently with pool size 1
      const request1: ActivityExecutionRequest = {
        operationId: 'op-6a',
        activityName: 'slowActivity',
        input: 'first',
        attempt: 1,
      };

      const request2: ActivityExecutionRequest = {
        operationId: 'op-6b',
        activityName: 'greet',
        input: 'second',
        attempt: 1,
      };

      // Both should complete, but one must wait for the other
      const [result1, result2] = await Promise.all([
        dispatcher.execute(request1),
        dispatcher.execute(request2),
      ]);

      expect(result1.status).toBe('completed');
      expect(result1.value).toBe('slow:first');
      expect(result2.status).toBe('completed');
      expect(result2.value).toBe('hello second');
    });

    it('executes activities concurrently up to pool size', async () => {
      pool = new WorkerPool({ concurrency: 4, workerUrl });
      dispatcher = new ActivityWorkerDispatcher(pool);

      // Run 4 activities concurrently
      const requests = Array.from({ length: 4 }, (_, index) => ({
        operationId: `op-concurrent-${index}`,
        activityName: 'double',
        input: index + 1,
        attempt: 1,
      }));

      const results = await Promise.all(requests.map((request) => dispatcher.execute(request)));

      for (let index = 0; index < 4; index++) {
        const result = results[index]!;
        expect(result.status).toBe('completed');
        expect(result.value).toBe((index + 1) * 2);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Pool metrics pass-through
  // ---------------------------------------------------------------------------

  describe('pool metrics', () => {
    it('exposes availableCount, totalCount, and pendingCount', () => {
      pool = new WorkerPool({ concurrency: 3, workerUrl });
      dispatcher = new ActivityWorkerDispatcher(pool);

      expect(dispatcher.availableCount).toBe(0);
      expect(dispatcher.totalCount).toBe(0);
      expect(dispatcher.pendingCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Worker reuse
  // ---------------------------------------------------------------------------

  describe('worker reuse', () => {
    it('releases workers back to the pool after execution', async () => {
      pool = new WorkerPool({ concurrency: 1, workerUrl });
      dispatcher = new ActivityWorkerDispatcher(pool);

      // Execute first activity
      await dispatcher.execute({
        operationId: 'op-reuse-1',
        activityName: 'double',
        input: 1,
        attempt: 1,
      });

      // Worker should be back in the pool
      expect(pool.availableCount).toBe(1);
      expect(pool.totalCount).toBe(1);

      // Execute second activity — should reuse the same worker
      await dispatcher.execute({
        operationId: 'op-reuse-2',
        activityName: 'double',
        input: 2,
        attempt: 1,
      });

      expect(pool.totalCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Disposal
  // ---------------------------------------------------------------------------

  describe('disposal', () => {
    it('disposes the underlying pool on sync dispose', () => {
      pool = new WorkerPool({ concurrency: 2, workerUrl });
      dispatcher = new ActivityWorkerDispatcher(pool);

      dispatcher[Symbol.dispose]();

      expect(pool.totalCount).toBe(0);
    });

    it('disposes the underlying pool on async dispose', async () => {
      pool = new WorkerPool({ concurrency: 2, workerUrl });
      dispatcher = new ActivityWorkerDispatcher(pool);

      const worker = await pool.acquire();
      pool.release(worker);

      await dispatcher[Symbol.asyncDispose]();

      expect(pool.totalCount).toBe(0);
    });
  });
});
