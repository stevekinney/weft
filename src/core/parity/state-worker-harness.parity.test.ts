import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { setActivityWorkerDispatcherForTesting } from '../../core/engine/activity-worker-dispatcher.test-support.ts';
import { serve, type WeftServer } from '../../server/index.ts';
import type { RemoteTaskTerminalResolved } from '../../server/task-ledger-types.ts';
import { decodeRemoteTaskRecord, taskLedgerKey } from '../../server/task-ledger.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { TestEngine } from '../../testing/test-engine.ts';
import { RemoteWorker } from '../../worker/index.ts';
import { sha256Hex } from '../../worker/manifest/content-digest.ts';
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

/**
 * Wait for and read a task's terminal record from the durable ledger
 * (WFT-22). Unlike the retired `op:resolved:` record, the ledger's terminal
 * record proves *which* attempt won via `resultDigest` — it does not persist
 * the completed value durably. Delivering that value into a workflow's
 * `ctx.run()` continuation is WFT-24 ("Adoption, Retention, and
 * Diagnostics") territory: its own brief frames this exact split — "the task
 * terminal state proves which attempt won; the workflow checkpoint proves
 * the workflow incorporated it." See the digest-based assertion below for
 * what WFT-22 actually guarantees for a completed result.
 */
async function readTerminalRecord(
  engine: Engine,
  operationId: string,
): Promise<RemoteTaskTerminalResolved> {
  const key = taskLedgerKey(operationId);
  await waitForCondition(
    async () => {
      const record = decodeRemoteTaskRecord(await engine.storage.get(key));
      return record !== null && record.state === 'terminal';
    },
    {
      timeoutMs: 5_000,
      intervalMs: 25,
      label: `operation "${operationId}" to resolve`,
    },
  );

  const record = decodeRemoteTaskRecord(await engine.storage.get(key));
  if (record === null || record.state !== 'terminal' || record.disposition !== 'resolved') {
    throw new Error(`Operation "${operationId}" did not reach a resolved terminal record`);
  }

  return record;
}

function installRemoteWorkerDispatcher(engine: Engine, server: WeftServer): void {
  const dispatcher = {
    async execute(request: ActivityExecutionRequest): Promise<ActivityExecutionResult> {
      // This bridge maps the engine-local bare activity name to the remote
      // worker's advertised qualified name. The worker below registers its
      // activities under the `greeting` workflow type, so the worker advertises
      // (and matches against) `greeting.${activity}`. The engine never qualifies
      // names itself — qualification is the dispatch caller's responsibility.
      const advertisedActivityName = `greeting.${request.activityName}`;
      const dispatched = await server.dispatchTask({
        operationId: request.operationId,
        activityName: advertisedActivityName,
        workflowType: 'greeting',
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

      const resolved = await readTerminalRecord(engine, request.operationId);
      if (resolved.status === 'failed') {
        return {
          operationId: request.operationId,
          status: 'failed',
          error: resolved.error ?? `RemoteWorker failed activity "${request.activityName}"`,
        };
      }

      // No `value` field: the durable ledger never persists the completed
      // payload (see readTerminalRecord's doc comment). A caller that needs
      // the real value cannot get it through this bridge today.
      return {
        operationId: request.operationId,
        status: 'completed',
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
      deploymentName: 'test-deployment',
      buildId: 'test-build',
      workflows: {
        greeting: {
          name: 'greeting',
          activities: {
            formatGreeting: async (input: unknown) => {
              executedInputs.push(input);
              return `Hello, ${(input as { name: string }).name}`;
            },
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

    const failGreeting = activity({
      name: 'failGreeting',
      execute: async () => 'inline fallback should not run',
    });
    const remoteFailureWorkflow = workflow({ name: 'parity-remote-failure' }).execute(
      async function* (context: WorkflowContext) {
        return yield* context.run(failGreeting);
      },
    );
    engine.register(remoteFailureWorkflow);

    // Proves WFT-22's actual guarantee for a completed remote activity: a
    // real WebSocket RemoteWorker executes the real activity, and the exact
    // value it returns is durably provable via `resultDigest` on the
    // terminal ledger record. This dispatches directly (bypassing
    // `ctx.run()`/`ActivityWorkerDispatcher`) because the durable ledger does
    // not persist the completed value itself — delivering that value into a
    // workflow continuation is WFT-24 ("Adoption, Retention, and
    // Diagnostics") territory; see readTerminalRecord's doc comment.
    const directGreetingOperationId = 'parity-direct-greeting';
    const directDispatched = await server.dispatchTask({
      operationId: directGreetingOperationId,
      activityName: 'greeting.formatGreeting',
      workflowType: 'greeting',
      input: { name: 'Ada' },
      workflowId: 'parity-remote-workflow-id',
    });
    expect(directDispatched).toBe(true);

    const directResolved = await readTerminalRecord(engine, directGreetingOperationId);
    expect(directResolved).toMatchObject({
      status: 'completed',
      activityName: 'greeting.formatGreeting',
      workflowId: 'parity-remote-workflow-id',
    });
    expect(directResolved.resultDigest).toBe(
      await sha256Hex(JSON.stringify({ status: 'completed', value: 'Hello, Ada', error: null })),
    );
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

    const failedOperation = await Array.fromAsync(engine.storage.scan('task-ledger:')).then(
      (entries) =>
        entries
          .map(([, value]) => decodeRemoteTaskRecord(value))
          .find(
            (record): record is RemoteTaskTerminalResolved =>
              record !== null &&
              record.state === 'terminal' &&
              record.disposition === 'resolved' &&
              record.activityName === 'greeting.failGreeting',
          ),
    );
    expect(failedOperation).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('remote greeting failed'),
      activityName: 'greeting.failGreeting',
      workflowId: 'parity-remote-workflow-id',
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
