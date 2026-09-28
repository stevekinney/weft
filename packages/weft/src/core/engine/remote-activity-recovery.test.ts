/**
 * COR-152 "Broker Boundary and Configuration" — acceptance criteria 6, 7, 8,
 * and 11.
 *
 * Criterion 6 ("result-before-waiter and recovery-before-result paths adopt
 * exactly one outcome") has two halves, both closed and tested here:
 *
 * - **Same-process ordering** ("result-before-waiter"): a result that
 *   arrives before, or exactly as, the pending token is registered can never
 *   outrun registration, because `AsyncActivityDeferral.afterRegister` runs
 *   the enqueue strictly after the durable `registerPendingAsyncActivity`
 *   write — see that field's doc comment in `async-activity-completion.ts`.
 * - **Cross-crash durability** ("recovery-before-result"): every
 *   terminal-producing ledger transition co-commits a durable async-activity
 *   resolution record (carrying the REAL value/error, not just the ledger's
 *   digest) in the SAME `conditionalBatch` as the transition itself — see
 *   `remote-activity-result-bridge.ts`'s `buildTerminalResolutionWrites` and
 *   its call sites in `task-ledger-completion.ts`, `task-reconciliation.ts`,
 *   and `task-dispatch.ts`. A crash strictly between that commit landing and
 *   any bridge delivery therefore cannot lose the value: `recoverAll()`
 *   reloads the resolution record and delivers it when replay re-parks on
 *   the same deterministic token.
 */
import { afterEach, describe, expect, it, mock, setSystemTime } from 'bun:test';

import { serve, type ServeOptions, type WeftServer } from '../../server/index.ts';
import { commitTaskLedgerCompletion } from '../../server/runtime/task-ledger-completion.ts';
import { useManualTaskReconciliationForTesting } from '../../server/runtime/task-reconciliation.ts';
import {
  createDeferred,
  waitForCondition,
  waitForever,
} from '../../testing/fake-timers.test-support.ts';
import { RemoteWorker } from '../../worker/index.ts';
import type { RemoteActivityBroker } from '../remote-activity-broker.ts';
import { commitTaskLedgerTransition } from '../task-ledger/task-ledger-runtime.ts';
import { claimQueued } from '../task-ledger/task-ledger-transitions.ts';
import type { RemoteTaskRecord } from '../task-ledger/task-ledger.ts';
import { decodeRemoteTaskRecord } from '../task-ledger/task-ledger.ts';
import type { WorkflowContext } from '../types.ts';
import { activity, workflow } from '../types.ts';
import { EngineDisposedError } from './errors.ts';
import { Engine } from './index.ts';

async function readOnlyTaskLedgerRecord(engine: Engine): Promise<RemoteTaskRecord | null> {
  for await (const [, value] of engine.storage.scan('task-ledger:')) {
    return decodeRemoteTaskRecord(value);
  }
  return null;
}

describe('remote activity recovery (COR-152)', () => {
  let engine: Engine | undefined;
  let server: WeftServer | undefined;
  let remoteWorker: RemoteWorker | undefined;
  let originalWorker: RemoteWorker | undefined;

  afterEach(async () => {
    // Real time first: `RemoteWorker#disconnect` drains in-flight work
    // against a `Date.now()` deadline, which a frozen clock never reaches.
    setSystemTime();
    await remoteWorker?.disconnect();
    remoteWorker = undefined;
    await originalWorker?.disconnect();
    originalWorker = undefined;
    await server?.stop();
    server = undefined;
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('leaves the task durably queued when no server exists at enqueue time (criterion 7)', async () => {
    engine = new Engine({ activityExecution: { mode: 'remote' } });

    const localChargeCard = mock(async (_input: { orderId: string }): Promise<never> => {
      throw new Error('local execution must never run in remote mode');
    });
    const chargeCard = activity({
      name: 'chargeCard',
      execute: localChargeCard,
    });
    engine.register(
      workflow({ name: 'no-server-workflow' })
        .activities({ chargeCard })
        .execute(async function* (context: WorkflowContext) {
          return yield* context.run(chargeCard, { orderId: 'ord-1' });
        }),
    );

    await engine.start('no-server-workflow', null, { id: 'no-server-1' });

    await waitForCondition(
      async () => {
        const record = await readOnlyTaskLedgerRecord(engine!);
        return record !== null && record.state === 'queued';
      },
      { timeoutMs: 2_000, intervalMs: 10, label: 'task to reach durable queued state' },
    );

    // "Durably queued" is not a dead end once infrastructure DOES appear —
    // proven end-to-end (server and worker both already present at enqueue
    // time) by `remote-activity-execution.test.ts`'s criterion-1 test. A
    // WebSocket worker that connects only AFTER the record already fell back
    // to the long-poll queue's in-memory hint receives it through the
    // registration drain, covered by `server/runtime/long-poll-drain.test.ts`.
    expect(localChargeCard).toHaveBeenCalledTimes(0);
  });

  it('never lets a result outrun pending-token registration, even an implausibly fast one (criterion 6)', async () => {
    // A broker whose `enqueue` immediately tries to resolve the SAME token it
    // was just asked to enqueue — the worst case for a "result-before-waiter"
    // race. If `AsyncActivityDeferral.afterRegister` ordering is correct,
    // `registerPendingAsyncActivity` has ALREADY durably run by the time this
    // broker method is invoked, so `engine.completeAsyncActivity` below must
    // find the token and succeed — not throw `AsyncActivityTokenNotFoundError`.
    const instantResolveBroker: RemoteActivityBroker = {
      async enqueue(request) {
        await engine!.completeAsyncActivity(request.operationId, 'resolved-instantly');
      },
    };

    engine = new Engine({ activityExecution: { mode: 'remote', broker: instantResolveBroker } });

    const localSendEmail = mock(async (_input: { to: string }): Promise<never> => {
      throw new Error('local execution must never run in remote mode');
    });
    const sendEmail = activity({
      name: 'sendEmail',
      execute: localSendEmail,
    });
    engine.register(
      workflow({ name: 'instant-resolve-workflow' })
        .activities({ sendEmail })
        .execute(async function* (context: WorkflowContext) {
          return yield* context.run(sendEmail, { to: 'a@b.com' });
        }),
    );

    const handle = await engine.start('instant-resolve-workflow', null, { id: 'instant-1' });
    expect(await handle.result()).toBe('resolved-instantly');
    expect(localSendEmail).toHaveBeenCalledTimes(0);
  });

  it('adopts the real value across a crash between the ledger commit and any bridge delivery (criterion 6)', async () => {
    engine = new Engine({ activityExecution: { mode: 'remote' } });
    const storage = engine.storage;

    const localChargeCard = mock(async (_input: { orderId: string }): Promise<never> => {
      throw new Error('local execution must never run in remote mode');
    });
    const chargeCard = activity({
      name: 'chargeCard',
      execute: localChargeCard,
    });
    const crashWorkflow = workflow({ name: 'crash-before-bridge-workflow' })
      .activities({ chargeCard })
      .execute(async function* (context: WorkflowContext) {
        return yield* context.run(chargeCard, { orderId: 'ord-1' });
      });
    engine.register(crashWorkflow);

    const handle = await engine.start('crash-before-bridge-workflow', null, {
      id: 'crash-before-bridge-1',
    });

    let queuedOperationId: string | undefined;
    await waitForCondition(
      async () => {
        for await (const [, value] of storage.scan('task-ledger:')) {
          const record = decodeRemoteTaskRecord(value);
          if (record !== null && record.state === 'queued') {
            // The record's own `operationId` field, not a slice of the
            // (percent-encoded) storage key — `commitTaskLedgerTransition`
            // re-derives the key from the raw id itself.
            queuedOperationId = record.operationId;
            return true;
          }
        }
        return false;
      },
      { timeoutMs: 2_000, intervalMs: 10, label: 'task to reach durable queued state' },
    );
    if (queuedOperationId === undefined) throw new Error('expected a queued operationId');

    // Drive the ledger straight through `queued -> leased -> terminal
    // (completed)`, using the exact same production commit path a real
    // worker's `taskResult` message would (`commitTaskLedgerCompletion`,
    // which now co-commits the durable async-activity resolution record in
    // the SAME batch as the terminal transition) — and then stop, WITHOUT
    // ever calling `bridgeRemoteActivityResult`/`completeAsyncActivity`.
    // That gap — real value durably committed, nothing ever told the
    // engine — IS the crash this test proves survivable.
    const attemptToken = crypto.randomUUID();
    const claimed = await commitTaskLedgerTransition(storage, queuedOperationId, (current, now) => {
      if (current === null || current.state !== 'queued') {
        throw new Error(`expected a queued record for "${queuedOperationId}"`);
      }
      return claimQueued(
        current,
        {
          expectedGeneration: current.generation,
          attemptToken,
          workerSessionId: 'crash-test-session',
          leaseDurationMilliseconds: 30_000,
        },
        now,
      );
    });
    if (!claimed.ok) throw new Error(`failed to claim: ${claimed.reason}`);

    const committed = await commitTaskLedgerCompletion(storage, {
      operationId: queuedOperationId,
      attemptToken,
      status: 'completed',
      value: 'crash-survivor',
    });
    if (!committed.ok || committed.disposition !== 'applied') {
      throw new Error(`failed to commit terminal result: ${JSON.stringify(committed)}`);
    }

    // The crash: dispose the engine with NO bridge call ever having run.
    // `handle.result()` is intentionally left unawaited above — awaiting it
    // here would hang forever, since nothing has delivered the outcome yet.
    engine[Symbol.dispose]();
    engine = undefined;

    // Recovery: a fresh engine over the SAME durable storage. No server, no
    // worker, no timing — the barrier is `recoverAll()` resolving.
    const recoveredEngine = new Engine({ storage, activityExecution: { mode: 'remote' } });
    recoveredEngine.register(crashWorkflow);
    await recoveredEngine.recoverAll();
    engine = recoveredEngine;

    const recoveredHandle = recoveredEngine.getHandle(handle.id);
    expect(await recoveredHandle.result()).toBe('crash-survivor');
    expect(localChargeCard).toHaveBeenCalledTimes(0);
  });

  it('settles the local waiter on disposal without deleting the durable task or pending token (criterion 11)', async () => {
    engine = new Engine({ activityExecution: { mode: 'remote' } });
    const storage = engine.storage;

    const localChargeCard = mock(async (_input: { orderId: string }): Promise<never> => {
      throw new Error('local execution must never run in remote mode');
    });
    const chargeCard = activity({
      name: 'chargeCard',
      execute: localChargeCard,
    });
    engine.register(
      workflow({ name: 'disposal-workflow' })
        .activities({ chargeCard })
        .execute(async function* (context: WorkflowContext) {
          return yield* context.run(chargeCard, { orderId: 'ord-1' });
        }),
    );

    const handle = await engine.start('disposal-workflow', null, { id: 'disposal-1' });

    await waitForCondition(
      async () => {
        const record = await readOnlyTaskLedgerRecord(engine!);
        return record !== null && record.state === 'queued';
      },
      { timeoutMs: 2_000, intervalMs: 10, label: 'task to reach durable queued state' },
    );

    const resultBeforeDispose = handle.result();
    engine[Symbol.dispose]();
    engine = undefined;

    await expect(resultBeforeDispose).rejects.toBeInstanceOf(EngineDisposedError);

    // Recoverable task state survives disposal: the ledger record is
    // untouched, and so is the durable pending-async-activity token record
    // (`registerPendingAsyncActivity`'s write) — a fresh engine recovering
    // this workflow re-parks on the SAME token rather than minting a new one
    // with no record of the outstanding remote task.
    const survivingRecord = decodeRemoteTaskRecord(
      (await (async () => {
        for await (const [, value] of storage.scan('task-ledger:')) return value;
        return null;
      })()) ?? null,
    );
    expect(survivingRecord).not.toBeNull();
    expect(survivingRecord?.state).toBe('queued');

    let pendingTokenRecordCount = 0;
    for await (const [key] of storage.scan(`async-act:v1:${handle.id}:`)) {
      if (!key.endsWith(':resolution')) pendingTokenRecordCount += 1;
    }
    expect(pendingTokenRecordCount).toBe(1);
    expect(localChargeCard).toHaveBeenCalledTimes(0);
  });

  it('preserves leased work across a server stop and restart (criterion 8)', async () => {
    // Nothing here waits on a wall-clock budget. The lease outlives the test
    // in real time, and neither server runs a periodic visibility scanner, so
    // the lease cannot expire — and startup recovery cannot find it expired —
    // until this test moves the clock. The one expiry is an explicit scan run
    // only after the replacement worker has registered, so the redispatch
    // lands on it directly. (A lease that expired before any worker
    // registered would fall back to the long-poll queue and reach the
    // replacement worker through the registration drain instead — see
    // `server/runtime/long-poll-drain.test.ts`.) The lease stays well
    // under the engine's 30s workflow-claim TTL, so jumping the clock past it
    // never expires the engine's own claim on the run.
    engine = new Engine({
      activityExecution: { mode: 'remote', visibilityTimeoutMilliseconds: 10_000 },
    });

    const firstServerOptions = {
      engine,
      port: 0,
      unauthenticatedAccess: 'allow',
      // This test simulates an ABRUPT restart (the process disappears with
      // work in flight), not a graceful drain — a short shutdown timeout
      // keeps `server.stop()` from waiting out its full 30s default for a
      // worker that (by design, via `neverReleased` below) never returns a
      // cooperative result.
      workerShutdownTimeoutMs: 50,
    } satisfies ServeOptions;
    useManualTaskReconciliationForTesting(firstServerOptions);
    server = serve(firstServerOptions);

    const leased = createDeferred();
    const neverReleased = waitForever();
    originalWorker = new RemoteWorker({
      serverUrl: `${server.url.replace(/^http/, 'ws')}/v1/tasks/default/stream`,
      workerId: 'restart-worker',
      deploymentName: 'test-deployment',
      buildId: 'test-build',
      workflows: {
        'restart-workflow': {
          name: 'restart-workflow',
          // Never resolves — this worker only proves the task got LEASED to
          // it before the server stops. It never gets a chance to answer.
          activities: {
            slowActivity: async () => {
              leased.resolve();
              return neverReleased;
            },
          },
        },
      },
      concurrency: 1,
      // This worker is deliberately left with a permanently in-flight task —
      // bound how long a later disconnect() waits to drain it, rather than
      // its 30s default.
      disconnectTimeoutMs: 50,
    });
    // `connect()` resolves on `registerAck`, which the server sends only
    // after inserting the worker into its registry.
    await originalWorker.connect();
    expect(server.registry.getWorker('restart-worker')).toBeDefined();

    const localSlowActivity = mock(async (): Promise<never> => {
      throw new Error('local execution must never run in remote mode');
    });
    const slowActivity = activity({
      name: 'slowActivity',
      execute: localSlowActivity,
    });
    engine.register(
      workflow({ name: 'restart-workflow' })
        .activities({ slowActivity })
        .execute(async function* (context: WorkflowContext) {
          return yield* context.run(slowActivity);
        }),
    );

    const handle = await engine.start('restart-workflow', null, { id: 'restart-1' });

    // The worker runs the activity only after the server durably committed
    // the lease and sent it the task.
    await leased.promise;
    const leasedBeforeStop = await readOnlyTaskLedgerRecord(engine);
    if (leasedBeforeStop?.state !== 'leased') {
      throw new Error(`expected a leased record, got ${JSON.stringify(leasedBeforeStop)}`);
    }

    await server.stop();
    server = undefined;

    // Stopping the server does not touch the durable ledger — the leased
    // record survives exactly as it was. The original worker stays connected
    // to nothing until teardown: disconnecting it here would only exercise
    // the stopped server's socket bookkeeping, which is not this criterion.
    expect(await readOnlyTaskLedgerRecord(engine)).toEqual(leasedBeforeStop);

    const secondServerOptions = {
      engine,
      port: 0,
      unauthenticatedAccess: 'allow',
    } satisfies ServeOptions;
    const secondServerReconciliation = useManualTaskReconciliationForTesting(secondServerOptions);
    server = serve(secondServerOptions);
    // Startup task-ledger recovery has rehydrated the live lease.
    await server.ready;

    remoteWorker = new RemoteWorker({
      serverUrl: `${server.url.replace(/^http/, 'ws')}/v1/tasks/default/stream`,
      workerId: 'replacement-worker',
      deploymentName: 'test-deployment',
      buildId: 'test-build',
      workflows: {
        'restart-workflow': {
          name: 'restart-workflow',
          activities: {
            slowActivity: async () => 'released-after-restart',
          },
        },
      },
      concurrency: 1,
    });
    await remoteWorker.connect();
    expect(server.registry.getWorker('replacement-worker')).toBeDefined();

    // The restart itself still leaves the lease untouched.
    expect(await readOnlyTaskLedgerRecord(engine)).toEqual(leasedBeforeStop);

    // Expire the lease the original worker can never renew. Every ledger
    // transition reads `Date.now()`, so the frozen clock is what lets the
    // requeue — and the replacement worker's claim of the next attempt —
    // see the deadline as passed. It stays frozen until the result lands.
    const expiredAt = leasedBeforeStop.leaseDeadline + 1;
    setSystemTime(expiredAt);
    await secondServerReconciliation.scanAt(
      leasedBeforeStop.operationId,
      leasedBeforeStop.leaseDeadline,
      expiredAt,
    );

    expect(await handle.result()).toBe('released-after-restart');
    expect(localSlowActivity).toHaveBeenCalledTimes(0);

    // The result came from a second attempt of the same durable task, not a
    // new task: the preserved lease was requeued and redispatched.
    const settled = await readOnlyTaskLedgerRecord(engine);
    if (settled?.state !== 'terminal') {
      throw new Error(`expected a terminal record, got ${JSON.stringify(settled)}`);
    }
    expect(settled).toMatchObject({
      operationId: leasedBeforeStop.operationId,
      state: 'terminal',
      disposition: 'resolved',
      attempt: leasedBeforeStop.attempt + 1,
    });
    expect(settled.attemptToken).not.toBe(leasedBeforeStop.attemptToken);
  });
});
