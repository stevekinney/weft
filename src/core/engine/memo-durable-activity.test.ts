import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition, waitForever } from '../../testing/fake-timers.test-support.ts';
import { decode } from '../codec.ts';
import { durableActivity } from '../context/durable-activity.ts';
import type { Context } from '../context/index.ts';
import type { ActivityContext, WorkflowContext } from '../types.ts';
import { activity, workflow } from '../types.ts';
import type { ActivityReconciliationRecord } from './activity-reconciliation.ts';
import { Engine } from './index.ts';
import type { EngineInternals } from './internals.ts';
import { callMemoFunctionWithDurableActivityScope } from './memo-durable-activity.ts';

type ToolInput = {
  tool: string;
  toolKey?: string;
};

async function readActivityReconciliationRecords(
  storage: MemoryStorage,
  workflowId: string,
): Promise<ActivityReconciliationRecord[]> {
  const records: ActivityReconciliationRecord[] = [];
  for await (const [, value] of storage.scan(KEYS.activityReconciliationPrefix(workflowId))) {
    records.push(decode(value) as ActivityReconciliationRecord);
  }
  return records;
}

function hasCompletedActivityRecord(records: ActivityReconciliationRecord[]): boolean {
  return records.some((record) => record.status === 'completed');
}

async function hasHelperRetrySleepTimer(storage: MemoryStorage): Promise<boolean> {
  for await (const [key] of storage.scan('timer-idx:sleep:memo:')) {
    if (key.includes(':retry-sleep:2')) {
      return true;
    }
  }
  return false;
}

async function yieldTurns(count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    await Promise.resolve();
  }
}

type PendingHelperScenario = 'dispose' | 'cancel';

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function createDeferred(): Deferred {
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

type PendingHelperSetup = {
  storage: MemoryStorage;
  engine: Engine;
  handle: Awaited<ReturnType<Engine['start']>>;
  activityStarted: Promise<void>;
  activityAbortObserved: Promise<void>;
};

async function setupPendingHelper(scenario: PendingHelperScenario): Promise<PendingHelperSetup> {
  const storage = new MemoryStorage();
  const activityStarted = createDeferred();
  const activityAbortObserved = createDeferred();
  const slowTool = activity({
    name: 'slowTool',
    execute: async (_input: string, context?: ActivityContext) => {
      activityStarted.resolve();
      await new Promise<void>((resolve) => {
        context?.signal.addEventListener(
          'abort',
          () => {
            activityAbortObserved.resolve();
            resolve();
          },
          { once: true },
        );
      });
      return 'late-result';
    },
  });

  const definition = workflow({ name: `${scenario}-pending-helper` })
    .activities({ slowTool })
    .execute(async function* (ctx: WorkflowContext) {
      return yield* ctx.memo('step-0', async () => {
        return durableActivity('slowTool', 'payload', { idempotencyKey: `${scenario}-pending` });
      });
    });

  const engine = new Engine({ storage });
  engine.register(definition);
  const handle = await engine.start(`${scenario}-pending-helper`, null, {
    id: `${scenario}-pending-helper-1`,
  });

  await activityStarted.promise;
  return {
    storage,
    engine,
    handle,
    activityStarted: activityStarted.promise,
    activityAbortObserved: activityAbortObserved.promise,
  };
}

describe('ctx.memo durableActivity helper', () => {
  it('throws a targeted error outside a workflow activation', async () => {
    await expect(durableActivity('executeTool', { tool: 'outside' })).rejects.toThrow(
      'durableActivity() can only be called from a ctx.memo() callback',
    );
  });

  it('recovers a completed keyed helper activity without redispatching', async () => {
    const storage = new MemoryStorage();
    let executeCount = 0;
    let pauseAfterFirstActivity = true;

    const executeTool = activity({
      name: 'executeTool',
      execute: async (tool: string) => {
        executeCount++;
        return { execution: executeCount, tool };
      },
    });

    async function sharedStep(input: ToolInput): Promise<{ toolResult: unknown }> {
      const options = input.toolKey === undefined ? undefined : { idempotencyKey: input.toolKey };
      const toolResult = await durableActivity('executeTool', input.tool, options);
      if (pauseAfterFirstActivity) {
        await waitForever();
      }
      return { toolResult };
    }

    const definition = workflow({ name: 'agent-like-keyed' })
      .activities({ executeTool })
      .execute(async function* (ctx: WorkflowContext, input: ToolInput) {
        return yield* ctx.memo('step-0', async () => sharedStep(input));
      });

    const firstEngine = new Engine({ storage });
    firstEngine.register(definition);
    await firstEngine.start(
      'agent-like-keyed',
      { tool: 'lookup', toolKey: 'tool:lookup' },
      { id: 'agent-like-keyed-1' },
    );

    await waitForCondition(
      async () => {
        const records = await readActivityReconciliationRecords(storage, 'agent-like-keyed-1');
        return executeCount === 1 && hasCompletedActivityRecord(records);
      },
      { label: 'keyed durableActivity completion record' },
    );
    const [completedRecord] = await readActivityReconciliationRecords(
      storage,
      'agent-like-keyed-1',
    );
    expect(completedRecord).toMatchObject({
      operationId: expect.stringMatching(/^memo:0:[0-9a-f]{16}:call:0:activity:1$/),
      status: 'completed',
    });

    firstEngine[Symbol.dispose]();
    pauseAfterFirstActivity = false;

    await using recoveredEngine = new Engine({ storage });
    recoveredEngine.register(definition);
    const [recoveredHandle] = await recoveredEngine.recoverAll();

    await expect(recoveredHandle!.result()).resolves.toEqual({
      toolResult: { execution: 1, tool: 'lookup' },
    });
    expect(executeCount).toBe(1);
  });

  it('keeps unkeyed helper activities at least once across the memo crash window', async () => {
    const storage = new MemoryStorage();
    let executeCount = 0;
    let pauseAfterFirstActivity = true;

    const executeTool = activity({
      name: 'executeTool',
      execute: async (tool: string) => {
        executeCount++;
        return { execution: executeCount, tool };
      },
    });

    async function sharedStep(input: ToolInput): Promise<{ toolResult: unknown }> {
      const toolResult = await durableActivity('executeTool', input.tool);
      if (pauseAfterFirstActivity) {
        await waitForever();
      }
      return { toolResult };
    }

    const definition = workflow({ name: 'agent-like-unkeyed' })
      .activities({ executeTool })
      .execute(async function* (ctx: WorkflowContext, input: ToolInput) {
        return yield* ctx.memo('step-0', async () => sharedStep(input));
      });

    const firstEngine = new Engine({ storage });
    firstEngine.register(definition);
    await firstEngine.start(
      'agent-like-unkeyed',
      { tool: 'lookup' },
      { id: 'agent-like-unkeyed-1' },
    );

    await waitForCondition(() => executeCount === 1, {
      label: 'first unkeyed durableActivity dispatch',
    });
    expect(await readActivityReconciliationRecords(storage, 'agent-like-unkeyed-1')).toHaveLength(
      0,
    );

    firstEngine[Symbol.dispose]();
    pauseAfterFirstActivity = false;

    await using recoveredEngine = new Engine({ storage });
    recoveredEngine.register(definition);
    const [recoveredHandle] = await recoveredEngine.recoverAll();

    await expect(recoveredHandle!.result()).resolves.toEqual({
      toolResult: { execution: 2, tool: 'lookup' },
    });
    expect(executeCount).toBe(2);
  });

  it('retries helper activities without consuming outer workflow steps', async () => {
    const storage = new MemoryStorage();
    let attempts = 0;

    const flakyTool = activity({
      name: 'flakyTool',
      retry: { maxAttempts: 2, initialBackoff: 0, backoffMultiplier: 1, maxBackoff: 0 },
      execute: async (tool: string) => {
        attempts++;
        if (attempts === 1) {
          throw new Error('transient helper failure');
        }
        return { attempts, tool };
      },
      verify: (_result, context) =>
        context?.phase === 'pre-dispatch-reconciliation' ? 'not-completed' : true,
    });

    const afterMemo = activity({
      name: 'afterMemo',
      execute: async () => 'after-memo',
    });

    const definition = workflow({ name: 'helper-retry' })
      .activities({ flakyTool, afterMemo })
      .execute(async function* (ctx: WorkflowContext) {
        const concreteContext = ctx as Context;
        const toolResult = yield* ctx.memo('step-0', async () =>
          durableActivity(flakyTool, 'lookup', { idempotencyKey: 'retry:lookup' }),
        );
        const afterResult = yield* ctx.run(afterMemo);
        return { afterResult, stepIndex: concreteContext.stepIndex, toolResult };
      });

    await using engine = new Engine({ storage });
    engine.register(definition);
    const handle = await engine.start('helper-retry', null, { id: 'helper-retry-1' });

    await expect(handle.result()).resolves.toEqual({
      afterResult: 'after-memo',
      stepIndex: 2,
      toolResult: { attempts: 2, tool: 'lookup' },
    });
    expect(attempts).toBe(2);

    const records = await readActivityReconciliationRecords(storage, 'helper-retry-1');
    const completedRecords = records.filter((record) => record.status === 'completed');
    expect(completedRecords).toHaveLength(1);
    expect(completedRecords[0]).toMatchObject({
      attempt: 2,
      operationId: expect.stringMatching(/^memo:0:[0-9a-f]{16}:call:0:activity:1$/),
      status: 'completed',
    });

    const timeline = await engine.getTimeline('helper-retry-1');
    expect(
      timeline.map((entry) => ({
        operationLabel: entry.operationLabel,
        operationType: entry.operationType,
        status: entry.status,
      })),
    ).toEqual([
      { operationLabel: 'step-0', operationType: 'memo', status: 'completed' },
      { operationLabel: 'afterMemo', operationType: 'activity', status: 'completed' },
    ]);
  });

  it('persists helper retry state before parking on retry backoff', async () => {
    const storage = new MemoryStorage();
    let now = 0;
    let attempts = 0;

    const flakyTool = activity({
      name: 'flakyTool',
      retry: { maxAttempts: 2, initialBackoff: 1_000, backoffMultiplier: 1, maxBackoff: 1_000 },
      execute: async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error('transient helper failure');
        }
        return { attempts };
      },
      verify: (_result, context) =>
        context?.phase === 'pre-dispatch-reconciliation' ? 'not-completed' : true,
    });

    const definition = workflow({ name: 'helper-retry-recovery' })
      .activities({ flakyTool })
      .execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.memo('step-0', async () =>
          durableActivity(flakyTool, { idempotencyKey: 'retry:recovery' }),
        );
      });

    const firstEngine = new Engine({ storage, getNow: () => now });
    firstEngine.register(definition);
    await firstEngine.start('helper-retry-recovery', null, { id: 'helper-retry-recovery-1' });

    await waitForCondition(() => attempts === 1 && hasHelperRetrySleepTimer(storage), {
      label: 'helper retry sleep checkpointed',
    });
    firstEngine[Symbol.dispose]();

    now = 500;
    const recoveredEngine = new Engine({ storage, getNow: () => now });
    recoveredEngine.register(definition);
    const [recoveredHandle] = await recoveredEngine.recoverAll();
    await yieldTurns(6);
    expect(attempts).toBe(1);

    now = 1_000;
    await recoveredEngine.scheduler.tick(now);

    await expect(recoveredHandle!.result()).resolves.toEqual({ attempts: 2 });
    expect(attempts).toBe(2);
    recoveredEngine[Symbol.dispose]();
  });

  it('passes input and options for activity() callables from a helper', async () => {
    const storage = new MemoryStorage();

    const typedTool = activity({
      name: 'typedTool',
      execute: async (input: { value: string }) => ({ echoed: input.value }),
    });

    const definition = workflow({ name: 'typed-helper-callable' })
      .activities({ typedTool })
      .execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.memo('step-0', async () =>
          durableActivity(typedTool, { value: 'typed-input' }, { idempotencyKey: 'typed:key' }),
        );
      });

    await using engine = new Engine({ storage });
    engine.register(definition);
    const handle = await engine.start('typed-helper-callable', null, {
      id: 'typed-helper-callable-1',
    });

    await expect(handle.result()).resolves.toEqual({ echoed: 'typed-input' });
    expect(
      hasCompletedActivityRecord(await readActivityReconciliationRecords(storage, handle.id)),
    ).toBe(true);
  });

  it('treats options as options for no-input activity() callables', async () => {
    const storage = new MemoryStorage();
    let calls = 0;

    const noInputTool = activity({
      name: 'noInputTool',
      execute: async () => {
        calls++;
        return { calls };
      },
    });

    const definition = workflow({ name: 'no-input-helper-callable' })
      .activities({ noInputTool })
      .execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.memo('step-0', async () =>
          durableActivity(noInputTool, { idempotencyKey: 'no-input:key' }),
        );
      });

    await using engine = new Engine({ storage });
    engine.register(definition);
    const handle = await engine.start('no-input-helper-callable', null, {
      id: 'no-input-helper-callable-1',
    });

    await expect(handle.result()).resolves.toEqual({ calls: 1 });
    const [record] = await readActivityReconciliationRecords(storage, handle.id);
    expect(record).toMatchObject({
      activityName: 'noInputTool',
      status: 'completed',
    });
    expect(calls).toBe(1);
  });

  it('treats options as options for no-input bare function helpers', async () => {
    const storage = new MemoryStorage();
    let calls = 0;

    async function noInputBareTool(): Promise<{ calls: number }> {
      calls++;
      return { calls };
    }

    const definition = workflow({ name: 'no-input-bare-helper' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.memo('step-0', async () =>
        durableActivity(noInputBareTool, { idempotencyKey: 'no-input:bare' }),
      );
    });

    await using engine = new Engine({ storage });
    engine.register(definition);
    const handle = await engine.start('no-input-bare-helper', null, {
      id: 'no-input-bare-helper-1',
    });

    await expect(handle.result()).resolves.toEqual({ calls: 1 });
    const [record] = await readActivityReconciliationRecords(storage, handle.id);
    expect(record).toMatchObject({
      activityName: 'noInputBareTool',
      status: 'completed',
    });
    expect(calls).toBe(1);
  });

  it('fails the memo when a helper activity promise is still pending on return', async () => {
    const storage = new MemoryStorage();

    const slowTool = activity({
      name: 'slowTool',
      execute: async () => 'late-result',
    });

    const definition = workflow({ name: 'pending-on-return' })
      .activities({ slowTool })
      .execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.memo('step-0', () => {
          void durableActivity('slowTool', 'payload', { idempotencyKey: 'pending-on-return' });
          return 'memo-returned';
        });
      });

    await using engine = new Engine({ storage });
    engine.register(definition);
    const handle = await engine.start('pending-on-return', null, { id: 'pending-on-return-1' });

    await expect(handle.result()).rejects.toThrow(
      'durableActivity() calls started inside ctx.memo() must be awaited',
    );
    const records = await readActivityReconciliationRecords(storage, 'pending-on-return-1');
    expect(hasCompletedActivityRecord(records)).toBe(false);
  });

  it('does not commit a keyed helper result after engine disposal aborts a pending activity', async () => {
    const { storage, engine, activityAbortObserved } = await setupPendingHelper('dispose');

    engine[Symbol.dispose]();
    await activityAbortObserved;

    const records = await readActivityReconciliationRecords(storage, 'dispose-pending-helper-1');
    expect(hasCompletedActivityRecord(records)).toBe(false);
  });

  it('does not commit a keyed helper result after workflow cancellation aborts a pending activity', async () => {
    const setup = await setupPendingHelper('cancel');
    await using engine = setup.engine;

    await engine.cancel(setup.handle.id);
    await setup.activityAbortObserved;

    const records = await readActivityReconciliationRecords(
      setup.storage,
      'cancel-pending-helper-1',
    );
    expect(hasCompletedActivityRecord(records)).toBe(false);
  });

  it('rejects completeAsync from helper-launched activities', async () => {
    const completeLater = activity({
      name: 'completeLater',
      execute: (_input: string, context?: ActivityContext) => {
        context?.completeAsync();
        return 'unreachable';
      },
    });

    const definition = workflow({ name: 'helper-complete-async' })
      .activities({ completeLater })
      .execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.memo('step-0', async () => {
          return durableActivity('completeLater', 'payload', { idempotencyKey: 'complete-async' });
        });
      });

    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(definition);
    const handle = await engine.start('helper-complete-async', null, {
      id: 'helper-complete-async-1',
    });

    await expect(handle.result()).rejects.toThrow(
      'ActivityContext.completeAsync() is not supported from durableActivity()',
    );
  });

  it('removes memo-scope abort listeners when a later forwarded signal is already aborted', async () => {
    const contextAbortController = new AbortController();
    const engineAbortController = new AbortController();
    engineAbortController.abort();
    let addAbortListenerCount = 0;
    let removeAbortListenerCount = 0;
    const signal = contextAbortController.signal;
    const addEventListener = signal.addEventListener.bind(signal);
    const removeEventListener = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (type === 'abort') {
        addAbortListenerCount++;
      }
      return addEventListener(type, listener, options);
    }) as AbortSignal['addEventListener'];
    signal.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      if (type === 'abort') {
        removeAbortListenerCount++;
      }
      return removeEventListener(type, listener, options);
    }) as AbortSignal['removeEventListener'];

    const context = {
      signal,
      workflowType: 'listener-cleanup',
    } as Context;
    const internals = {
      abortController: engineAbortController,
      inlineStrategy: { getContext: () => context },
      workflowTypeByWorkflowId: new Map<string, string>(),
    } as unknown as EngineInternals;

    await expect(
      callMemoFunctionWithDurableActivityScope(
        internals,
        'listener-cleanup-1',
        {
          fn: () => 'memo-result',
          key: 'step-0',
          operationId: 'memo-listener-cleanup',
          step: 0,
          type: 'memo',
        },
        {
          getActivityOperationCallbacks: () => ({}) as never,
          persistCheckpoint: async () => {},
        },
      ),
    ).resolves.toBe('memo-result');
    expect(addAbortListenerCount).toBe(1);
    expect(removeAbortListenerCount).toBe(1);
  });

  it.each([
    ['plain string failure', 'plain string failure'],
    [7, '7'],
    [true, 'true'],
  ])(
    'formats non-Error memo failures into DurableActivityScopeError messages (%p)',
    async (thrownValue, expectedMessage) => {
      const context = {
        signal: new AbortController().signal,
        workflowType: 'non-error-memo-failure',
      } as Context;
      const internals = {
        abortController: new AbortController(),
        inlineStrategy: { getContext: () => context },
        workflowTypeByWorkflowId: new Map<string, string>(),
      } as unknown as EngineInternals;

      await expect(
        callMemoFunctionWithDurableActivityScope(
          internals,
          'non-error-memo-failure-1',
          {
            fn: () => {
              throw thrownValue;
            },
            key: 'step-0',
            operationId: 'memo-non-error-failure',
            step: 0,
            type: 'memo',
          },
          {
            getActivityOperationCallbacks: () => ({}) as never,
            persistCheckpoint: async () => {},
          },
        ),
      ).rejects.toThrow(expectedMessage);
    },
  );
});
