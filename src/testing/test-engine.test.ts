import { afterEach, describe, expect, it } from 'bun:test';
import { restoreRealTimers, sleepForTesting, useFakeTimers } from './fake-timers.test-support.ts';

import type { WorkflowContext } from '../core/types.ts';
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
