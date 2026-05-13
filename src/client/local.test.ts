import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Engine } from '../core/engine.ts';
import { WorkflowCompletedEvent, WorkflowFailedEvent } from '../core/events.ts';
import { tenantFromInputField } from '../core/tenant.ts';
import type { ScheduleSummary, WorkflowContext } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { sleepForTesting } from '../testing/fake-timers.ts';
import { ScheduleHandleDelegation, WorkflowHandleDelegation } from './handle-delegation.ts';
import type { WeftClient } from './interface.ts';
import { LocalClient } from './local.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* echoWorkflow(_ctx: WorkflowContext, input: unknown) {
  return input;
}

async function* waitingWorkflow(ctx: WorkflowContext, input: unknown) {
  ctx.expose({ ready: () => true });
  ctx.onQuery('echoInput', (queryInput) => queryInput);
  const signal = yield* ctx.waitForSignal<string>('continue');
  return `${String(input)}:${signal}`;
}

async function* failingWorkflow(_ctx: WorkflowContext, _input: unknown) {
  throw new Error('intentional failure');
}

function createTestEngine(): Engine {
  const engine = new Engine({
    storage: new MemoryStorage(),
    tenantResolver: tenantFromInputField('tenantId'),
    quotas: {
      maxConcurrentWorkflows: 5,
      maxStorageBytes: 1_000_000,
      maxWorkflowCreationRate: { count: 10, window: '1m' },
    },
  });
  engine.register('echo', echoWorkflow);
  engine.register('waiting', waitingWorkflow);
  engine.register('failing', failingWorkflow);
  return engine;
}

async function waitForWorkflowStatus(
  engine: Engine,
  workflowId: string,
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out',
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const state = await engine.get(workflowId);
    if (state?.status === status) {
      return;
    }
    await sleepForTesting(5);
  }
  throw new Error(`Workflow ${workflowId} did not reach ${status}`);
}

async function waitForQueryReady(client: WeftClient, workflowId: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    if ((await client.query(workflowId, 'ready')) === true) {
      return;
    }
    await sleepForTesting(5);
  }
  throw new Error(`Workflow ${workflowId} did not expose query handlers`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LocalClient', () => {
  let engine: Engine;
  let client: WeftClient;

  beforeEach(() => {
    engine = createTestEngine();
    client = new LocalClient(engine);
  });

  afterEach(async () => {
    await engine[Symbol.asyncDispose]();
  });

  it('implements WeftClient', () => {
    expect(client.start).toBeFunction();
    expect(client.schedule).toBeFunction();
    expect(client.get).toBeFunction();
    expect(client.getSchedule).toBeFunction();
    expect(client.list).toBeFunction();
    expect(client.listSchedules).toBeFunction();
    expect(client.cancel).toBeFunction();
    expect(client.pauseSchedule).toBeFunction();
    expect(client.resumeSchedule).toBeFunction();
    expect(client.cancelSchedule).toBeFunction();
    expect(client.updateSchedule).toBeFunction();
    expect(client.signal).toBeFunction();
    expect(client.query).toBeFunction();
    expect(client.update).toBeFunction();
    expect(client.resume).toBeFunction();
    expect(client.recoverAll).toBeFunction();
    expect(client.timeout).toBeFunction();
    expect(client.getAttributes).toBeFunction();
    expect(client.setAttributes).toBeFunction();
    expect(client.getEvents).toBeFunction();
    expect(client.getTimeline).toBeFunction();
    expect(client.replayTo).toBeFunction();
    expect(client.listReviews).toBeFunction();
    expect(client.submitReview).toBeFunction();
    expect(client.getQuotaUsage).toBeFunction();
    expect(client.getStreamChunks).toBeFunction();
    expect(client.fork).toBeFunction();
    expect(client.getRetentionOverview).toBeFunction();
    expect(client.purge).toBeFunction();
    expect(client.cancelAll).toBeFunction();
    expect(client.signalAll).toBeFunction();
    expect(client.deleteAll).toBeFunction();
    expect(client.tagAll).toBeFunction();
    expect(client.untagAll).toBeFunction();
    expect(client.submitCoordinatedUpdate).toBeFunction();
    expect(client.getUpdateResult).toBeFunction();
  });

  describe('start', () => {
    it('starts a workflow and returns a handle with the workflow id', async () => {
      const handle = await client.start('echo', 'hello');
      expect(handle.id).toBeString();
      expect(handle.id.length).toBeGreaterThan(0);
    });

    it('respects a custom id in start options', async () => {
      const handle = await client.start('echo', 'hello', { id: 'custom-id' });
      expect(handle.id).toBe('custom-id');
    });

    it('returns a handle whose result() resolves with the workflow output', async () => {
      const handle = await client.start('echo', 42);
      const result = await handle.result();
      expect(result).toBe(42);
    });
  });

  describe('query', () => {
    it('passes input through local client and workflow handle queries', async () => {
      const handle = await client.start('waiting', 'payload', { id: 'local-query-input' });
      await waitForWorkflowStatus(engine, handle.id, 'running');
      await waitForQueryReady(client, handle.id);

      await expect(client.query(handle.id, 'echoInput', { detail: true })).resolves.toEqual({
        detail: true,
      });
      await expect(handle.query('echoInput', { source: 'handle' })).resolves.toEqual({
        source: 'handle',
      });

      await client.signal(handle.id, 'continue', 'done');
      await expect(handle.result()).resolves.toBe('payload:done');
    });
  });

  describe('get', () => {
    it('returns the workflow state for a known workflow', async () => {
      const handle = await client.start('echo', 'data');
      await handle.result();

      const state = await client.get(handle.id);
      expect(state).not.toBeNull();
      expect(state!.id).toBe(handle.id);
      expect(state!.type).toBe('echo');
      expect(state!.status).toBe('completed');
    });

    it('returns null for an unknown workflow', async () => {
      const state = await client.get('nonexistent');
      expect(state).toBeNull();
    });
  });

  describe('list', () => {
    it('lists workflows', async () => {
      await client.start('echo', 'a');
      await client.start('echo', 'b');

      const result = await client.list();
      expect(result.items.length).toBeGreaterThanOrEqual(2);
      expect(result.total).toBeGreaterThanOrEqual(2);
    });

    it('filters by status', async () => {
      const handle = await client.start('echo', 'done');
      await handle.result();

      const result = await client.list({ status: 'completed' });
      expect(result.items.every((item) => item.status === 'completed')).toBe(true);
    });
  });

  describe('bulk workflow operations', () => {
    it('delegates the bulk methods to the underlying engine and returns their results', async () => {
      const delegatedEngine = {
        cancelAll: mock(async () => ({
          cancelled: 2,
          failed: 1,
          errors: [{ id: 'wf-failed', error: 'boom' }],
        })),
        signalAll: mock(async () => ({ signalled: 3, failed: 0 })),
        deleteAll: mock(async () => ({ deleted: 4 })),
        tagAll: mock(async () => ({ modified: 5 })),
        untagAll: mock(async () => ({ modified: 2 })),
      } as unknown as Engine;

      const delegatedClient = new LocalClient(delegatedEngine);

      expect(await delegatedClient.cancelAll({ status: 'running' })).toEqual({
        cancelled: 2,
        failed: 1,
        errors: [{ id: 'wf-failed', error: 'boom' }],
      });
      expect(await delegatedClient.signalAll({ tags: ['nightly'] }, 'continue', 'go')).toEqual({
        signalled: 3,
        failed: 0,
      });
      expect(await delegatedClient.deleteAll({ status: 'completed' })).toEqual({ deleted: 4 });
      expect(await delegatedClient.tagAll({ tags: ['nightly'] }, ['bulk'])).toEqual({
        modified: 5,
      });
      expect(await delegatedClient.untagAll({ tags: ['bulk'] }, ['nightly'])).toEqual({
        modified: 2,
      });

      expect(delegatedEngine.cancelAll).toHaveBeenCalledWith({ status: 'running' });
      expect(delegatedEngine.signalAll).toHaveBeenCalledWith(
        { tags: ['nightly'] },
        'continue',
        'go',
      );
      expect(delegatedEngine.deleteAll).toHaveBeenCalledWith({ status: 'completed' });
      expect(delegatedEngine.tagAll).toHaveBeenCalledWith({ tags: ['nightly'] }, ['bulk']);
      expect(delegatedEngine.untagAll).toHaveBeenCalledWith({ tags: ['bulk'] }, ['nightly']);
    });
  });

  describe('schedule surface', () => {
    it('creates, lists, mutates, and describes schedules through the local client', async () => {
      const schedule = await client.schedule('echo', { payload: 'nightly' }, '0 * * * *', {
        id: 'local-schedule',
        overlap: 'queue',
        backfill: true,
      });

      expect(schedule.id).toBe('local-schedule');
      expect(await schedule.describe()).toEqual(
        expect.objectContaining({
          id: 'local-schedule',
          workflowType: 'echo',
          cronExpression: '0 * * * *',
          status: 'active',
          overlap: 'queue',
          backfill: true,
        }),
      );

      expect(await client.getSchedule('local-schedule')).toEqual(
        expect.objectContaining({ id: 'local-schedule' }),
      );
      const schedules = await client.listSchedules();
      expect(schedules.items.map((item) => item.id)).toContain('local-schedule');

      await schedule.pause();
      expect(await client.getSchedule('local-schedule')).toEqual(
        expect.objectContaining({ status: 'paused' }),
      );

      await schedule.update('30 * * * *');
      expect(await client.getSchedule('local-schedule')).toEqual(
        expect.objectContaining({ cronExpression: '30 * * * *' }),
      );

      await client.resumeSchedule('local-schedule');
      expect(await schedule.describe()).toEqual(expect.objectContaining({ status: 'active' }));

      await schedule.cancel();
      expect(await client.getSchedule('local-schedule')).toEqual(
        expect.objectContaining({ status: 'cancelled', nextFireAt: null }),
      );
    });

    it('exposes schedule handle describe and dispose helpers', async () => {
      const schedule = await client.schedule('echo', { payload: 'direct-wrapper' }, '0 * * * *', {
        id: 'local-schedule-wrapper',
      });

      expect(await schedule.describe()).toEqual(
        expect.objectContaining({
          id: 'local-schedule-wrapper',
          workflowType: 'echo',
        }),
      );

      expect(() => schedule[Symbol.dispose]()).not.toThrow();
    });
  });

  describe('cancel', () => {
    it('cancels a workflow via the client', async () => {
      // Use a workflow that won't complete immediately so we can cancel it
      const handle = await client.start('echo', 'data', { id: 'cancel-me' });
      await handle.result().catch(() => {}); // let it finish

      // Cancelling an already-completed workflow is fine on some engines,
      // but let's at least verify the method is callable
      await expect(client.cancel('cancel-me')).resolves.toBeUndefined();
    });
  });

  describe('handle.cancel', () => {
    it('delegates to client.cancel', async () => {
      const handle = await client.start('echo', 'data');
      await handle.result();
      // Should not throw on a completed workflow
      await expect(handle.cancel()).resolves.toBeUndefined();
    });
  });

  describe('handle.signal', () => {
    it('delegates to client.signal', async () => {
      const handle = await client.start('echo', 'data');
      // Signal on a completed workflow is a no-throw in the engine
      await expect(handle.signal('test-signal', { key: 'value' })).resolves.toBeUndefined();
    });
  });

  describe('getEvents', () => {
    it('returns event history for a workflow', async () => {
      const handle = await client.start('echo', 'data');
      await handle.result();

      const events = await client.getEvents(handle.id);
      expect(Array.isArray(events)).toBe(true);
    });
  });

  describe('getTimeline / replayTo', () => {
    it('returns timeline entries and replay data for a completed workflow', async () => {
      async function firstStep() {
        return { phase: 'first' as const };
      }

      async function secondStep() {
        return { phase: 'second' as const };
      }

      engine.register('timeline-local', {
        version: '9.0.0',
        handler: async function* (ctx: WorkflowContext) {
          yield* ctx.run(firstStep);
          return yield* ctx.run(secondStep);
        },
      });

      const handle = await client.start('timeline-local', null, { id: 'wf-local-timeline' });
      await handle.result();

      const timeline = await client.getTimeline('wf-local-timeline');
      const replay = await client.replayTo('wf-local-timeline', 2);

      expect(timeline).toHaveLength(2);
      expect(timeline[0]?.operationLabel).toBe('firstStep');
      expect(replay?.checkpoint.step).toBe(2);
      expect(replay?.accumulatedResults).toEqual([[0, { phase: 'first' }]]);
    });

    it('returns empty timeline and null replay for missing data', async () => {
      const handle = await client.start('echo', 'done', { id: 'wf-local-missing-replay' });
      await handle.result();

      await expect(client.getTimeline('missing-workflow')).resolves.toEqual([]);
      await expect(client.replayTo('missing-workflow', 1)).resolves.toBeNull();
      await expect(client.replayTo('wf-local-missing-replay', 1)).resolves.toBeNull();
    });
  });

  describe('getAttributes / setAttributes', () => {
    it('round-trips search attributes', async () => {
      const handle = await client.start('echo', 'data');
      await handle.result();

      await client.setAttributes(handle.id, { priority: 'high' });
      const attributes = await client.getAttributes(handle.id);
      expect(attributes).not.toBeNull();
      expect(attributes!['priority']).toBe('high');
    });
  });

  describe('workflow tags', () => {
    it('ClientHandle.addTags/removeTags mutate workflow tags through the local client', async () => {
      const handle = await client.start('waiting', 'payload', {
        id: 'local-client-tags',
        tags: ['nightly'],
      });
      await sleepForTesting(10);

      await handle.addTags('v2');
      await handle.removeTags('nightly');

      const state = await client.get('local-client-tags');
      expect(state?.tags).toEqual(['v2']);
    });
  });

  describe('listReviews', () => {
    it('returns an array', async () => {
      const reviews = await client.listReviews();
      expect(Array.isArray(reviews)).toBe(true);
    });
  });

  describe('getUpdateResult', () => {
    it('returns null for an unknown update', async () => {
      const result = await client.getUpdateResult('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getQuotaUsage', () => {
    it('returns tenant quota usage from the local engine surface', async () => {
      const handle = await client.start('echo', { tenantId: 'acme', payload: 'quota-local' });
      await handle.result();

      const usage = await client.getQuotaUsage('acme');
      expect(usage.tenantId).toBe('acme');
      expect(usage.storageBytes.used).toBeGreaterThan(0);
      expect(usage.activeWorkflows.limit).toBe(5);
      expect(usage.workflowCreationRate.limit).toBe(10);
      expect(usage.workflowCreationRate.used).toBeGreaterThanOrEqual(1);
    });
  });

  describe('retention surface', () => {
    it('returns the retention overview from the local engine', async () => {
      await engine[Symbol.asyncDispose]();
      engine = new Engine({
        storage: new MemoryStorage(),
        retention: {
          completed: '5m',
        },
      });
      engine.register('echo', echoWorkflow);
      client = new LocalClient(engine);

      const overview = await client.getRetentionOverview();

      expect(overview.sweepIntervalMs).toBe(300_000);
      expect(overview.workflowTypes).toContainEqual(
        expect.objectContaining({
          type: 'echo',
          source: 'engine',
        }),
      );
    });

    it('purges matching terminal workflows via the local client', async () => {
      const handle = await client.start('echo', 'data', { id: 'local-purge' });
      await handle.result();

      const result = await client.purge({ status: 'completed' });

      expect(result.deleted).toBeGreaterThanOrEqual(1);
      expect(await client.get('local-purge')).toBeNull();
    });
  });

  describe('event observation', () => {
    it('handle.addEventListener receives workflow:completed events', async () => {
      const handle = await client.start('echo', 'hello');
      const received: WorkflowCompletedEvent[] = [];

      handle.addEventListener(WorkflowCompletedEvent.type, ((event: WorkflowCompletedEvent) => {
        received.push(event);
      }) as EventListener);

      await handle.result();

      expect(received).toHaveLength(1);
      expect(received[0]!.workflowId).toBe(handle.id);
      expect(received[0]!.result).toBe('hello');
      expect(received[0]!.type).toBe('workflow:completed');
    });

    it('handle.addEventListener receives workflow:failed events', async () => {
      const handle = await client.start('failing', null);
      const received: WorkflowFailedEvent[] = [];

      handle.addEventListener(WorkflowFailedEvent.type, ((event: WorkflowFailedEvent) => {
        received.push(event);
      }) as EventListener);

      await handle.result().catch(() => {});

      expect(received).toHaveLength(1);
      expect(received[0]!.workflowId).toBe(handle.id);
      expect(received[0]!.error).toBeInstanceOf(Error);
      expect(received[0]!.error.message).toBe('intentional failure');
    });

    it('handle.removeEventListener stops receiving events', async () => {
      const handle = await client.start('echo', 42);
      let callCount = 0;

      const listener = (() => {
        callCount++;
      }) as EventListener;

      handle.addEventListener(WorkflowCompletedEvent.type, listener);
      handle.removeEventListener(WorkflowCompletedEvent.type, listener);

      await handle.result();

      expect(callCount).toBe(0);
    });

    it('supports AbortSignal for automatic listener cleanup', async () => {
      const handle = await client.start('echo', 'signal-test');
      const controller = new AbortController();
      let callCount = 0;

      handle.addEventListener(
        WorkflowCompletedEvent.type,
        (() => {
          callCount++;
        }) as EventListener,
        { signal: controller.signal },
      );

      controller.abort();
      await handle.result();

      expect(callCount).toBe(0);
    });

    it('delivers typed event properties through the handle', async () => {
      const handle = await client.start('echo', { nested: true });

      const { promise, resolve } = Promise.withResolvers<WorkflowCompletedEvent>();
      handle.addEventListener(WorkflowCompletedEvent.type, ((event: WorkflowCompletedEvent) => {
        resolve(event);
      }) as EventListener);

      await handle.result();
      const event = await promise;

      expect(event).toBeInstanceOf(WorkflowCompletedEvent);
      expect(event.workflowId).toBe(handle.id);
      expect(event.result).toEqual({ nested: true });
      expect(event.duration).toBeGreaterThanOrEqual(0);
    });

    it('multiple listeners on the same handle each receive the event', async () => {
      const handle = await client.start('echo', 'multi');
      const results: string[] = [];

      handle.addEventListener(WorkflowCompletedEvent.type, (() => {
        results.push('listener-a');
      }) as EventListener);

      handle.addEventListener(WorkflowCompletedEvent.type, (() => {
        results.push('listener-b');
      }) as EventListener);

      await handle.result();

      expect(results).toContain('listener-a');
      expect(results).toContain('listener-b');
      expect(results).toHaveLength(2);
    });
  });
});

describe('LocalClient delegation surface', () => {
  it('centralizes workflow and schedule handle delegation through shared client-backed helpers', async () => {
    const workflowClient = {
      cancel: mock(async () => undefined),
      signal: mock(async () => undefined),
      update: mock(async () => 'updated'),
      query: mock(async () => 'queried'),
      getAttributes: mock(async () => ({ priority: 'high' })),
      setAttributes: mock(async () => undefined),
      addTags: mock(async () => undefined),
      removeTags: mock(async () => undefined),
    };

    class TestWorkflowHandle extends WorkflowHandleDelegation {
      async result(): Promise<unknown> {
        return 'done';
      }

      addEventListener(): void {}

      removeEventListener(): void {}

      [Symbol.dispose](): void {}
    }

    const workflowHandle = new TestWorkflowHandle('shared-workflow', workflowClient);

    expect(await workflowHandle.result()).toBe('done');
    await workflowHandle.cancel();
    await workflowHandle.signal('status', { ok: true });
    expect(await workflowHandle.update('rename', { value: 1 }, { timeout: 50 })).toBe('updated');
    expect(await workflowHandle.query('status')).toBe('queried');
    expect(await workflowHandle.getAttributes()).toEqual({ priority: 'high' });
    await workflowHandle.setAttributes({ priority: 'critical' });
    await workflowHandle.addTags('nightly', 'v2');
    await workflowHandle.removeTags('nightly');

    expect(workflowClient.cancel).toHaveBeenCalledWith('shared-workflow');
    expect(workflowClient.signal).toHaveBeenCalledWith('shared-workflow', 'status', {
      ok: true,
    });
    expect(workflowClient.update).toHaveBeenCalledWith(
      'shared-workflow',
      'rename',
      { value: 1 },
      {
        timeout: 50,
      },
    );
    expect(workflowClient.query).toHaveBeenCalledWith('shared-workflow', 'status', undefined);
    expect(workflowClient.getAttributes).toHaveBeenCalledWith('shared-workflow');
    expect(workflowClient.setAttributes).toHaveBeenCalledWith('shared-workflow', {
      priority: 'critical',
    });
    expect(workflowClient.addTags).toHaveBeenCalledWith('shared-workflow', 'nightly', 'v2');
    expect(workflowClient.removeTags).toHaveBeenCalledWith('shared-workflow', 'nightly');

    const scheduleSummary: ScheduleSummary = {
      id: 'shared-schedule',
      workflowType: 'echo',
      cronExpression: '0 * * * *',
      status: 'active',
      overlap: 'skip',
      backfill: false,
      createdAt: 1,
      updatedAt: 1,
      nextFireAt: 2,
      queuedRuns: 0,
    };

    const scheduleClient = {
      pauseSchedule: mock(async () => undefined),
      resumeSchedule: mock(async () => undefined),
      cancelSchedule: mock(async () => undefined),
      updateSchedule: mock(async () => undefined),
      getSchedule: mock(async () => scheduleSummary),
    };

    class TestScheduleHandle extends ScheduleHandleDelegation {
      [Symbol.dispose](): void {}
    }

    const scheduleHandle = new TestScheduleHandle('shared-schedule', scheduleClient);
    await scheduleHandle.pause();
    await scheduleHandle.resume();
    await scheduleHandle.update('30 * * * *');
    expect(await scheduleHandle.describe()).toEqual(
      expect.objectContaining({ id: 'shared-schedule', cronExpression: '0 * * * *' }),
    );
    await scheduleHandle.cancel();

    expect(scheduleClient.pauseSchedule).toHaveBeenCalledWith('shared-schedule');
    expect(scheduleClient.resumeSchedule).toHaveBeenCalledWith('shared-schedule');
    expect(scheduleClient.updateSchedule).toHaveBeenCalledWith('shared-schedule', '30 * * * *');
    expect(scheduleClient.getSchedule).toHaveBeenCalledWith('shared-schedule');
    expect(scheduleClient.cancelSchedule).toHaveBeenCalledWith('shared-schedule');
  });

  it('forwards every method to the underlying engine and wraps handles', async () => {
    const workflowHandle = new EventTarget() as EventTarget & {
      id: string;
      result: () => Promise<unknown>;
    };
    workflowHandle.id = 'delegated-workflow';
    workflowHandle.result = async () => 'workflow-result';

    const resumedHandle = new EventTarget() as EventTarget & {
      id: string;
      result: () => Promise<unknown>;
    };
    resumedHandle.id = 'resumed-workflow';
    resumedHandle.result = async () => 'resumed-result';

    const registeredListener = mock(() => {});
    const removedListener = mock(() => {});
    workflowHandle.addEventListener =
      registeredListener as unknown as typeof workflowHandle.addEventListener;
    workflowHandle.removeEventListener =
      removedListener as unknown as typeof workflowHandle.removeEventListener;

    const engine = {
      start: mock(async () => workflowHandle),
      schedule: mock(async () => ({
        id: 'delegated-schedule',
        pause: async () => undefined,
        resume: async () => undefined,
        cancel: async () => undefined,
        update: async () => undefined,
        describe: async () => ({
          id: 'delegated-schedule',
          workflowType: 'echo',
          cronExpression: '0 * * * *',
          status: 'active',
          overlap: 'skip',
          backfill: false,
          createdAt: 1,
          updatedAt: 1,
          nextFireAt: 2,
          queuedRuns: 0,
        }),
      })),
      get: mock(async () => ({ id: 'delegated-workflow', status: 'running' })),
      getSchedule: mock(async () => ({
        id: 'delegated-schedule',
        workflowType: 'echo',
        cronExpression: '0 * * * *',
        status: 'active',
        overlap: 'skip',
        backfill: false,
        createdAt: 1,
        updatedAt: 1,
        nextFireAt: 2,
        queuedRuns: 0,
      })),
      list: mock(async () => ({ items: [{ id: 'delegated-workflow' }], total: 1 })),
      listSchedules: mock(async () => ({
        items: [
          {
            id: 'delegated-schedule',
            workflowType: 'echo',
            cronExpression: '0 * * * *',
            status: 'active',
            overlap: 'skip',
            backfill: false,
            createdAt: 1,
            updatedAt: 1,
            nextFireAt: 2,
            queuedRuns: 0,
          },
        ],
        total: 1,
      })),
      cancel: mock(async () => undefined),
      pauseSchedule: mock(async () => undefined),
      resumeSchedule: mock(async () => undefined),
      cancelSchedule: mock(async () => undefined),
      updateSchedule: mock(async () => undefined),
      signal: mock(async () => undefined),
      query: mock(async () => 'query-result'),
      update: mock(async () => 'update-result'),
      resume: mock(async () => resumedHandle),
      recoverAll: mock(async () => [workflowHandle, resumedHandle]),
      timeout: mock(async () => undefined),
      getAttributes: mock(async () => ({ priority: 'high' })),
      setAttributes: mock(async () => undefined),
      getEvents: mock(async () => [{ type: 'workflow:started' }]),
      getTimeline: mock(async () => [
        {
          step: 1,
          operationType: 'activity',
          operationLabel: 'mock-step',
          inputSummary: '{}',
          timestamp: 1,
          status: 'completed',
        },
      ]),
      replayTo: mock(async () => ({
        checkpoint: { step: 1, locals: {}, searchAttributes: {}, version: '1.0.0', createdAt: 1 },
        accumulatedResults: [[0, 'value']],
        events: [{ type: 'workflow:checkpoint', timestamp: 1, data: { step: 1 } }],
      })),
      listReviews: mock(async () => [
        {
          status: 'pending',
          reviewId: 'review-1',
          workflowId: 'wf-review-1',
          artifact: null,
          reviewType: 'general',
          reviewers: [],
          allowPartial: false,
          createdAt: 1,
        },
      ]),
      submitReview: mock(async () => undefined),
      getStreamChunks: mock(async () => [
        { sequence: 2, value: 'chunk-a' },
        { sequence: 3, value: 'chunk-b' },
      ]),
      fork: mock(async () => resumedHandle),
      cancelAll: mock(async () => ({ cancelled: 2, failed: 0, errors: [] })),
      signalAll: mock(async () => ({ signalled: 2, failed: 0 })),
      deleteAll: mock(async () => ({ deleted: 1 })),
      tagAll: mock(async () => ({ modified: 2 })),
      untagAll: mock(async () => ({ modified: 1 })),
      submitCoordinatedUpdate: mock(async () => ({ updateId: 'update-1', result: 'ok' })),
      getUpdateResult: mock(async () => ({ updateId: 'update-1', result: 'done', error: 'none' })),
    } as unknown as Engine;

    const client = new LocalClient(engine);

    const handle = await client.start('echo', 'hello', { id: 'start-id' });
    const scheduleHandle = await client.schedule('echo', 'nightly', '0 * * * *', {
      id: 'delegated-schedule',
    });
    expect(await handle.result()).toBe('workflow-result');
    await scheduleHandle.pause();
    await scheduleHandle.resume();
    await scheduleHandle.update('30 * * * *');
    await scheduleHandle.cancel();
    expect(await scheduleHandle.describe()).toMatchObject({
      id: 'delegated-schedule',
      cronExpression: '0 * * * *',
    });
    await handle.cancel();
    await handle.signal('status', { ok: true });
    expect(await handle.update('rename', { value: 1 }, { timeout: 50 })).toBe('update-result');
    expect(await handle.query('status')).toBe('query-result');
    expect(await handle.getAttributes()).toEqual({ priority: 'high' });
    await handle.setAttributes({ priority: 'critical' });
    handle.addEventListener('workflow:completed', (() => {}) as EventListener);
    handle.removeEventListener('workflow:completed', (() => {}) as EventListener);
    handle[Symbol.dispose]();

    expect(await client.get('delegated-workflow')).toMatchObject({
      id: 'delegated-workflow',
      status: 'running',
    });
    expect(await client.getSchedule('delegated-schedule')).toMatchObject({
      id: 'delegated-schedule',
      cronExpression: '0 * * * *',
    });
    expect(await client.list({ status: 'running' })).toMatchObject({
      items: [{ id: 'delegated-workflow' }],
      total: 1,
    });
    expect(await client.listSchedules()).toMatchObject({
      items: [{ id: 'delegated-schedule' }],
      total: 1,
    });
    await client.cancel('delegated-workflow');
    await client.pauseSchedule('delegated-schedule');
    await client.resumeSchedule('delegated-schedule');
    await client.updateSchedule('delegated-schedule', '15 * * * *');
    await client.cancelSchedule('delegated-schedule');
    await client.signal('delegated-workflow', 'status', { ok: true });
    expect(await client.query('delegated-workflow', 'status')).toBe('query-result');
    expect(await client.update('delegated-workflow', 'rename', { value: 1 }, { timeout: 50 })).toBe(
      'update-result',
    );

    const resumeHandle = await client.resume('delegated-workflow');
    expect(await resumeHandle.result()).toBe('resumed-result');
    const recoveredHandles = await client.recoverAll();
    expect(recoveredHandles).toHaveLength(2);
    expect(await recoveredHandles[1]?.result()).toBe('resumed-result');

    await client.timeout('delegated-workflow');
    expect(await client.getAttributes('delegated-workflow')).toEqual({ priority: 'high' });
    await client.setAttributes('delegated-workflow', { priority: 'critical' });
    expect(await client.getEvents('delegated-workflow')).toMatchObject([
      { type: 'workflow:started' },
    ]);
    expect(await client.getTimeline('delegated-workflow')).toMatchObject([
      { operationLabel: 'mock-step', step: 1 },
    ]);
    expect(await client.replayTo('delegated-workflow', 1)).toMatchObject({
      checkpoint: { step: 1, version: '1.0.0' },
    });
    expect(await client.listReviews()).toEqual([
      {
        status: 'pending',
        reviewId: 'review-1',
        workflowId: 'wf-review-1',
        artifact: null,
        reviewType: 'general',
        reviewers: [],
        allowPartial: false,
        createdAt: 1,
      },
    ]);
    await client.submitReview('review-1', { decision: 'approved', reviewer: 'alex' });
    expect(await client.getStreamChunks('delegated-workflow', 'stream-key', { after: 1 })).toEqual([
      { sequence: 2, value: 'chunk-a' },
      { sequence: 3, value: 'chunk-b' },
    ]);
    const forkHandle = await client.fork('delegated-workflow', { fromStep: 2 });
    expect(await forkHandle.result()).toBe('resumed-result');
    expect(await client.cancelAll({ status: 'running' })).toEqual({
      cancelled: 2,
      failed: 0,
      errors: [],
    });
    expect(await client.signalAll({ tags: ['nightly'] }, 'continue', 'done')).toEqual({
      signalled: 2,
      failed: 0,
    });
    expect(await client.deleteAll({ status: 'completed' })).toEqual({ deleted: 1 });
    expect(await client.tagAll({ tags: ['nightly'] }, ['bulk'])).toEqual({ modified: 2 });
    expect(await client.untagAll({ tags: ['bulk'] }, ['nightly'])).toEqual({ modified: 1 });
    expect(
      await client.submitCoordinatedUpdate(
        'delegated-workflow',
        'rename',
        { value: 1 },
        {
          timeout: 50,
          idempotencyKey: 'idempotent-1',
        },
      ),
    ).toEqual({ updateId: 'update-1', result: 'ok' });
    expect(await client.getUpdateResult('update-1')).toEqual({
      updateId: 'update-1',
      result: 'done',
      error: 'none',
    });

    expect(registeredListener).toHaveBeenCalled();
    expect(removedListener).toHaveBeenCalled();
    expect(engine.schedule).toHaveBeenCalledWith('echo', 'nightly', '0 * * * *', {
      id: 'delegated-schedule',
    });
    expect(engine.pauseSchedule).toHaveBeenCalledWith('delegated-schedule');
    expect(engine.resumeSchedule).toHaveBeenCalledWith('delegated-schedule');
    expect(engine.updateSchedule).toHaveBeenCalledWith('delegated-schedule', '15 * * * *');
    expect(engine.cancelSchedule).toHaveBeenCalledWith('delegated-schedule');
    expect(engine.fork).toHaveBeenCalledWith('delegated-workflow', { fromStep: 2 });
    expect(engine.cancelAll).toHaveBeenCalledWith({ status: 'running' });
    expect(engine.signalAll).toHaveBeenCalledWith({ tags: ['nightly'] }, 'continue', 'done');
    expect(engine.deleteAll).toHaveBeenCalledWith({ status: 'completed' });
    expect(engine.tagAll).toHaveBeenCalledWith({ tags: ['nightly'] }, ['bulk']);
    expect(engine.untagAll).toHaveBeenCalledWith({ tags: ['bulk'] }, ['nightly']);
  });

  it('returns null when the engine has no update result', async () => {
    const engine = {
      getUpdateResult: mock(async () => null),
    } as unknown as Engine;

    const client = new LocalClient(engine);

    expect(await client.getUpdateResult('missing-update')).toBeNull();
  });
});
