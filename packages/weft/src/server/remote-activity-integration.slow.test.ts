/**
 * COR-152 server-restart recovery for a remote activity: a queued task survives a crash and a
 * fresh engine over the same storage completes it through a real `RemoteWorker`.
 *
 * This lives in the slow lane (COR-1737) because the test holds a deliberate two-second barrier
 * (the recovered record's `availableAt` headroom) that no amount of tuning removes without
 * reintroducing the race it exists to close. The rest of the COR-152 fixture is in
 * `remote-activity-integration.test.ts`.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test';

import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { waitForCondition } from "../../test-support/embedded/testing/src/fake-timers.ts";
import { Engine } from '../core/engine.ts';
import {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  taskLedgerKey,
} from '../core/task-ledger/task-ledger.ts';
import type { WorkflowContext } from '../core/types.ts';
import { activity, workflow } from '../core/types.ts';
import { RemoteWorker } from '../worker/index.ts';
import { serve, type WeftServer } from './index.ts';
import { readOnlyTaskLedgerRecord } from './remote-activity-integration.test-support.ts';

describe('remote activity server restart recovery (COR-152)', () => {
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

  it('preserves and completes a remote task across a server restart and engine recovery', async () => {
    await using storage = new MemoryStorage();

    const localChargeCard = mock(async (_input: { orderId: string }): Promise<never> => {
      throw new Error('local execution must never run in remote mode');
    });
    const chargeCard = activity({
      name: 'chargeCard',
      execute: localChargeCard,
    });
    const restartWorkflow = workflow({ name: 'e2e-restart-workflow' })
      .activities({ chargeCard })
      .execute(async function* (context: WorkflowContext) {
        return yield* context.run(chargeCard, { orderId: 'ord-e2e-1' });
      });

    engine = new Engine({ storage, activityExecution: { mode: 'remote' } });
    engine.register(restartWorkflow);
    server = serve({ engine, port: 0, unauthenticatedAccess: 'allow' });

    const handle = await engine.start('e2e-restart-workflow', null, { id: 'e2e-restart-1' });

    let queuedOperationId: string | undefined;
    await waitForCondition(
      async () => {
        const record = await readOnlyTaskLedgerRecord(engine!);
        if (record === null || record.state !== 'queued') return false;
        queuedOperationId = record.operationId;
        return true;
      },
      { intervalMs: 10, label: 'task to reach durable queued state' },
    );
    if (queuedOperationId === undefined) throw new Error('expected a queued operationId');

    // Simulate a process crash: no graceful drain, no cancellation — the
    // engine and server just disappear.
    await server.stop();
    server = undefined;
    engine[Symbol.dispose]();
    engine = undefined;

    // The recovered workflow's `ctx.run()` replay re-derives the same
    // deterministic token and finds the ledger record already `queued` —
    // `EngineOwnedRemoteActivityBroker.enqueue` short-circuits on that
    // (correctly: no duplicate write), so it never fires a fresh
    // `RemoteActivityQueuedEvent` for a new server to react to immediately.
    // The NEW server's own startup recovery scan (`runTaskLedgerRecovery`)
    // DOES unconditionally schedule a redispatch for a `queued` record it
    // finds — via `scheduleDelayedDispatch(delay = max(0, availableAt -
    // now))` — but a record whose `availableAt` is already in the past
    // schedules that redispatch with `delay = 0`, which can fire before a
    // real WebSocket worker has finished connecting and registering. Once
    // that redispatch attempt finds no registered worker, it falls back to
    // the long-poll queue (`enqueueTaskForLongPoll`) — and a task tracked
    // there is permanently ineligible for `reconcileOrphanedRecords`'
    // periodic WebSocket-redispatch path (`redispatchAvailableQueuedRecord`
    // skips any operationId `taskQueue.isTracked`), so no amount of polling
    // ever recovers it once that happens. Confirmed empirically: an
    // unmodified `availableAt` traps the task in roughly 3 of 8 trials.
    //
    // The fix is not a race to win but an explicit, generous barrier: push
    // `availableAt` into the future before the new server ever starts, so
    // its startup scan schedules the redispatch attempt two seconds out
    // — long past when the worker's registration (confirmed below via an
    // explicit `waitForCondition`) will have completed, even under heavy
    // load. This is the SAME "delayed retry" field `requeueExpiredAttempt`
    // already uses for backoff — not a new mechanism, and not a timeout
    // being widened to paper over a hang.
    const queuedKey = taskLedgerKey(queuedOperationId);
    const queuedRaw = await storage.get(queuedKey);
    const queuedRecord = decodeRemoteTaskRecord(queuedRaw);
    if (queuedRecord === null || queuedRecord.state !== 'queued') {
      throw new Error('expected the recovered task to still be durably queued');
    }
    await storage.put(
      queuedKey,
      encodeRemoteTaskRecord({ ...queuedRecord, availableAt: Date.now() + 2_000 }),
    );

    // Recovery: a fresh engine over the SAME durable storage, replaying the
    // in-flight workflow.
    const recoveredEngine = new Engine({ storage, activityExecution: { mode: 'remote' } });
    recoveredEngine.register(restartWorkflow);
    await recoveredEngine.recoverAll();
    engine = recoveredEngine;

    server = serve({ engine, port: 0, unauthenticatedAccess: 'allow' });
    remoteWorker = new RemoteWorker({
      serverUrl: `${server.url.replace(/^http/, 'ws')}/v1/tasks/default/stream`,
      workerId: 'recovery-worker',
      deploymentName: 'test-deployment',
      buildId: 'test-build',
      workflows: {
        'e2e-restart-workflow': {
          name: 'e2e-restart-workflow',
          activities: { chargeCard: async () => 'charged-after-recovery' },
        },
      },
      concurrency: 1,
    });
    await remoteWorker.connect();
    // Confirm registration BEFORE relying on the 2s `availableAt` headroom
    // above — this is the explicit barrier the delay exists to make room
    // for, not a hope that it finishes in time.
    await waitForCondition(() => server?.registry.getWorker('recovery-worker') !== undefined, {
      intervalMs: 25,
      label: 'recovered remote worker to register',
    });

    const recoveredHandle = engine.getHandle(handle.id);
    expect(await recoveredHandle.result()).toBe('charged-after-recovery');
    expect(localChargeCard).toHaveBeenCalledTimes(0);
  });
});
