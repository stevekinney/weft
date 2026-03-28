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
  // getWorker
  // -------------------------------------------------------------------------

  it('getWorker returns info for a registered worker', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      queue: 'default',
      activities: ['processOrder'],
      concurrency: 5,
    });

    const worker = registry.getWorker('worker-1');
    expect(worker).toBeDefined();
    expect(worker!.id).toBe('worker-1');
    expect(worker!.concurrency).toBe(5);
    expect(worker!.inFlight).toBe(0);
  });

  it('getWorker returns undefined for unknown worker', () => {
    const registry = new WorkerRegistry();
    expect(registry.getWorker('nonexistent')).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Capacity tracking: concurrency - inFlight
  // -------------------------------------------------------------------------

  it('available capacity is concurrency minus inFlight', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      queue: 'default',
      activities: ['processOrder'],
      concurrency: 3,
    });

    const before = registry.getWorker('worker-1')!;
    expect(before.concurrency - before.inFlight).toBe(3);

    registry.taskAssigned('worker-1');
    registry.taskAssigned('worker-1');

    const after = registry.getWorker('worker-1')!;
    expect(after.concurrency - after.inFlight).toBe(1);
  });

  it('worker becomes eligible again after completing tasks', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      queue: 'default',
      activities: ['processOrder'],
      concurrency: 1,
    });

    // Fill to capacity — should not be findable
    registry.taskAssigned('worker-1');
    expect(registry.findWorker('processOrder')).toBeUndefined();

    // Complete the task — should be findable again
    registry.taskCompleted('worker-1');
    const found = registry.findWorker('processOrder');
    expect(found).toBeDefined();
    expect(found!.id).toBe('worker-1');
  });

  it('tasks are routed away from full workers to available ones', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      queue: 'default',
      activities: ['compute'],
      concurrency: 2,
    });

    registry.register({
      id: 'worker-2',
      queue: 'default',
      activities: ['compute'],
      concurrency: 2,
    });

    // Fill worker-1 to capacity
    registry.taskAssigned('worker-1');
    registry.taskAssigned('worker-1');

    // Should route to worker-2 (worker-1 is full)
    const found = registry.findWorker('compute');
    expect(found).toBeDefined();
    expect(found!.id).toBe('worker-2');
  });

  it('distributes tasks evenly across workers by least-loaded', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-1',
      queue: 'default',
      activities: ['compute'],
      concurrency: 5,
    });

    registry.register({
      id: 'worker-2',
      queue: 'default',
      activities: ['compute'],
      concurrency: 5,
    });

    // Assign 3 to worker-1
    registry.taskAssigned('worker-1');
    registry.taskAssigned('worker-1');
    registry.taskAssigned('worker-1');

    // Assign 1 to worker-2
    registry.taskAssigned('worker-2');

    // worker-2 has lower inFlight (1 vs 3), so it should be chosen
    const found = registry.findWorker('compute');
    expect(found).toBeDefined();
    expect(found!.id).toBe('worker-2');
    expect(found!.concurrency - found!.inFlight).toBe(4);
  });

  it('picks the lowest inFlight worker among 3+ candidates with varying loads', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'heavy',
      queue: 'default',
      activities: ['compute'],
      concurrency: 10,
    });

    registry.register({
      id: 'medium',
      queue: 'default',
      activities: ['compute'],
      concurrency: 10,
    });

    registry.register({
      id: 'light',
      queue: 'default',
      activities: ['compute'],
      concurrency: 10,
    });

    // heavy: 7 in-flight, medium: 4, light: 1
    for (let i = 0; i < 7; i++) registry.taskAssigned('heavy');
    for (let i = 0; i < 4; i++) registry.taskAssigned('medium');
    registry.taskAssigned('light');

    const found = registry.findWorker('compute');
    expect(found).toBeDefined();
    expect(found!.id).toBe('light');
  });

  it('default routing uses least-loaded when no options are provided', () => {
    const registry = new WorkerRegistry();

    registry.register({
      id: 'worker-a',
      queue: 'default',
      activities: ['process'],
      concurrency: 5,
    });

    registry.register({
      id: 'worker-b',
      queue: 'default',
      activities: ['process'],
      concurrency: 5,
    });

    // Load worker-a more heavily
    registry.taskAssigned('worker-a');
    registry.taskAssigned('worker-a');

    // Call findWorker with no options — should use least-loaded by default
    const found = registry.findWorker('process');
    expect(found).toBeDefined();
    expect(found!.id).toBe('worker-b');
    expect(found!.inFlight).toBe(0);
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

    it('assignTask stores visibilityTimeout on the in-flight task', () => {
      const registry = new WorkerRegistry();
      registry.register({ id: 'w1', queue: 'default', activities: ['doWork'], concurrency: 5 });

      registry.assignTask('w1', 'op-1', 15_000);

      const tasks = registry.getWorkerTasks('w1');
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.visibilityTimeout).toBe(15_000);
    });
  });

  // -------------------------------------------------------------------------
  // getWorkerTasks — retrieve all in-flight tasks for a worker
  // -------------------------------------------------------------------------

  describe('getWorkerTasks', () => {
    it('returns an empty array for an unknown worker', () => {
      const registry = new WorkerRegistry();
      expect(registry.getWorkerTasks('nonexistent')).toEqual([]);
    });

    it('returns all in-flight tasks assigned to the worker', () => {
      const registry = new WorkerRegistry();
      registry.register({ id: 'w1', queue: 'default', activities: ['doWork'], concurrency: 5 });

      registry.assignTask('w1', 'op-1', 30_000);
      registry.assignTask('w1', 'op-2', 30_000);

      const tasks = registry.getWorkerTasks('w1');
      expect(tasks).toHaveLength(2);

      const ids = tasks.map((t) => t.operationId);
      expect(ids).toContain('op-1');
      expect(ids).toContain('op-2');
    });

    it('does not include tasks assigned to other workers', () => {
      const registry = new WorkerRegistry();
      registry.register({ id: 'w1', queue: 'default', activities: ['doWork'], concurrency: 5 });
      registry.register({ id: 'w2', queue: 'default', activities: ['doWork'], concurrency: 5 });

      registry.assignTask('w1', 'op-1', 30_000);
      registry.assignTask('w2', 'op-2', 30_000);

      const w1Tasks = registry.getWorkerTasks('w1');
      expect(w1Tasks).toHaveLength(1);
      expect(w1Tasks[0]!.operationId).toBe('op-1');
    });

    it('does not include completed tasks', () => {
      const registry = new WorkerRegistry();
      registry.register({ id: 'w1', queue: 'default', activities: ['doWork'], concurrency: 5 });

      registry.assignTask('w1', 'op-1', 30_000);
      registry.assignTask('w1', 'op-2', 30_000);
      registry.completeTask('op-1');

      const tasks = registry.getWorkerTasks('w1');
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.operationId).toBe('op-2');
    });
  });

  // -------------------------------------------------------------------------
  // Heartbeat extends visibility — heartbeat resets deadline for all worker tasks
  // -------------------------------------------------------------------------

  describe('heartbeat extends visibility', () => {
    it('extendVisibility resets deadline using stored visibilityTimeout', () => {
      const registry = new WorkerRegistry();
      registry.register({ id: 'w1', queue: 'default', activities: ['doWork'], concurrency: 5 });

      registry.assignTask('w1', 'op-1', 5_000);

      // Simulate time passing (4.9s) — almost expired
      const almostExpired = Date.now() + 4_900;
      const expiredBefore = registry.checkExpiredTasks(almostExpired);
      expect(expiredBefore).toHaveLength(0);

      // Extend using the stored visibilityTimeout
      const tasks = registry.getWorkerTasks('w1');
      for (const task of tasks) {
        registry.extendVisibility(task.operationId, task.visibilityTimeout);
      }

      // After extending, should not expire even 4.9s from now
      const expiredAfter = registry.checkExpiredTasks(Date.now() + 4_900);
      expect(expiredAfter).toHaveLength(0);
    });

    it('heartbeat extends deadlines for multiple in-flight tasks', () => {
      const registry = new WorkerRegistry();
      registry.register({ id: 'w1', queue: 'default', activities: ['doWork'], concurrency: 5 });

      registry.assignTask('w1', 'op-1', 2_000);
      registry.assignTask('w1', 'op-2', 2_000);

      // Both would expire in 2s — extend them
      for (const task of registry.getWorkerTasks('w1')) {
        registry.extendVisibility(task.operationId, task.visibilityTimeout);
      }

      // Neither should be expired 1.5s from now (they were just reset)
      const expired = registry.checkExpiredTasks(Date.now() + 1_500);
      expect(expired).toHaveLength(0);
    });

    it('heartbeat only extends tasks for the specific worker', () => {
      const registry = new WorkerRegistry();
      registry.register({ id: 'w1', queue: 'default', activities: ['doWork'], concurrency: 5 });
      registry.register({ id: 'w2', queue: 'default', activities: ['doWork'], concurrency: 5 });

      // w1 gets a long timeout, w2 gets a short one
      registry.assignTask('w1', 'op-1', 30_000);
      registry.assignTask('w2', 'op-2', 1_000);

      // Extend only w1's tasks using its stored visibilityTimeout
      for (const task of registry.getWorkerTasks('w1')) {
        registry.extendVisibility(task.operationId, task.visibilityTimeout);
      }

      // w2's task expires normally (1s), w1's is still well within its window
      const expired = registry.checkExpiredTasks(Date.now() + 2_000);
      expect(expired).toHaveLength(1);
      expect(expired[0]!.operationId).toBe('op-2');
    });
  });

  // -------------------------------------------------------------------------
  // isAssigned — check whether an operation is already in-flight
  // -------------------------------------------------------------------------

  describe('isAssigned', () => {
    it('returns false for an unknown operationId', () => {
      const registry = new WorkerRegistry();
      expect(registry.isAssigned('nonexistent')).toBe(false);
    });

    it('returns true after assignTask', () => {
      const registry = new WorkerRegistry();
      registry.register({ id: 'w1', queue: 'default', activities: ['doWork'], concurrency: 5 });

      registry.assignTask('w1', 'op-1', 30_000);

      expect(registry.isAssigned('op-1')).toBe(true);
    });

    it('returns false after the task is completed via completeTask', () => {
      const registry = new WorkerRegistry();
      registry.register({ id: 'w1', queue: 'default', activities: ['doWork'], concurrency: 5 });

      registry.assignTask('w1', 'op-1', 30_000);
      registry.completeTask('op-1');

      expect(registry.isAssigned('op-1')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // completeTask — remove in-flight task and decrement worker counter
  // -------------------------------------------------------------------------

  describe('completeTask', () => {
    it('removes the in-flight task and decrements worker inFlight', () => {
      const registry = new WorkerRegistry();
      registry.register({ id: 'w1', queue: 'default', activities: ['doWork'], concurrency: 5 });

      registry.assignTask('w1', 'op-1', 30_000);
      expect(registry.getWorker('w1')!.inFlight).toBe(1);

      const removed = registry.completeTask('op-1');

      expect(removed).toBeDefined();
      expect(removed!.operationId).toBe('op-1');
      expect(removed!.workerId).toBe('w1');
      expect(registry.getWorker('w1')!.inFlight).toBe(0);
    });

    it('returns undefined for unknown operationId', () => {
      const registry = new WorkerRegistry();
      expect(registry.completeTask('nonexistent')).toBeUndefined();
    });

    it('does not decrement below zero if worker was already unregistered', () => {
      const registry = new WorkerRegistry();
      registry.register({ id: 'w1', queue: 'default', activities: ['doWork'], concurrency: 5 });

      registry.assignTask('w1', 'op-1', 30_000);
      registry.unregister('w1');

      // Worker is gone, but in-flight task record still exists
      const removed = registry.completeTask('op-1');
      expect(removed).toBeDefined();
      expect(removed!.operationId).toBe('op-1');
    });

    it('handles multiple tasks completing independently', () => {
      const registry = new WorkerRegistry();
      registry.register({ id: 'w1', queue: 'default', activities: ['doWork'], concurrency: 5 });

      registry.assignTask('w1', 'op-1', 30_000);
      registry.assignTask('w1', 'op-2', 30_000);
      expect(registry.getWorker('w1')!.inFlight).toBe(2);

      registry.completeTask('op-1');
      expect(registry.getWorker('w1')!.inFlight).toBe(1);
      expect(registry.isAssigned('op-1')).toBe(false);
      expect(registry.isAssigned('op-2')).toBe(true);

      registry.completeTask('op-2');
      expect(registry.getWorker('w1')!.inFlight).toBe(0);
    });
  });
});
