import { describe, expect, it } from 'bun:test';
import { WorkerRegistry } from './registry.ts';

describe('WorkerRegistry', () => {
  it('register adds a worker', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      queue: 'default',
      activities: ['processOrder', 'sendEmail'],
      concurrency: 5,
    });

    expect(registry.size).toBe(1);
  });

  it('unregister removes a worker and returns its info', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      queue: 'default',
      activities: ['processOrder'],
      concurrency: 5,
    });

    const info = registry.unregister('worker-1');

    expect(info).toBeDefined();
    expect(info!.id).toBe('worker-1');
    expect(registry.size).toBe(0);
  });

  it('unregister returns undefined for unknown worker', () => {
    const registry = new WorkerRegistry();
    const info = registry.unregister('nonexistent');
    expect(info).toBeUndefined();
  });

  it('heartbeat updates lastHeartbeat', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      queue: 'default',
      activities: ['processOrder'],
      concurrency: 5,
    });

    const before = registry.getAll()[0]!.lastHeartbeat;

    // Record a heartbeat to update the timestamp
    registry.heartbeat('worker-1');

    const after = registry.getAll()[0]!.lastHeartbeat;

    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('heartbeat is a no-op for unknown worker', () => {
    const registry = new WorkerRegistry();
    expect(() => registry.heartbeat('nonexistent')).not.toThrow();
  });

  it('taskAssigned increments inFlight', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      queue: 'default',
      activities: ['processOrder'],
      concurrency: 5,
    });

    registry.taskAssigned('worker-1');
    registry.taskAssigned('worker-1');

    const worker = registry.getAll()[0]!;
    expect(worker.inFlight).toBe(2);
  });

  it('taskCompleted decrements inFlight', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      queue: 'default',
      activities: ['processOrder'],
      concurrency: 5,
    });

    registry.taskAssigned('worker-1');
    registry.taskAssigned('worker-1');
    registry.taskCompleted('worker-1');

    const worker = registry.getAll()[0]!;
    expect(worker.inFlight).toBe(1);
  });

  it('taskCompleted does not go below zero', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      queue: 'default',
      activities: ['processOrder'],
      concurrency: 5,
    });

    registry.taskCompleted('worker-1');

    const worker = registry.getAll()[0]!;
    expect(worker.inFlight).toBe(0);
  });

  it('findWorker returns least-loaded worker for activity', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      queue: 'default',
      activities: ['processOrder'],
      concurrency: 5,
    });

    registry.register({
      id: 'worker-2',
      queue: 'default',
      activities: ['processOrder'],
      concurrency: 5,
    });

    // Load up worker-1
    registry.taskAssigned('worker-1');
    registry.taskAssigned('worker-1');
    registry.taskAssigned('worker-1');

    // worker-2 has 0 in-flight, so it should be chosen
    const best = registry.findWorker('processOrder');
    expect(best).toBeDefined();
    expect(best!.id).toBe('worker-2');
  });

  it('findWorker with sticky preference prefers that worker', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      queue: 'default',
      activities: ['processOrder'],
      concurrency: 5,
    });

    registry.register({
      id: 'worker-2',
      queue: 'default',
      activities: ['processOrder'],
      concurrency: 5,
    });

    // Both have equal load, but sticky preference for worker-2
    const best = registry.findWorker('processOrder', { sticky: 'worker-2' });
    expect(best).toBeDefined();
    expect(best!.id).toBe('worker-2');
  });

  it('findWorker with sticky falls back to least-loaded when sticky is at capacity', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      queue: 'default',
      activities: ['processOrder'],
      concurrency: 2,
    });

    registry.register({
      id: 'worker-2',
      queue: 'default',
      activities: ['processOrder'],
      concurrency: 2,
    });

    // Fill worker-1 to capacity
    registry.taskAssigned('worker-1');
    registry.taskAssigned('worker-1');

    const best = registry.findWorker('processOrder', { sticky: 'worker-1' });
    expect(best).toBeDefined();
    expect(best!.id).toBe('worker-2');
  });

  it('findWorker returns undefined when no worker available', () => {
    const registry = new WorkerRegistry();
    const best = registry.findWorker('unknownActivity');
    expect(best).toBeUndefined();
  });

  it('findWorker returns undefined when all workers are at capacity', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      queue: 'default',
      activities: ['processOrder'],
      concurrency: 1,
    });

    registry.taskAssigned('worker-1');

    const best = registry.findWorker('processOrder');
    expect(best).toBeUndefined();
  });

  it('size reflects worker count', () => {
    const registry = new WorkerRegistry();
    expect(registry.size).toBe(0);

    registry.register({
      id: 'worker-1',
      queue: 'default',
      activities: ['processOrder'],
      concurrency: 5,
    });

    expect(registry.size).toBe(1);

    registry.register({
      id: 'worker-2',
      queue: 'default',
      activities: ['sendEmail'],
      concurrency: 3,
    });

    expect(registry.size).toBe(2);

    registry.unregister('worker-1');
    expect(registry.size).toBe(1);
  });

  it('getAll returns all workers', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      queue: 'default',
      activities: ['processOrder'],
      concurrency: 5,
    });

    registry.register({
      id: 'worker-2',
      queue: 'default',
      activities: ['sendEmail'],
      concurrency: 3,
    });

    const all = registry.getAll();
    expect(all).toHaveLength(2);

    const ids = all.map((worker) => worker.id);
    expect(ids).toContain('worker-1');
    expect(ids).toContain('worker-2');
  });

  it('registered workers have connectedAt and lastHeartbeat timestamps', () => {
    const registry = new WorkerRegistry();
    const before = Date.now();

    registry.register({
      id: 'worker-1',
      queue: 'default',
      activities: ['processOrder'],
      concurrency: 5,
    });

    const worker = registry.getAll()[0]!;
    expect(worker.connectedAt).toBeGreaterThanOrEqual(before);
    expect(worker.lastHeartbeat).toBeGreaterThanOrEqual(before);
    expect(worker.inFlight).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Queue-based filtering
  // -------------------------------------------------------------------------

  it('findWorker filters by queue when specified', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'billing-worker',
      queue: 'billing',
      activities: ['charge'],
      concurrency: 5,
    });

    registry.register({
      id: 'shipping-worker',
      queue: 'shipping',
      activities: ['charge'],
      concurrency: 5,
    });

    const billing = registry.findWorker('charge', { queue: 'billing' });
    expect(billing).toBeDefined();
    expect(billing!.id).toBe('billing-worker');

    const shipping = registry.findWorker('charge', { queue: 'shipping' });
    expect(shipping).toBeDefined();
    expect(shipping!.id).toBe('shipping-worker');
  });

  it('findWorker returns undefined when no worker exists on the specified queue', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'billing-worker',
      queue: 'billing',
      activities: ['charge'],
      concurrency: 5,
    });

    const result = registry.findWorker('charge', { queue: 'shipping' });
    expect(result).toBeUndefined();
  });

  it('findWorker matches all queues when queue is not specified', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'billing-worker',
      queue: 'billing',
      activities: ['charge'],
      concurrency: 5,
    });

    const result = registry.findWorker('charge');
    expect(result).toBeDefined();
    expect(result!.id).toBe('billing-worker');
  });

  it('registered workers store their queue', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      queue: 'billing',
      activities: ['charge'],
      concurrency: 5,
    });

    const worker = registry.getAll()[0]!;
    expect(worker.queue).toBe('billing');
  });

  // -------------------------------------------------------------------------
  // Visibility timeout tracking
  // -------------------------------------------------------------------------

  describe('visibility timeout', () => {
    it('assignTask tracks in-flight task with deadline', () => {
      const registry = new WorkerRegistry();
      registry.register({ id: 'w1', queue: 'default', activities: ['doWork'], concurrency: 5 });

      const now = Date.now();
      registry.assignTask('w1', 'op-1', 30_000);

      // Task just assigned — should not be expired yet
      const expired = registry.checkExpiredTasks(now + 1000);
      expect(expired).toHaveLength(0);
    });

    it('checkExpiredTasks returns overdue tasks', () => {
      const registry = new WorkerRegistry();
      registry.register({ id: 'w1', queue: 'default', activities: ['doWork'], concurrency: 5 });

      registry.assignTask('w1', 'op-1', 500);

      // Check well past the deadline
      const expired = registry.checkExpiredTasks(Date.now() + 60_000);
      expect(expired).toHaveLength(1);
      expect(expired[0]!.operationId).toBe('op-1');
      expect(expired[0]!.workerId).toBe('w1');
    });

    it('extendVisibility extends the deadline', () => {
      const registry = new WorkerRegistry();
      registry.register({ id: 'w1', queue: 'default', activities: ['doWork'], concurrency: 5 });

      registry.assignTask('w1', 'op-1', 500);

      // Extend by 60 seconds
      registry.extendVisibility('op-1', 60_000);

      // The original deadline would have been ~500ms from now.
      // After extending by 60s, should not be expired even after 10s
      const expired = registry.checkExpiredTasks(Date.now() + 10_000);
      expect(expired).toHaveLength(0);
    });

    it('non-expired tasks are not returned by checkExpiredTasks', () => {
      const registry = new WorkerRegistry();
      registry.register({ id: 'w1', queue: 'default', activities: ['doWork'], concurrency: 5 });
      registry.register({ id: 'w2', queue: 'default', activities: ['doWork'], concurrency: 5 });

      registry.assignTask('w1', 'op-1', 60_000); // expires in 60s
      registry.assignTask('w2', 'op-2', 100); // expires in 100ms

      // Check at 10s from now — only op-2 should be expired
      const expired = registry.checkExpiredTasks(Date.now() + 10_000);
      expect(expired).toHaveLength(1);
      expect(expired[0]!.operationId).toBe('op-2');
    });

    it('extendVisibility is a no-op for unknown operations', () => {
      const registry = new WorkerRegistry();
      // Should not throw
      expect(() => registry.extendVisibility('nonexistent', 1000)).not.toThrow();
    });

    it('assignTask also increments worker inFlight count', () => {
      const registry = new WorkerRegistry();
      registry.register({ id: 'w1', queue: 'default', activities: ['doWork'], concurrency: 5 });

      registry.assignTask('w1', 'op-1', 30_000);

      const worker = registry.getAll()[0]!;
      expect(worker.inFlight).toBe(1);
    });
  });
});
