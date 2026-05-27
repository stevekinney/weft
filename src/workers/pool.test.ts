import { afterEach, describe, expect, it } from 'bun:test';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';

import { WorkerPool } from './pool';

const workerUrl = new URL('./test-worker.ts', import.meta.url);

describe('WorkerPool', () => {
  let pool: WorkerPool;

  afterEach(() => {
    pool?.[Symbol.dispose]();
  });

  // ---------------------------------------------------------------------------
  // Lazy creation up to concurrency limit
  // ---------------------------------------------------------------------------

  describe('lazy worker creation', () => {
    it('creates workers on acquire up to the concurrency limit', async () => {
      pool = new WorkerPool({ concurrency: 2, workerUrl });

      expect(pool.totalCount).toBe(0);

      const worker1 = await pool.acquire();
      expect(pool.totalCount).toBe(1);

      const worker2 = await pool.acquire();
      expect(pool.totalCount).toBe(2);

      pool.release(worker1);
      pool.release(worker2);
    });

    it('reuses released workers instead of creating new ones', async () => {
      pool = new WorkerPool({ concurrency: 2, workerUrl });

      const worker1 = await pool.acquire();
      pool.release(worker1);

      const worker2 = await pool.acquire();
      expect(worker2).toBe(worker1);
      expect(pool.totalCount).toBe(1);

      pool.release(worker2);
    });
  });

  // ---------------------------------------------------------------------------
  // Acquire beyond concurrency queues the request
  // ---------------------------------------------------------------------------

  describe('queuing beyond concurrency', () => {
    it('queues acquire requests when at capacity', async () => {
      pool = new WorkerPool({ concurrency: 1, workerUrl });

      const worker1 = await pool.acquire();
      expect(pool.totalCount).toBe(1);

      // This should queue since we're at capacity
      const pendingAcquire = pool.acquire();
      expect(pool.pendingCount).toBe(1);

      // Release the first worker, which should hand it to the queued request
      pool.release(worker1);
      const worker2 = await pendingAcquire;

      expect(worker2).toBe(worker1);
      expect(pool.pendingCount).toBe(0);

      pool.release(worker2);
    });

    it('queues multiple requests and resolves them in order', async () => {
      pool = new WorkerPool({ concurrency: 1, workerUrl });

      const worker = await pool.acquire();
      const results: number[] = [];

      const pending1 = pool.acquire().then((w) => {
        results.push(1);
        return w;
      });
      const pending2 = pool.acquire().then((w) => {
        results.push(2);
        return w;
      });

      expect(pool.pendingCount).toBe(2);

      pool.release(worker);
      const w1 = await pending1;

      pool.release(w1);
      const w2 = await pending2;

      expect(results).toEqual([1, 2]);

      pool.release(w2);
    });
  });

  // ---------------------------------------------------------------------------
  // Release hands worker to queued request
  // ---------------------------------------------------------------------------

  describe('release', () => {
    it('hands worker directly to the next queued request', async () => {
      pool = new WorkerPool({ concurrency: 1, workerUrl });

      const worker = await pool.acquire();

      const pendingAcquire = pool.acquire();
      expect(pool.pendingCount).toBe(1);
      expect(pool.availableCount).toBe(0);

      pool.release(worker);

      // The worker should have gone directly to the pending request, not back to the available pool
      expect(pool.pendingCount).toBe(0);
      expect(pool.availableCount).toBe(0);

      const acquired = await pendingAcquire;
      expect(acquired).toBe(worker);

      pool.release(acquired);
    });

    it('returns worker to available pool when no requests are queued', async () => {
      pool = new WorkerPool({ concurrency: 2, workerUrl });

      const worker = await pool.acquire();
      expect(pool.availableCount).toBe(0);

      pool.release(worker);
      expect(pool.availableCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // availableCount reflects state
  // ---------------------------------------------------------------------------

  describe('availableCount', () => {
    it('starts at zero', () => {
      pool = new WorkerPool({ concurrency: 3, workerUrl });
      expect(pool.availableCount).toBe(0);
    });

    it('increases when workers are released', async () => {
      pool = new WorkerPool({ concurrency: 3, workerUrl });

      const w1 = await pool.acquire();
      const w2 = await pool.acquire();

      expect(pool.availableCount).toBe(0);

      pool.release(w1);
      expect(pool.availableCount).toBe(1);

      pool.release(w2);
      expect(pool.availableCount).toBe(2);
    });

    it('decreases when available workers are acquired', async () => {
      pool = new WorkerPool({ concurrency: 2, workerUrl });

      const worker = await pool.acquire();
      pool.release(worker);
      expect(pool.availableCount).toBe(1);

      await pool.acquire();
      expect(pool.availableCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // totalCount reflects state
  // ---------------------------------------------------------------------------

  describe('totalCount', () => {
    it('starts at zero', () => {
      pool = new WorkerPool({ concurrency: 3, workerUrl });
      expect(pool.totalCount).toBe(0);
    });

    it('tracks the total number of created workers', async () => {
      pool = new WorkerPool({ concurrency: 3, workerUrl });

      const w1 = await pool.acquire();
      expect(pool.totalCount).toBe(1);

      const w2 = await pool.acquire();
      expect(pool.totalCount).toBe(2);

      const w3 = await pool.acquire();
      expect(pool.totalCount).toBe(3);

      pool.release(w1);
      pool.release(w2);
      pool.release(w3);

      // Total does not decrease on release
      expect(pool.totalCount).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // pendingCount reflects state
  // ---------------------------------------------------------------------------

  describe('pendingCount', () => {
    it('starts at zero', () => {
      pool = new WorkerPool({ concurrency: 2, workerUrl });
      expect(pool.pendingCount).toBe(0);
    });

    it('increases when acquire is called at capacity', async () => {
      pool = new WorkerPool({ concurrency: 1, workerUrl });

      const worker = await pool.acquire();
      const firstQueuedAcquire = pool.acquire();
      const secondQueuedAcquire = pool.acquire();

      expect(pool.pendingCount).toBe(2);

      pool.release(worker);
      const firstQueuedWorker = await firstQueuedAcquire;
      pool.release(firstQueuedWorker);
      const secondQueuedWorker = await secondQueuedAcquire;
      pool.release(secondQueuedWorker);
    });
  });

  // ---------------------------------------------------------------------------
  // Symbol.dispose terminates all workers
  // ---------------------------------------------------------------------------

  describe('[Symbol.dispose]()', () => {
    it('terminates all workers immediately', async () => {
      pool = new WorkerPool({ concurrency: 2, workerUrl });

      const w1 = await pool.acquire();
      const w2 = await pool.acquire();

      pool.release(w1);
      pool.release(w2);

      pool[Symbol.dispose]();

      expect(pool.totalCount).toBe(0);
      expect(pool.availableCount).toBe(0);
    });

    it('terminates in-use workers as well', async () => {
      pool = new WorkerPool({ concurrency: 2, workerUrl });

      await pool.acquire();
      await pool.acquire();

      pool[Symbol.dispose]();

      expect(pool.totalCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // After dispose, acquire throws
  // ---------------------------------------------------------------------------

  describe('acquire after dispose', () => {
    it('throws an error after synchronous dispose', () => {
      pool = new WorkerPool({ concurrency: 2, workerUrl });
      pool[Symbol.dispose]();

      expect(() => pool.acquire()).toThrow('WorkerPool has been disposed');
    });

    it('throws an error after async dispose', async () => {
      pool = new WorkerPool({ concurrency: 2, workerUrl });
      await pool[Symbol.asyncDispose]();

      expect(() => pool.acquire()).toThrow('WorkerPool has been disposed');
    });
  });

  // ---------------------------------------------------------------------------
  // acquireSpecificWorker
  // ---------------------------------------------------------------------------

  describe('acquireSpecificWorker', () => {
    it('returns an available requested worker without disturbing other idle workers', async () => {
      pool = new WorkerPool({ concurrency: 2, workerUrl });

      const targetWorker = await pool.acquire();
      const otherWorker = await pool.acquire();
      pool.release(targetWorker);
      pool.release(otherWorker);

      const reacquiredTargetWorker = await pool.acquireSpecificWorker(targetWorker);
      expect(reacquiredTargetWorker).toBe(targetWorker);
      expect(pool.availableCount).toBe(1);

      const remainingWorker = await pool.acquire();
      expect(remainingWorker).toBe(otherWorker);

      pool.release(reacquiredTargetWorker);
      pool.release(remainingWorker);
    });

    it('waits for the exact in-use worker while unrelated workers serve generic acquires', async () => {
      pool = new WorkerPool({ concurrency: 2, workerUrl });

      const targetWorker = await pool.acquire();
      const otherWorker = await pool.acquire();

      let specificAcquireResolved = false;
      const specificAcquire = pool.acquireSpecificWorker(targetWorker).then((worker) => {
        specificAcquireResolved = true;
        return worker;
      });
      const genericAcquire = pool.acquire();
      expect(pool.pendingCount).toBe(2);

      pool.release(otherWorker);
      const genericWorker = await genericAcquire;
      expect(genericWorker).toBe(otherWorker);
      expect(pool.pendingCount).toBe(1);

      await sleepForTesting(0);
      expect(specificAcquireResolved).toBe(false);

      pool.release(genericWorker);
      await sleepForTesting(0);
      expect(specificAcquireResolved).toBe(false);
      expect(pool.availableCount).toBe(1);

      pool.release(targetWorker);
      const specificWorker = await specificAcquire;
      expect(specificWorker).toBe(targetWorker);
      expect(specificAcquireResolved).toBe(true);

      pool.release(specificWorker);
    });

    it('throws when the requested worker belongs to a different pool', async () => {
      pool = new WorkerPool({ concurrency: 1, workerUrl });
      const otherPool = new WorkerPool({ concurrency: 1, workerUrl });

      try {
        const foreignWorker = await otherPool.acquire();
        await expect(pool.acquireSpecificWorker(foreignWorker)).rejects.toThrow(
          'Worker does not belong to this WorkerPool',
        );
        otherPool.release(foreignWorker);
      } finally {
        otherPool[Symbol.dispose]();
      }
    });

    it('rejects pending specific requests when the pool is disposed', async () => {
      pool = new WorkerPool({ concurrency: 1, workerUrl });

      const worker = await pool.acquire();
      const specificAcquire = pool.acquireSpecificWorker(worker);
      expect(pool.pendingCount).toBe(1);

      pool[Symbol.dispose]();

      await expect(specificAcquire).rejects.toThrow('WorkerPool has been disposed');
      expect(pool.pendingCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // discard
  // ---------------------------------------------------------------------------

  describe('discard', () => {
    it('removes an available worker so acquire creates a replacement', async () => {
      pool = new WorkerPool({ concurrency: 1, workerUrl });

      const worker = await pool.acquire();
      pool.release(worker);
      expect(pool.availableCount).toBe(1);
      expect(pool.totalCount).toBe(1);

      pool.discard(worker);
      expect(pool.availableCount).toBe(0);
      expect(pool.totalCount).toBe(0);

      const replacementWorker = await pool.acquire();
      expect(replacementWorker).not.toBe(worker);
      expect(pool.totalCount).toBe(1);

      pool.release(replacementWorker);
    });

    it('rejects pending requests for the discarded worker', async () => {
      pool = new WorkerPool({ concurrency: 1, workerUrl });

      const worker = await pool.acquire();
      const specificAcquire = pool.acquireSpecificWorker(worker);
      expect(pool.pendingCount).toBe(1);

      pool.discard(worker);

      await expect(specificAcquire).rejects.toThrow('Worker was discarded from this WorkerPool');
      expect(pool.pendingCount).toBe(0);
    });

    it('creates a replacement for generic waiters after discarding an in-use worker', async () => {
      pool = new WorkerPool({ concurrency: 1, workerUrl });

      const worker = await pool.acquire();
      const genericAcquire = pool.acquire();
      expect(pool.pendingCount).toBe(1);

      pool.discard(worker);

      const replacementWorker = await genericAcquire;
      expect(replacementWorker).not.toBe(worker);
      expect(pool.totalCount).toBe(1);
      expect(pool.pendingCount).toBe(0);

      pool.release(replacementWorker);
    });
  });

  // ---------------------------------------------------------------------------
  // Pool respects concurrency limit
  // ---------------------------------------------------------------------------

  describe('concurrency limit', () => {
    it('never creates more workers than the concurrency limit', async () => {
      pool = new WorkerPool({ concurrency: 2, workerUrl });

      const w1 = await pool.acquire();
      const w2 = await pool.acquire();

      expect(pool.totalCount).toBe(2);

      // Third acquire should queue, not create a new worker
      const pendingAcquire = pool.acquire();
      expect(pool.totalCount).toBe(2);
      expect(pool.pendingCount).toBe(1);

      pool.release(w1);
      await pendingAcquire;

      // Still only 2 workers total
      expect(pool.totalCount).toBe(2);

      pool.release(w2);
    });
  });

  // ---------------------------------------------------------------------------
  // Async dispose waits for in-flight workers
  // ---------------------------------------------------------------------------

  describe('[Symbol.asyncDispose]()', () => {
    it('waits for in-flight workers before terminating', async () => {
      pool = new WorkerPool({ concurrency: 2, workerUrl });

      const w1 = await pool.acquire();
      const w2 = await pool.acquire();

      let disposed = false;
      const disposePromise = pool[Symbol.asyncDispose]().then(() => {
        disposed = true;
      });

      // Not yet disposed because workers are in use
      await sleepForTesting(10);
      expect(disposed).toBe(false);

      pool.release(w1);
      await sleepForTesting(10);
      expect(disposed).toBe(false);

      pool.release(w2);
      await disposePromise;
      expect(disposed).toBe(true);

      expect(pool.totalCount).toBe(0);
    });

    it('resolves immediately when no workers are in use', async () => {
      pool = new WorkerPool({ concurrency: 2, workerUrl });

      const worker = await pool.acquire();
      pool.release(worker);

      await pool[Symbol.asyncDispose]();
      expect(pool.totalCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // smol option
  // ---------------------------------------------------------------------------

  describe('smol option', () => {
    it('defaults smol to false', () => {
      pool = new WorkerPool({ concurrency: 1, workerUrl });
      // Pool constructs without error, verifying default behavior
      expect(pool.totalCount).toBe(0);
    });

    it('accepts smol: true without error', async () => {
      pool = new WorkerPool({ concurrency: 1, workerUrl, smol: true });
      const worker = await pool.acquire();
      expect(worker).toBeDefined();
      pool.release(worker);
    });

    it('creates functional workers with smol: true that can process messages', async () => {
      pool = new WorkerPool({ concurrency: 1, workerUrl, smol: true });

      const worker = await pool.acquire();

      const response = await new Promise<{ echo: string }>((resolve) => {
        worker.addEventListener('message', (event: MessageEvent) => {
          resolve(event.data);
        });
        worker.postMessage('smol-test');
      });

      expect(response).toEqual({ echo: 'smol-test' });

      pool.release(worker);
    });

    it('manages multiple smol workers at concurrency limits', async () => {
      pool = new WorkerPool({ concurrency: 2, workerUrl, smol: true });

      const worker1 = await pool.acquire();
      const worker2 = await pool.acquire();

      expect(pool.totalCount).toBe(2);

      // Both workers should process messages independently
      const [response1, response2] = await Promise.all([
        new Promise<{ echo: string }>((resolve) => {
          worker1.addEventListener('message', (event: MessageEvent) => {
            resolve(event.data);
          });
          worker1.postMessage('first');
        }),
        new Promise<{ echo: string }>((resolve) => {
          worker2.addEventListener('message', (event: MessageEvent) => {
            resolve(event.data);
          });
          worker2.postMessage('second');
        }),
      ]);

      expect(response1).toEqual({ echo: 'first' });
      expect(response2).toEqual({ echo: 'second' });

      pool.release(worker1);
      pool.release(worker2);
    });

    it('reuses smol workers after release', async () => {
      pool = new WorkerPool({ concurrency: 1, workerUrl, smol: true });

      const worker1 = await pool.acquire();
      pool.release(worker1);

      const worker2 = await pool.acquire();
      expect(worker2).toBe(worker1);
      expect(pool.totalCount).toBe(1);

      pool.release(worker2);
    });
  });

  // ---------------------------------------------------------------------------
  // Workers are functional
  // ---------------------------------------------------------------------------

  describe('worker functionality', () => {
    it('creates workers that can process messages', async () => {
      pool = new WorkerPool({ concurrency: 1, workerUrl });

      const worker = await pool.acquire();

      const response = await new Promise<{ echo: string }>((resolve) => {
        worker.addEventListener('message', (event: MessageEvent) => {
          resolve(event.data);
        });
        worker.postMessage('hello');
      });

      expect(response).toEqual({ echo: 'hello' });

      pool.release(worker);
    });
  });
});
