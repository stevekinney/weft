import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { serve, type WeftServer } from '../../server/index.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { TestEngine } from '../../testing/test-engine.ts';
import { RemoteWorker } from '../../worker/index.ts';
import type { RemoteTaskTerminalResolved } from '../task-ledger/task-ledger-types.ts';
import { decodeRemoteTaskRecord } from '../task-ledger/task-ledger.ts';
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

    expect(recoveredHandle.result()).resolves.toBe(12);
    expect(
      recoveredEngine.state.workflow<number>('parity-durable-account', 'balance').get(),
    ).resolves.toBe(12);
  });

  it('round-trips RemoteWorker WebSocket activity results through workflow ctx.run (COR-152)', async () => {
    // Production wiring only: `activityExecution: { mode: 'remote' }` is the
    // engine-owned broker COR-152 introduced. No test-only dispatcher setter
    // — the historic gap this test used to document (the durable ledger only
    // ever proved WHICH result won via `resultDigest`, never delivered the
    // real value into a workflow continuation) is closed: the bridge in
    // `server/runtime/task-result-application.ts` now carries the worker's
    // actual value/error into `engine.completeAsyncActivity`/`failAsyncActivity`.
    engine = new Engine({ activityExecution: { mode: 'remote' } });
    server = serve({
      engine,
      port: 0,
      unauthenticatedAccess: 'allow',
      workerReconnectGracePeriodMs: 0,
    });

    const executedInputs: unknown[] = [];
    remoteWorker = new RemoteWorker({
      serverUrl: `${server.url.replace(/^http/, 'ws')}/v1/tasks/default/stream`,
      workerId: 'parity-remote-worker',
      deploymentName: 'test-deployment',
      buildId: 'test-build',
      workflows: {
        'parity-remote-success': {
          name: 'parity-remote-success',
          activities: {
            formatGreeting: async (input: unknown) => {
              executedInputs.push(input);
              return `Hello, ${(input as { name: string }).name}`;
            },
          },
        },
        'parity-remote-failure': {
          name: 'parity-remote-failure',
          activities: {
            failGreeting: async () => {
              throw new Error('remote greeting failed');
            },
          },
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
      execute: async (_input: { name: string }): Promise<never> => {
        throw new Error('local execution must never run in remote mode');
      },
    });
    const remoteSuccessWorkflow = workflow({ name: 'parity-remote-success' })
      .activities({ formatGreeting })
      .execute(async function* (context: WorkflowContext, input: { name: string }) {
        return yield* context.run(formatGreeting, input);
      });
    engine.register(remoteSuccessWorkflow);

    const failGreeting = activity({
      name: 'failGreeting',
      execute: async (): Promise<never> => {
        throw new Error('local execution must never run in remote mode');
      },
    });
    const remoteFailureWorkflow = workflow({ name: 'parity-remote-failure' })
      .activities({ failGreeting })
      .execute(async function* (context: WorkflowContext) {
        return yield* context.run(failGreeting);
      });
    engine.register(remoteFailureWorkflow);

    // The real value a RemoteWorker computed reaches ctx.run()'s
    // continuation — not just a durably-provable digest.
    const succeededHandle = await engine.start(
      'parity-remote-success',
      { name: 'Ada' },
      { id: 'parity-remote-success-1' },
    );
    expect(await succeededHandle.result()).toBe('Hello, Ada');
    expect(executedInputs).toEqual([{ name: 'Ada' }]);

    const failedHandle = await engine.start('parity-remote-failure', null, {
      id: 'parity-remote-failure-1',
    });
    await failedHandle.result().then(
      () => {
        throw new Error('Expected remote failure workflow to reject');
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('remote greeting failed');
      },
    );

    const failedOperation = await Array.fromAsync(engine.storage.scan('task-ledger:')).then(
      (entries) =>
        entries
          .map(([, value]) => decodeRemoteTaskRecord(value))
          .find(
            (record): record is RemoteTaskTerminalResolved =>
              record !== null &&
              record.state === 'terminal' &&
              record.disposition === 'resolved' &&
              record.activityName === 'parity-remote-failure.failGreeting',
          ),
    );
    expect(failedOperation).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('remote greeting failed'),
      activityName: 'parity-remote-failure.failGreeting',
      workflowId: 'parity-remote-failure-1',
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

    expect(handle.result()).resolves.toEqual({
      confirmation: 'mocked-charge:ord-123',
    });
    expect(chargeCardMock.callCount).toBe(1);
    expect(chargeCardMock.lastCall?.input).toEqual({ orderId: 'ord-123' });
  });
});
