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
import { afterEach, describe, expect, it } from 'bun:test';

import { serve, type WeftServer } from '../../server/index.ts';
import { commitTaskLedgerCompletion } from '../../server/runtime/task-ledger-completion.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
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

  afterEach(async () => {
    await remoteWorker?.disconnect();
    remoteWorker = undefined;
    await server?.stop();
    server = undefined;
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('leaves the task durably queued when no server exists at enqueue time (criterion 7)', async () => {
    engine = new Engine({ activityExecution: { mode: 'remote' } });

    const chargeCard = activity({
      name: 'chargeCard',
      execute: async (_input: { orderId: string }): Promise<never> => {
        throw new Error('local execution must never run in remote mode');
      },
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
    // worker that connects strictly AFTER this exact record already fell
    // back to the long-poll queue's in-memory hint is a separate, pre-existing
    // `reconcileOrphanedRecords`/`WorkerRegistry` interaction this test does
    // not exercise.
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

    const sendEmail = activity({
      name: 'sendEmail',
      execute: async (_input: { to: string }): Promise<never> => {
        throw new Error('local execution must never run in remote mode');
      },
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
  });

  it('adopts the real value across a crash between the ledger commit and any bridge delivery (criterion 6)', async () => {
    engine = new Engine({ activityExecution: { mode: 'remote' } });
    const storage = engine.storage;

    const chargeCard = activity({
      name: 'chargeCard',
      execute: async (_input: { orderId: string }): Promise<never> => {
        throw new Error('local execution must never run in remote mode');
      },
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
  });

  it('settles the local waiter on disposal without deleting the durable task or pending token (criterion 11)', async () => {
    engine = new Engine({ activityExecution: { mode: 'remote' } });
    const storage = engine.storage;

    const chargeCard = activity({
      name: 'chargeCard',
      execute: async (_input: { orderId: string }): Promise<never> => {
        throw new Error('local execution must never run in remote mode');
      },
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
  });

  it('preserves leased work across a server stop and restart (criterion 8)', async () => {
    // A short visibility timeout means the lease this test's FIRST server
    // grants expires quickly once that server (and its in-memory
    // WorkerRegistry) is gone — the mechanism, not a sleep, that lets the
    // SECOND server's own scan reclaim and redispatch the leased record
    // within the test's wait window.
    engine = new Engine({
      activityExecution: { mode: 'remote', visibilityTimeoutMilliseconds: 200 },
    });
    server = serve({
      engine,
      port: 0,
      unauthenticatedAccess: 'allow',
      visibilityPollIntervalMs: 50,
      // This test simulates an ABRUPT restart (the process disappears with
      // work in flight), not a graceful drain — a short shutdown timeout
      // keeps `server.stop()` from waiting out its full 30s default for a
      // worker that (by design, via `neverReleased` below) never returns a
      // cooperative result.
      workerShutdownTimeoutMs: 50,
    });

    const neverReleased = new Promise<never>(() => {});
    remoteWorker = new RemoteWorker({
      serverUrl: `${server.url.replace(/^http/, 'ws')}/v1/tasks/default/stream`,
      workerId: 'restart-worker',
      deploymentName: 'test-deployment',
      buildId: 'test-build',
      workflows: {
        'restart-workflow': {
          name: 'restart-workflow',
          // Never resolves — this worker only proves the task got LEASED to
          // it before the server stops. It never gets a chance to answer.
          activities: { slowActivity: async () => neverReleased },
        },
      },
      concurrency: 1,
      // This worker is deliberately left with a permanently in-flight task —
      // bound how long a later disconnect() waits to drain it, rather than
      // its 30s default.
      disconnectTimeoutMs: 50,
    });
    await remoteWorker.connect();
    await waitForCondition(() => server?.registry.getWorker('restart-worker') !== undefined, {
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
      workflow({ name: 'restart-workflow' })
        .activities({ slowActivity })
        .execute(async function* (context: WorkflowContext) {
          return yield* context.run(slowActivity);
        }),
    );

    const handle = await engine.start('restart-workflow', null, { id: 'restart-1' });

    await waitForCondition(
      async () => {
        const record = await readOnlyTaskLedgerRecord(engine!);
        return record !== null && record.state === 'leased';
      },
      { timeoutMs: 5_000, intervalMs: 25, label: 'task to be leased' },
    );

    await server.stop();
    server = undefined;

    // Stopping the server does not touch the durable ledger — the leased
    // record survives exactly as it was.
    const leasedRecord = await readOnlyTaskLedgerRecord(engine);
    expect(leasedRecord?.state).toBe('leased');

    server = serve({
      engine,
      port: 0,
      unauthenticatedAccess: 'allow',
      visibilityPollIntervalMs: 50,
    });
    await server.ready;
    await remoteWorker.disconnect();
    remoteWorker = new RemoteWorker({
      serverUrl: `${server.url.replace(/^http/, 'ws')}/v1/tasks/default/stream`,
      workerId: 'restart-worker',
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

    expect(await handle.result()).toBe('released-after-restart');
  });
});
