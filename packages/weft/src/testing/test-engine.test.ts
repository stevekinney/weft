import { afterEach, describe, expect, it } from 'bun:test';
import { restoreRealTimers, sleepForTesting, useFakeTimers } from './fake-timers.test-support.ts';

import { activity, type WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types/workflow-function.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { TestEngine } from './test-engine.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function flush(): Promise<void> {
  await sleepForTesting(10);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  restoreRealTimers();
});

describe('TestEngine', () => {
  it('creates with MemoryStorage', () => {
    const engine = new TestEngine();
    expect(engine.storage).toBeInstanceOf(MemoryStorage);
    engine[Symbol.dispose]();
  });

  it('advanceTime fires sleeping workflows', async () => {
    const engine = new TestEngine({ startTime: 0 });

    const sleeper = workflow({ name: 'sleeper' }).execute(async function* (ctx: WorkflowContext) {
      yield* ctx.sleep(5000);
      return 'awake';
    });
    engine.register(sleeper);

    const handle = await engine.start('sleeper', null);
    await flush();

    // Not yet completed
    const beforeList = await engine.list({ status: 'completed' });
    expect(beforeList.total).toBe(0);

    // Advance past the sleep
    await engine.advanceTime(6000);
    await flush();

    const result = await handle.result();
    expect(result).toBe('awake');
    engine[Symbol.dispose]();
  });

  it('advanceTime settles when Bun fake timers are enabled', async () => {
    useFakeTimers();
    const engine = new TestEngine({ startTime: 0 });

    await engine.advanceTime(1);

    expect(engine.now).toBe(1);
    engine[Symbol.dispose]();
  });

  it('mock replaces activity in workflow', async () => {
    const engine = new TestEngine();

    const fetchUser = async (_id: unknown) => {
      // In production this would call a real API
      throw new Error('Should not be called in test');
    };

    const mockHandle = engine.mock(fetchUser, async (_id: unknown) => ({
      id: _id as string,
      name: 'Mock User',
    }));

    // The engine doesn't know about mocks natively yet -- we need to
    // integrate the mock into the workflow. For now, mock the activity
    // function directly and use it in the workflow.
    const userWorkflow = workflow({ name: 'user-workflow' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      // Use the mock-aware version: check if mocked
      const mockedActivity = engine.mocks.get(fetchUser);
      const fn = mockedActivity ? mockedActivity.implementation : fetchUser;
      const user = yield* ctx.run(fn, input);
      return user;
    });
    engine.register(userWorkflow);

    const handle = await engine.start('user-workflow', 'user-123');
    const result = await handle.result();

    expect(result).toEqual({ id: 'user-123', name: 'Mock User' });
    expect(mockHandle.callCount).toBe(1);
    engine[Symbol.dispose]();
  });

  it('mock restore preserves the previous activity registration', async () => {
    const engine = new TestEngine();

    const fetchAccount = activity({
      name: 'fetchAccount',
      queue: 'accounts',
      timeout: '5s',
      execute: async (input: unknown) => `real:${String(input)}`,
    });
    const accountWorkflow = workflow({ name: 'account-workflow' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      return yield* ctx.run(fetchAccount, input);
    });

    engine.register(fetchAccount);
    engine.register(accountWorkflow);

    const mockHandle = engine.mock(fetchAccount, async (input: unknown) => `mock:${String(input)}`);
    const mockedHandle = await engine.start('account-workflow', 'first', {
      id: 'account-workflow-mocked',
    });
    expect(await mockedHandle.result()).toBe('mock:first');

    mockHandle.restore();
    expect(engine.getActivityDefinition('fetchAccount')).toMatchObject({
      name: 'fetchAccount',
      queue: 'accounts',
      timeout: '5s',
    });

    const restoredHandle = await engine.start('account-workflow', 'second', {
      id: 'account-workflow-restored',
    });
    expect(await restoredHandle.result()).toBe('real:second');
    expect(mockHandle.callCount).toBe(1);

    engine[Symbol.dispose]();
  });

  it('mock restore unregisters temporary activity registrations', () => {
    const engine = new TestEngine();

    async function temporaryActivity(input: unknown) {
      return `real:${String(input)}`;
    }

    expect(engine.getActivityDefinition('temporaryActivity')).toBeUndefined();
    const mockHandle = engine.mock(
      temporaryActivity,
      async (input: unknown) => `mock:${String(input)}`,
    );
    expect(engine.getActivityDefinition('temporaryActivity')).toMatchObject({
      name: 'temporaryActivity',
    });

    mockHandle.restore();

    expect(engine.getActivityDefinition('temporaryActivity')).toBeUndefined();

    engine[Symbol.dispose]();
  });

  it('mocks.restoreAll restores the original activity registration', () => {
    const engine = new TestEngine();

    const fetchAccount = activity({
      name: 'fetchAccount',
      queue: 'accounts',
      timeout: '5s',
      execute: async (input: unknown) => `real:${String(input)}`,
    });
    engine.register(fetchAccount);

    engine.mock(fetchAccount, async (input: unknown) => `mock:${String(input)}`);

    engine.mocks.restoreAll();

    // restoreAll must put back the original metadata, not leave the surrogate
    // definition with default queue/timeout/retry settings.
    expect(engine.getActivityDefinition('fetchAccount')).toMatchObject({
      name: 'fetchAccount',
      queue: 'accounts',
      timeout: '5s',
    });

    engine[Symbol.dispose]();
  });

  it('mocks.restoreAll unregisters temporary mock activities', () => {
    const engine = new TestEngine();

    async function temporaryActivity(input: unknown) {
      return `real:${String(input)}`;
    }

    engine.mock(temporaryActivity, async (input: unknown) => `mock:${String(input)}`);
    expect(engine.getActivityDefinition('temporaryActivity')).toMatchObject({
      name: 'temporaryActivity',
    });

    engine.mocks.restoreAll();

    expect(engine.getActivityDefinition('temporaryActivity')).toBeUndefined();

    engine[Symbol.dispose]();
  });

  it('re-mocking an activity preserves the original registration on restore', async () => {
    const engine = new TestEngine();

    const fetchAccount = activity({
      name: 'fetchAccount',
      queue: 'accounts',
      timeout: '5s',
      execute: async (input: unknown) => `real:${String(input)}`,
    });
    const accountWorkflow = workflow({ name: 'account-workflow' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      return yield* ctx.run(fetchAccount, input);
    });
    engine.register(fetchAccount);
    engine.register(accountWorkflow);

    // Mock twice without an intervening restore. The second mock must not
    // overwrite the original-registration snapshot captured by the first.
    const firstHandle = engine.mock(
      fetchAccount,
      async (input: unknown) => `mock-a:${String(input)}`,
    );
    engine.mock(fetchAccount, async (input: unknown) => `mock-b:${String(input)}`);

    const mockedHandle = await engine.start('account-workflow', 'first', {
      id: 'account-workflow-double-mocked',
    });
    expect(await mockedHandle.result()).toBe('mock-b:first');

    // Restoring via the first handle must reinstate the *original* registration
    // with its real metadata, not a surrogate with default queue/timeout.
    firstHandle.restore();
    expect(engine.getActivityDefinition('fetchAccount')).toMatchObject({
      name: 'fetchAccount',
      queue: 'accounts',
      timeout: '5s',
    });

    const restoredHandle = await engine.start('account-workflow', 'second', {
      id: 'account-workflow-double-restored',
    });
    expect(await restoredHandle.result()).toBe('real:second');

    engine[Symbol.dispose]();
  });

  it('recover creates new engine with same storage', async () => {
    const engine = new TestEngine({ startTime: 1000 });

    const persistent = workflow({ name: 'persistent' }).execute(async function* () {
      return 'persisted-result';
    });
    engine.register(persistent);

    const handle = await engine.start('persistent', null, { id: 'recover-test' });
    await handle.result();

    const recovered = engine.recover();
    const list = await recovered.list();

    expect(list.total).toBe(1);
    expect(list.items[0]!.id).toBe('recover-test');
    expect(list.items[0]!.status).toBe('completed');

    engine[Symbol.dispose]();
    recovered[Symbol.dispose]();
  });

  it('recover preserves completed workflow results', async () => {
    const engine = new TestEngine({ startTime: 1000 });

    let activityCallCount = 0;
    const expensiveComputation = async (input: unknown) => {
      activityCallCount++;
      return (input as number) * 100;
    };

    const recoverable = workflow({ name: 'recoverable' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      const result = yield* ctx.run(expensiveComputation, input);
      return result;
    });
    engine.register(recoverable);

    const handle = await engine.start('recoverable', 5, { id: 'recovery-wf' });
    const result = await handle.result();
    expect(result).toBe(500);
    expect(activityCallCount).toBe(1);

    // Recover and verify the state persisted
    const recovered = engine.recover();
    const list = await recovered.list();
    expect(list.items[0]!.status).toBe('completed');

    engine[Symbol.dispose]();
    recovered[Symbol.dispose]();
  });

  it('now returns current virtual time', () => {
    const engine = new TestEngine({ startTime: 42_000 });
    expect(engine.now).toBe(42_000);
    engine[Symbol.dispose]();
  });
});
