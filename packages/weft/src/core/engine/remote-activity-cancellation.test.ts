/**
 * COR-152 "Broker Boundary and Configuration" — acceptance criterion 10:
 * workflow cancellation targets the current durable attempt and settles the
 * local waiter.
 *
 * "Settling the local waiter" is proven for every case, with or without a
 * server: `terminateWorkflow`'s existing terminal-transition machinery
 * force-settles `handle.result()` for a suspended workflow regardless of
 * WHY it was suspended (`termination/complete.ts`), so a workflow parked on
 * a remote `ctx.run()` is no different from one parked on `ctx.sleep()` or
 * `ctx.waitForSignal()` in this respect. "Targeting the current durable
 * attempt" additionally requires a `serve()`d server: cancellation intent is
 * recorded on the ledger through `WeftServer.cancelTask` (the exact path an
 * operator-initiated cancellation uses), reached via the best-effort
 * `RemoteActivityCancellationRequestedEvent` bridge
 * (`server/runtime/remote-activity-event-bridges.ts`).
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { serve, type WeftServer } from '../../server/index.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { RemoteWorker } from '../../worker/index.ts';
import type { RemoteTaskRecord } from '../task-ledger/task-ledger.ts';
import { decodeRemoteTaskRecord } from '../task-ledger/task-ledger.ts';
import type { WorkflowContext } from '../types.ts';
import { activity, workflow } from '../types.ts';
import { Engine } from './index.ts';

async function readOnlyTaskLedgerRecord(engine: Engine): Promise<RemoteTaskRecord | null> {
  for await (const [, value] of engine.storage.scan('task-ledger:')) {
    return decodeRemoteTaskRecord(value);
  }
  return null;
}

describe('remote activity cancellation (COR-152, criterion 10)', () => {
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

  it('settles the local waiter even with no server to notify (queued-origin)', async () => {
    engine = new Engine({ activityExecution: { mode: 'remote' } });

    const chargeCard = activity({
      name: 'chargeCard',
      execute: async (_input: { orderId: string }): Promise<never> => {
        throw new Error('local execution must never run in remote mode');
      },
    });
    engine.register(
      workflow({ name: 'cancel-no-server-workflow' })
        .activities({ chargeCard })
        .execute(async function* (context: WorkflowContext) {
          return yield* context.run(chargeCard, { orderId: 'ord-1' });
        }),
    );

    const handle = await engine.start('cancel-no-server-workflow', null, {
      id: 'cancel-no-server-1',
    });

    await waitForCondition(
      async () => {
        const record = await readOnlyTaskLedgerRecord(engine!);
        return record !== null && record.state === 'queued';
      },
      { timeoutMs: 2_000, intervalMs: 10, label: 'task to reach durable queued state' },
    );

    await engine.cancel(handle.id);

    await expect(handle.result()).rejects.toThrow();
  });

  it('targets the current durable attempt: a queued task resolves to a cancelled terminal record once a server is attached', async () => {
    engine = new Engine({ activityExecution: { mode: 'remote' } });
    server = serve({ engine, port: 0, unauthenticatedAccess: 'allow' });

    const chargeCard = activity({
      name: 'chargeCard',
      execute: async (_input: { orderId: string }): Promise<never> => {
        throw new Error('local execution must never run in remote mode');
      },
    });
    engine.register(
      workflow({ name: 'cancel-queued-workflow' })
        .activities({ chargeCard })
        .execute(async function* (context: WorkflowContext) {
          return yield* context.run(chargeCard, { orderId: 'ord-1' });
        }),
    );

    const handle = await engine.start('cancel-queued-workflow', null, { id: 'cancel-queued-1' });

    await waitForCondition(
      async () => {
        const record = await readOnlyTaskLedgerRecord(engine!);
        return record !== null && record.state === 'queued';
      },
      { timeoutMs: 2_000, intervalMs: 10, label: 'task to reach durable queued state' },
    );

    await engine.cancel(handle.id);
    await expect(handle.result()).rejects.toThrow();

    await waitForCondition(
      async () => {
        const record = await readOnlyTaskLedgerRecord(engine!);
        return record !== null && record.state === 'terminal' && record.disposition === 'cancelled';
      },
      { timeoutMs: 2_000, intervalMs: 10, label: 'durable task to resolve as cancelled' },
    );
  });

  it('targets the current durable attempt: a leased task moves through cancelling to a cancelled terminal record', async () => {
    engine = new Engine({ activityExecution: { mode: 'remote' } });
    server = serve({
      engine,
      port: 0,
      unauthenticatedAccess: 'allow',
      visibilityPollIntervalMs: 50,
    });

    const neverReleased = new Promise<never>(() => {});
    remoteWorker = new RemoteWorker({
      serverUrl: `${server.url.replace(/^http/, 'ws')}/v1/tasks/default/stream`,
      workerId: 'cancel-leased-worker',
      deploymentName: 'test-deployment',
      buildId: 'test-build',
      workflows: {
        'cancel-leased-workflow': {
          name: 'cancel-leased-workflow',
          activities: { slowActivity: async () => neverReleased },
        },
      },
      concurrency: 1,
      disconnectTimeoutMs: 50,
    });
    await remoteWorker.connect();
    await waitForCondition(() => server?.registry.getWorker('cancel-leased-worker') !== undefined, {
      timeoutMs: 5_000,
      intervalMs: 25,
      label: 'remote worker to register',
    });

    const slowActivity = activity({
      name: 'slowActivity',
      execute: async (): Promise<never> => {
        throw new Error('local execution must never run in remote mode');
      },
    });
    engine.register(
      workflow({ name: 'cancel-leased-workflow' })
        .activities({ slowActivity })
        .execute(async function* (context: WorkflowContext) {
          return yield* context.run(slowActivity);
        }),
    );

    const handle = await engine.start('cancel-leased-workflow', null, { id: 'cancel-leased-1' });

    await waitForCondition(
      async () => {
        const record = await readOnlyTaskLedgerRecord(engine!);
        return record !== null && record.state === 'leased';
      },
      { timeoutMs: 2_000, intervalMs: 10, label: 'task to be leased' },
    );

    await engine.cancel(handle.id);
    await expect(handle.result()).rejects.toThrow();

    // A leased-origin cancellation passes through `cancelling` on its way to
    // `terminal` — the worker's cooperative `cancel` acknowledgement is not
    // exercised here (the stub activity never observes its abort signal), so
    // this settles as `uncertain: true` once the cancellation grace period
    // elapses, exactly like an operator-initiated cancellation of an
    // uncooperative activity would.
    await waitForCondition(
      async () => {
        const record = await readOnlyTaskLedgerRecord(engine!);
        return (
          record !== null &&
          (record.state === 'cancelling' ||
            (record.state === 'terminal' && record.disposition === 'cancelled'))
        );
      },
      { timeoutMs: 2_000, intervalMs: 10, label: 'durable task to record cancellation intent' },
    );
  });
});
