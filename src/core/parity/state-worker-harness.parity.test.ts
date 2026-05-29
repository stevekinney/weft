import { afterEach, describe, expect, it } from 'bun:test';

import { decode } from '../../core/codec.ts';
import { Engine } from '../../core/engine.ts';
import { setActivityWorkerDispatcherForTesting } from '../../core/engine/activity-worker-dispatcher.test-support.ts';
import { serve, type WeftServer } from '../../server/index.ts';
import type { ResolvedRecord } from '../../server/task-state.ts';
import { KEYS } from '../../storage/interface.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { TestEngine } from '../../testing/test-engine.ts';
import { RemoteWorker } from '../../worker/index.ts';
import type {
  ActivityExecutionRequest,
  ActivityExecutionResult,
} from '../../workers/activity-runner.ts';
import type { ActivityWorkerDispatcher } from '../../workers/activity-worker-dispatcher.ts';
import type { QueryDefinition, WorkflowContext } from '../types.ts';
import { activity, query, workflow } from '../types.ts';

async function waitForQuery<T>(
  handle: { query(definition: QueryDefinition<void, T>): Promise<T> },
  definition: QueryDefinition<void, T>,
  predicate: (result: T) => boolean = (result) => result !== undefined,
): Promise<T> {
  let latestResult: T | undefined;
  await waitForCondition(
    async () => {
      latestResult = await handle.query(definition);
      return latestResult !== undefined && predicate(latestResult);
    },
    {
      timeoutMs: 5_000,
      intervalMs: 25,
      label: `query "${definition.name}" to match the requested state`,
    },
  );

  if (latestResult === undefined) {
    throw new Error(`Expected query "${definition.name}" to match the requested state`);
  }

  return latestResult;
}

async function readResolvedRecord(engine: Engine, operationId: string): Promise<ResolvedRecord> {
  await waitForCondition(
    async () => (await engine.storage.get(KEYS.operationResolved(operationId))) !== null,
    {
      timeoutMs: 5_000,
      intervalMs: 25,
      label: `operation "${operationId}" to resolve`,
    },
  );

  const value = await engine.storage.get(KEYS.operationResolved(operationId));
  if (value === null) {
    throw new Error(`Operation "${operationId}" did not write a resolved record`);
  }

  return decode(value) as ResolvedRecord;
}

function installRemoteWorkerDispatcher(engine: Engine, server: WeftServer): void {
  const dispatcher = {
    async execute(request: ActivityExecutionRequest): Promise<ActivityExecutionResult> {
      const dispatched = await server.dispatchTask({
        operationId: request.operationId,
        activityName: request.activityName,
        input: request.input,
        workflowId: 'parity-remote-workflow-id',
      });
      if (!dispatched) {
        return {
          operationId: request.operationId,
          status: 'failed',
          error: `RemoteWorker did not accept activity "${request.activityName}"`,
        };
      }

      const resolved = await readResolvedRecord(engine, request.operationId);
      if (resolved.status === 'failed') {
        return {
          operationId: request.operationId,
          status: 'failed',
          error: resolved.error ?? `RemoteWorker failed activity "${request.activityName}"`,
        };
      }

      return {
        operationId: request.operationId,
        status: 'completed',
        value: resolved.value,
      };
    },
    [Symbol.dispose]() {},
  };

  setActivityWorkerDispatcherForTesting(engine, dispatcher as unknown as ActivityWorkerDispatcher);
}

describe('durable state, remote worker, and testing-harness parity', () => {
  let testEngine: TestEngine | undefined;
  let engine: Engine | undefined;
  let server: WeftServer | undefined;
  let remoteWorker: RemoteWorker | undefined;

  afterEach(async () => {
    await remoteWorker?.disconnect();
    remoteWorker = undefined;

    await server?.stop();
    server = undefined;

    engine?.[Symbol.dispose]();
    engine = undefined;

    testEngine?.[Symbol.dispose]();
    testEngine = undefined;
  });

  it('keeps long-running workflow state across signals, queries, and recovery', async () => {
    const balanceQuery = query<void, { balance: number }>('balance');
    const accountWorkflow = workflow({ name: 'parity-durable-account' }).execute(async function* (
      context: WorkflowContext,
    ) {
      const balanceState = context.state.workflow<number>('balance', { initial: 0 });
      let balance = yield* balanceState.get();
      context.expose({ balance: () => ({ balance: balance ?? 0 }) });

      const firstDeposit = yield* context.waitForSignal<number>('deposit');
      balance = yield* balanceState.increment(firstDeposit);

      const secondDeposit = yield* context.waitForSignal<number>('deposit');
      balance = yield* balanceState.increment(secondDeposit);

      return balance;
    });

    const firstEngine = new TestEngine({ startTime: 1_000 });
    testEngine = firstEngine;
    firstEngine.register(accountWorkflow);

    const handle = await firstEngine.start('parity-durable-account', null, {
      id: 'parity-durable-account-id',
    });

    expect(await waitForQuery(handle, balanceQuery)).toEqual({ balance: 0 });

    await handle.signal('deposit', 5);
    expect(
      await waitForQuery<{ balance: number }>(
        handle,
        balanceQuery,
        (result) => result.balance === 5,
      ),
    ).toEqual({ balance: 5 });

    const recoveredEngine = firstEngine.recover();
    firstEngine[Symbol.dispose]();
    testEngine = recoveredEngine;
    recoveredEngine.register(accountWorkflow);

    const recoveredHandles = await recoveredEngine.recoverAll();
    expect(recoveredHandles.map((recoveredHandle) => recoveredHandle.id)).toEqual([handle.id]);

    const recoveredHandle = recoveredHandles[0]!;
    expect(
      await waitForQuery<{ balance: number }>(
        recoveredHandle,
        balanceQuery,
        (result) => result.balance === 5,
      ),
    ).toEqual({ balance: 5 });

    await recoveredHandle.signal('deposit', 7);

    await expect(recoveredHandle.result()).resolves.toBe(12);
    await expect(
      recoveredEngine.state.workflow<number>('parity-durable-account', 'balance').get(),
    ).resolves.toBe(12);
  });

  it('round-trips RemoteWorker WebSocket activity results through workflow ctx.run', async () => {
    engine = new Engine();
    server = serve({
      engine,
      port: 0,
      unauthenticatedAccess: 'allow',
      workerReconnectGracePeriodMs: 0,
    });
    installRemoteWorkerDispatcher(engine, server);

    const executedInputs: unknown[] = [];
    remoteWorker = new RemoteWorker({
      serverUrl: `${server.url.replace(/^http/, 'ws')}/v1/tasks/default/stream`,
      workerId: 'parity-remote-worker',
      activities: {
        formatGreeting: async (input: unknown) => {
          executedInputs.push(input);
          return `Hello, ${(input as { name: string }).name}`;
        },
        failGreeting: async () => {
          throw new Error('remote greeting failed');
        },
      },
      concurrency: 1,
    });

    await remoteWorker.connect();
    await waitForCondition(() => server?.registry.getWorker('parity-remote-worker') !== undefined, {
      timeoutMs: 5_000,
      intervalMs: 25,
      label: 'remote worker to register',
    });

    const formatGreeting = activity({
      name: 'formatGreeting',
      execute: async (_input: { name: string }) => 'inline fallback should not run',
    });
    const failGreeting = activity({
      name: 'failGreeting',
      execute: async () => 'inline fallback should not run',
    });
    const remoteGreetingWorkflow = workflow({ name: 'parity-remote-greeting' }).execute(
      async function* (context: WorkflowContext, input: { name: string }) {
        return yield* context.run(formatGreeting, input);
      },
    );
    const remoteFailureWorkflow = workflow({ name: 'parity-remote-failure' }).execute(
      async function* (context: WorkflowContext) {
        return yield* context.run(failGreeting);
      },
    );
    engine.register(remoteGreetingWorkflow);
    engine.register(remoteFailureWorkflow);

    const handle = await engine.start('parity-remote-greeting', { name: 'Ada' });
    await expect(handle.result()).resolves.toBe('Hello, Ada');

    const resolvedOperations = await Array.fromAsync(engine.storage.scan('op:resolved:'));
    const completedOperation = resolvedOperations
      .map(([, value]) => decode(value) as ResolvedRecord)
      .find((record) => record.activityName === 'formatGreeting');
    expect(completedOperation).toMatchObject({
      status: 'completed',
      value: 'Hello, Ada',
      activityName: 'formatGreeting',
      workflowId: 'parity-remote-workflow-id',
      workerId: 'parity-remote-worker',
    });
    expect(executedInputs).toEqual([{ name: 'Ada' }]);

    const failedHandle = await engine.start('parity-remote-failure', null);
    await failedHandle.result().then(
      () => {
        throw new Error('Expected remote failure workflow to reject');
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('remote greeting failed');
      },
    );

    const finalResolvedOperations = await Array.fromAsync(engine.storage.scan('op:resolved:'));
    const failedOperation = finalResolvedOperations
      .map(([, value]) => decode(value) as ResolvedRecord)
      .find((record) => record.activityName === 'failGreeting');
    expect(failedOperation).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('remote greeting failed'),
      activityName: 'failGreeting',
      workflowId: 'parity-remote-workflow-id',
      workerId: 'parity-remote-worker',
    });
    expect(server.registry.getWorker('parity-remote-worker')?.inFlight).toBe(0);
  });

  it('uses TestEngine time skip and activity mocking in one readable workflow test', async () => {
    testEngine = new TestEngine({ startTime: 0 });

    const chargeCard = async (_input: { orderId: string }) => {
      throw new Error('Expected TestEngine mock to replace chargeCard');
    };
    const chargeCardMock = testEngine.mock(chargeCard, async (input: { orderId: string }) => ({
      confirmation: `mocked-charge:${input.orderId}`,
    }));

    const delayedChargeWorkflow = workflow({ name: 'parity-delayed-charge' }).execute(
      async function* (context: WorkflowContext, input: { orderId: string }) {
        yield* context.sleep(60_000);

        return yield* context.run(chargeCard, input);
      },
    );
    testEngine.register(delayedChargeWorkflow);

    const handle = await testEngine.start('parity-delayed-charge', { orderId: 'ord-123' });
    await testEngine.advanceTime(59_999);

    expect(chargeCardMock.callCount).toBe(0);

    await testEngine.advanceTime(1);

    await expect(handle.result()).resolves.toEqual({
      confirmation: 'mocked-charge:ord-123',
    });
    expect(chargeCardMock.callCount).toBe(1);
    expect(chargeCardMock.lastCall?.input).toEqual({ orderId: 'ord-123' });
  });
});
