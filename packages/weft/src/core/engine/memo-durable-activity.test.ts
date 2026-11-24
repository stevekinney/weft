import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { createDeferred, waitForCondition, waitForever } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { throwingRejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { KEYS } from '../../storage/keys.ts';
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
    expect(await throwingRejectionOf(durableActivity('executeTool', { tool: 'outside' }))).toThrow(
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

    expect(await recoveredHandle!.result()).toEqual({
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

    expect(await recoveredHandle!.result()).toEqual({
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

    expect(await handle.result()).toEqual({
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

    expect(await recoveredHandle!.result()).toEqual({ attempts: 2 });
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

    expect(await handle.result()).toEqual({ echoed: 'typed-input' });
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

    expect(await handle.result()).toEqual({ calls: 1 });
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

    expect(await handle.result()).toEqual({ calls: 1 });
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

    expect(await throwingRejectionOf(handle.result())).toThrow(
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

    expect(await throwingRejectionOf(handle.result())).toThrow(
      'ActivityContext.completeAsync() is not supported from durableActivity()',
    );
  });

  it('calls the memo function directly when the workflow has no inline context', async () => {
    const internals = { inlineStrategy: null } as unknown as EngineInternals;

    expect(
      await callMemoFunctionWithDurableActivityScope(
        internals,
        'no-inline-context-1',
        { fn: () => 'direct', key: 'step-0', operationId: 'memo-direct', step: 0, type: 'memo' },
        { persistCheckpoint: async () => {} },
      ),
    ).toBe('direct');
  });

  it('rejects a second helper activity started before the first one settles', async () => {
    const slowTool = activity({ name: 'sequentialTool', execute: async () => 'first-result' });
    let secondMessage = '';
    const definition = workflow({ name: 'overlapping-helpers' })
      .activities({ sequentialTool: slowTool })
      .execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.memo('step-0', async () => {
          const first = durableActivity('sequentialTool', 'one', { idempotencyKey: 'first' });
          const second = await durableActivity('sequentialTool', 'two', {
            idempotencyKey: 'second',
          }).catch((error: unknown) => error as Error);
          secondMessage = (second as Error).message;
          return await first;
        });
      });

    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(definition);
    const handle = await engine.start('overlapping-helpers', null, { id: 'overlapping-helpers-1' });

    expect(await handle.result()).toBe('first-result');
    expect(secondMessage).toContain('must be awaited sequentially');
  });

  it('rejects a helper activity started after the memo scope has closed', async () => {
    const tool = activity({ name: 'lateTool', execute: async () => 'late' });
    const late = createDeferred<Error>();
    const definition = workflow({ name: 'late-helper' })
      .activities({ lateTool: tool })
      .execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.memo('step-0', async () => {
          setTimeout(() => {
            durableActivity('lateTool', 'x', { idempotencyKey: 'late' })
              .then(() => late.resolve(new Error('the late helper unexpectedly ran')))
              .catch((error: unknown) => late.resolve(error as Error));
          }, 0);
          return 'memo-done';
        });
      });

    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(definition);
    const handle = await engine.start('late-helper', null, { id: 'late-helper-1' });

    expect(await handle.result()).toBe('memo-done');
    const lateError = await late.promise;
    expect(lateError.message).toBe('durableActivity() scope closed before completion.');
  });

  it('defers closing the scope until an in-flight reconciliation commit finishes', async () => {
    const tool = activity({ name: 'gatedTool', execute: async () => 'gated-result' });
    let completedCommitApplied = false;
    let commitReleased = false;
    const commitStarted = createDeferred();
    const releaseCommit = createDeferred();
    class GatedReconciliationStorage extends MemoryStorage {
      override async conditionalBatch(
        ...args: Parameters<MemoryStorage['conditionalBatch']>
      ): Promise<boolean> {
        const [, operations] = args;
        const isCompletedRecord = operations.some(
          (operation) =>
            operation.type === 'put' &&
            operation.key.startsWith('actrec:v1:') &&
            (decode(operation.value) as { status?: string }).status === 'completed',
        );
        if (isCompletedRecord) {
          commitStarted.resolve();
          await releaseCommit.promise;
        }
        const applied = await super.conditionalBatch(...args);
        if (isCompletedRecord) completedCommitApplied = applied;
        return applied;
      }
    }
    const definition = workflow({ name: 'deferred-close' })
      .activities({ gatedTool: tool })
      .execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.memo('step-0', async () => {
          void durableActivity('gatedTool', 'x', { idempotencyKey: 'deferred-close' });
          await commitStarted.promise;
          setTimeout(() => {
            commitReleased = true;
            releaseCommit.resolve();
          }, 10);
          return 'memo-returned';
        });
      });

    const storage = new GatedReconciliationStorage();
    await using engine = new Engine({ storage });
    engine.register(definition);
    const handle = await engine.start('deferred-close', null, { id: 'deferred-close-1' });

    expect(await throwingRejectionOf(handle.result())).toThrow(
      'durableActivity() calls started inside ctx.memo() must be awaited',
    );
    // The memo failed only after the held commit was released and applied: the scope waited for
    // the write instead of closing at once (an immediate close settles the memo before the
    // release timer fires). Terminal cleanup then removes the record, so the commit is observed
    // as it lands.
    expect(commitReleased).toBe(true);
    expect(completedCommitApplied).toBe(true);
  });

  it('closes a pending helper activity with a generic reason when the memo throws a non-Error', async () => {
    const waiting = activity({
      name: 'waitingTool',
      execute: async (_input: string, context?: ActivityContext) => {
        await new Promise<void>((resolve) =>
          context?.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return 'aborted';
      },
    });
    const pendingFailure = createDeferred<Error>();
    const definition = workflow({ name: 'non-error-throw-pending' })
      .activities({ waitingTool: waiting })
      .execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.memo('step-0', async () => {
          durableActivity('waitingTool', 'x', { idempotencyKey: 'non-error-throw' })
            .then(() => pendingFailure.resolve(new Error('the helper unexpectedly completed')))
            .catch((error: unknown) => pendingFailure.resolve(error as Error));
          await Promise.resolve();
          throw { code: 'E_OBJECT' };
        });
      });

    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(definition);
    const handle = await engine.start('non-error-throw-pending', null, {
      id: 'non-error-throw-pending-1',
    });
    handle.result().catch(() => {});

    const pendingError = await pendingFailure.promise;
    expect(pendingError.message).toBe('durableActivity() scope closed before completion.');
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

    expect(
      await callMemoFunctionWithDurableActivityScope(
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
    ).toBe('memo-result');
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

      expect(
        await throwingRejectionOf(
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
        ),
      ).toThrow(expectedMessage);
    },
  );
});
