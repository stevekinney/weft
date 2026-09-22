/**
 * COR-152 "Broker Boundary and Configuration" — acceptance criteria 1, 2, 3,
 * 4, and 9.
 *
 * These tests construct the engine entirely through the production
 * `activityExecution: { mode: 'remote' }` option. None of them reach for a
 * test-only dispatcher setter or an application polling loop (criterion 2)
 * — `EngineOwnedRemoteActivityBroker` (the default broker) and a real
 * `serve()` + `RemoteWorker` are the only moving parts.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { serve, type WeftServer } from '../../server/index.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { RemoteWorker } from '../../worker/index.ts';
import type { WorkflowInterceptor } from '../interceptor.ts';
import type { RemoteActivityBroker, RemoteActivityTaskRequest } from '../remote-activity-broker.ts';
import type { RemoteTaskRecord } from '../task-ledger/task-ledger.ts';
import { decodeRemoteTaskRecord } from '../task-ledger/task-ledger.ts';
import type { WorkflowContext } from '../types.ts';
import { activity, workflow } from '../types.ts';
import { Engine } from './index.ts';

/**
 * Read the sole task-ledger record this test's workflow enqueued, without
 * pre-computing its deterministic token by hand — token derivation is
 * `deriveAsyncActivityToken`'s internal contract, not a test's to reconstruct.
 */
async function readOnlyTaskLedgerRecord(engine: Engine): Promise<RemoteTaskRecord | null> {
  for await (const [, value] of engine.storage.scan('task-ledger:')) {
    return decodeRemoteTaskRecord(value);
  }
  return null;
}

describe('remote activity execution (COR-152)', () => {
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
  });

  it('executes ctx.run() through a connected RemoteWorker and returns its real value (criterion 1)', async () => {
    engine = new Engine({ activityExecution: { mode: 'remote' } });
    server = serve({ engine, port: 0, unauthenticatedAccess: 'allow' });

    const executedInputs: unknown[] = [];
    remoteWorker = new RemoteWorker({
      serverUrl: `${server.url.replace(/^http/, 'ws')}/v1/tasks/default/stream`,
      workerId: 'formatting-worker',
      deploymentName: 'test-deployment',
      buildId: 'test-build',
      workflows: {
        'remote-format-workflow': {
          name: 'remote-format-workflow',
          activities: {
            formatGreeting: async (input: unknown) => {
              executedInputs.push(input);
              return `Hello, ${(input as { name: string }).name}!`;
            },
          },
        },
      },
      concurrency: 1,
    });
    await remoteWorker.connect();
    await waitForCondition(() => server?.registry.getWorker('formatting-worker') !== undefined, {
      timeoutMs: 5_000,
      intervalMs: 25,
      label: 'remote worker to register',
    });

    const formatGreeting = activity({
      name: 'formatGreeting',
      execute: async (_input: { name: string }): Promise<string> => {
        throw new Error('local execution must never run in remote mode');
      },
    });

    engine.register(
      workflow({ name: 'remote-format-workflow' })
        .activities({ formatGreeting })
        .execute(async function* (context: WorkflowContext, input: { name: string }) {
          return yield* context.run(formatGreeting, input);
        }),
    );

    const handle = await engine.start(
      'remote-format-workflow',
      { name: 'Ada' },
      { id: 'remote-format-1' },
    );

    // The real value the RemoteWorker computed reaches ctx.run()'s
    // continuation — not just a bare "it eventually resolved."
    expect(await handle.result()).toBe('Hello, Ada!');
    expect(executedInputs).toEqual([{ name: 'Ada' }]);
  });

  it('never falls back to local execution when no remote worker is available (criterion 9)', async () => {
    let localInvocationCount = 0;
    engine = new Engine({ activityExecution: { mode: 'remote' } });

    const sendEmail = activity({
      name: 'sendEmail',
      execute: async (_input: { to: string }) => {
        localInvocationCount += 1;
        return 'local-fallback';
      },
    });

    engine.register(
      workflow({ name: 'no-worker-workflow' })
        .activities({ sendEmail })
        .execute(async function* (context: WorkflowContext) {
          return yield* context.run(sendEmail, { to: 'nobody@example.com' });
        }),
    );

    await engine.start('no-worker-workflow', null, { id: 'no-worker-1' });

    // Barrier: the task reaching a durable `queued` record on the engine's
    // OWN storage — with no server or worker ever having existed — proves
    // dispatch already resolved into "enqueue remotely," not "run inline."
    // Local execution and remote enqueue are mutually exclusive branches of
    // the same synchronous leaf-executor decision (`operations-activity.ts`),
    // so this is a logical guarantee, not a timing race.
    await waitForCondition(
      async () => {
        const record = await readOnlyTaskLedgerRecord(engine!);
        return record !== null && record.state === 'queued';
      },
      { timeoutMs: 2_000, intervalMs: 10, label: 'task to reach durable queued state' },
    );

    expect(localInvocationCount).toBe(0);
  });

  it('derives qualified activity name, queue, and retry policy from canonical configuration (criteria 3, 4)', async () => {
    engine = new Engine({
      activityExecution: {
        mode: 'remote',
        queue: 'billing',
        retryPolicy: {
          maxAttempts: 5,
          initialBackoff: '2s',
          backoffMultiplier: 2,
          maxBackoff: '60s',
        },
      },
    });

    const chargeCard = activity({
      name: 'chargeCard',
      timeout: '15s',
      execute: async (_input: { orderId: string }): Promise<never> => {
        throw new Error('local execution must never run in remote mode');
      },
    });

    engine.register(
      workflow({ name: 'billing-workflow' })
        .activities({ chargeCard })
        .execute(async function* (context: WorkflowContext) {
          return yield* context.run(chargeCard, { orderId: 'ord-1' });
        }),
    );

    await engine.start('billing-workflow', null, { id: 'billing-1' });

    await waitForCondition(
      async () => {
        const decoded = await readOnlyTaskLedgerRecord(engine!);
        return decoded !== null && decoded.state === 'queued';
      },
      { timeoutMs: 2_000, intervalMs: 10, label: 'billing task to be durably queued' },
    );
    const record = await readOnlyTaskLedgerRecord(engine);
    if (record === null) throw new Error('expected a durable ledger record');
    // The engine derives qualification from its own canonical registration
    // (`workflowTypeByWorkflowId`), never from caller-supplied strings.
    expect(record.workflowType).toBe('billing-workflow');
    expect(record.activityName).toBe('billing-workflow.chargeCard');
    expect(record.queue).toBe('billing');
    expect(record.retryPolicy).toEqual({
      maxAttempts: 5,
      initialBackoff: '2s',
      backoffMultiplier: 2,
      maxBackoff: '60s',
    });
    // The per-call `timeout` overrides the broker's own configured default.
    expect(record.visibilityTimeoutMilliseconds).toBe(15_000);
  });

  it('reaches the durable envelope with headers and the workflow execution token (criterion 4)', async () => {
    const requests: RemoteActivityTaskRequest[] = [];
    const recordingBroker: RemoteActivityBroker = {
      async enqueue(request) {
        requests.push(request);
      },
    };

    engine = new Engine({ activityExecution: { mode: 'remote', broker: recordingBroker } });

    const traceHeaderInterceptor: WorkflowInterceptor = {
      *activity(interception, next) {
        interception.headers.set('x-trace-id', 'trace-abc-123');
        return yield* next(interception);
      },
    };
    engine.addInterceptor(traceHeaderInterceptor);

    const sendEmail = activity({
      name: 'sendEmail',
      execute: async (_input: { to: string }): Promise<never> => {
        throw new Error('local execution must never run in remote mode');
      },
    });

    engine.register(
      workflow({ name: 'headers-workflow' })
        .activities({ sendEmail })
        .execute(async function* (context: WorkflowContext) {
          return yield* context.run(sendEmail, { to: 'a@b.com' });
        }),
    );

    const handle = await engine.start('headers-workflow', null, { id: 'headers-1' });

    await waitForCondition(() => requests.length > 0, {
      timeoutMs: 2_000,
      intervalMs: 10,
      label: 'broker.enqueue to be called',
    });

    const request = requests[0]!;
    expect(request.workflowId).toBe('headers-1');
    expect(request.workflowType).toBe('headers-workflow');
    expect(request.activityName).toBe('sendEmail');
    expect(request.input).toEqual({ to: 'a@b.com' });
    expect(request.headers).toEqual({ 'x-trace-id': 'trace-abc-123' });
    expect(request.workflowExecutionToken).toBeString();

    // Resolve the parked activity so the handle settles cleanly.
    await engine.completeAsyncActivity(request.operationId, 'sent');
    expect(await handle.result()).toBe('sent');
  });
});
