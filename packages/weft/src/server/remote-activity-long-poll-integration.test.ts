/**
 * COR-219 residual: `remote-activity-integration.test.ts` and every
 * engine-integrated remote-activity test in `core/engine/` connect only a
 * WebSocket {@link RemoteWorker}. `dispatchTaskImpl` falls back to the same
 * long-poll task queue (`enqueueTaskForLongPoll`) for the identical `queued`
 * ledger records `EngineOwnedRemoteActivityBroker.enqueue` writes for a
 * `ctx.run()` dispatch whenever no WebSocket worker is available — a real,
 * reachable production path with no coverage anywhere in the
 * engine-integrated remote-activity feature. This file proves claim,
 * successful completion, and cancellation of a `ctx.run()`-dispatched task
 * through {@link LongPollWorker} specifically, mirroring
 * `remote-activity-integration.test.ts`'s structure with the transport
 * swapped.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import type { RemoteTaskRecord } from '../core/task-ledger/task-ledger.ts';
import { decodeRemoteTaskRecord } from '../core/task-ledger/task-ledger.ts';
import type { WorkflowContext } from '../core/types.ts';
import { activity, workflow } from '../core/types.ts';
import { waitForCondition } from '../testing/fake-timers.test-support.ts';
import { LongPollWorker } from '../worker/long-poll.ts';
import { serve, type WeftServer } from './index.ts';

async function readOnlyTaskLedgerRecord(engine: Engine): Promise<RemoteTaskRecord | null> {
  for await (const [, value] of engine.storage.scan('task-ledger:')) {
    return decodeRemoteTaskRecord(value);
  }
  return null;
}

describe('remote activity execution via LongPollWorker (COR-219)', () => {
  let engine: Engine | undefined;
  let server: WeftServer | undefined;
  let longPollWorker: LongPollWorker | undefined;

  afterEach(async () => {
    await longPollWorker?.stop();
    longPollWorker = undefined;
    await server?.stop();
    server = undefined;
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('claims a ctx.run()-dispatched task through LongPollWorker (no WebSocket worker ever connects)', async () => {
    engine = new Engine({ activityExecution: { mode: 'remote' } });
    server = serve({ engine, port: 0, unauthenticatedAccess: 'allow' });

    // Never resolves — this worker only proves the task got LEASED to it via
    // long-poll before this test inspects the durable record. No WebSocket
    // worker exists anywhere in this test, so `selectAndReserveWorker`
    // (`task-dispatch.ts`) has no candidate and `dispatchTaskImpl` must have
    // taken the `enqueueTaskForLongPoll` fallback for the claim to happen at
    // all.
    const neverReleased = new Promise<never>(() => {});
    longPollWorker = new LongPollWorker({
      serverUrl: server.url,
      deploymentName: 'long-poll-claim-test',
      buildId: 'test-build',
      workflows: {
        'lp-claim-workflow': {
          name: 'lp-claim-workflow',
          activities: {
            slowActivity: async () => neverReleased,
          },
        },
      },
      concurrency: 1,
      pollTimeout: 1_000,
      // This worker is deliberately left with a permanently in-flight task —
      // bound how long this test's `afterEach` waits to drain it, rather
      // than the 30s default (matching `remote-activity-recovery.test.ts`'s
      // identical `disconnectTimeoutMs: 50` for the same never-resolving
      // shape).
      disconnectTimeoutMs: 50,
    });
    longPollWorker.start();

    const slowActivity = activity({
      name: 'slowActivity',
      execute: async (): Promise<never> => {
        throw new Error('local execution must never run in remote mode');
      },
    });
    engine.register(
      workflow({ name: 'lp-claim-workflow' })
        .activities({ slowActivity })
        .execute(async function* (context: WorkflowContext) {
          return yield* context.run(slowActivity);
        }),
    );

    // `handle.result()` is intentionally left unawaited — the activity never
    // resolves, so awaiting it here would hang the test forever.
    await engine.start('lp-claim-workflow', null, { id: 'lp-claim-1' });

    const leasedRecord = await waitForCondition(
      async () => {
        const record = await readOnlyTaskLedgerRecord(engine!);
        return record !== null && record.state === 'leased';
      },
      { timeoutMs: 5_000, intervalMs: 25, label: 'task to be claimed via long-poll' },
    ).then(() => readOnlyTaskLedgerRecord(engine!));

    expect(leasedRecord?.state).toBe('leased');
    expect(leasedRecord?.activityName).toBe('lp-claim-workflow.slowActivity');
    if (leasedRecord?.state === 'leased') {
      expect(leasedRecord.attemptToken).toBeString();
    }
  });

  it('completes a ctx.run()-dispatched task end-to-end through LongPollWorker', async () => {
    engine = new Engine({ activityExecution: { mode: 'remote' } });
    server = serve({ engine, port: 0, unauthenticatedAccess: 'allow' });

    const executedInputs: unknown[] = [];
    longPollWorker = new LongPollWorker({
      serverUrl: server.url,
      deploymentName: 'long-poll-success-test',
      buildId: 'test-build',
      workflows: {
        'lp-success-workflow': {
          name: 'lp-success-workflow',
          activities: {
            formatGreeting: async (input: unknown) => {
              executedInputs.push(input);
              return `Hello, ${(input as { name: string }).name}!`;
            },
          },
        },
      },
      concurrency: 1,
      pollTimeout: 1_000,
    });
    longPollWorker.start();

    const formatGreeting = activity({
      name: 'formatGreeting',
      execute: async (_input: { name: string }): Promise<string> => {
        throw new Error('local execution must never run in remote mode');
      },
    });
    engine.register(
      workflow({ name: 'lp-success-workflow' })
        .activities({ formatGreeting })
        .execute(async function* (context: WorkflowContext, input: { name: string }) {
          return yield* context.run(formatGreeting, input);
        }),
    );

    const handle = await engine.start(
      'lp-success-workflow',
      { name: 'Ada' },
      { id: 'lp-success-1' },
    );

    expect(await handle.result()).toBe('Hello, Ada!');
    expect(executedInputs).toEqual([{ name: 'Ada' }]);

    const terminalRecord = await readOnlyTaskLedgerRecord(engine);
    expect(terminalRecord?.state).toBe('terminal');
    if (terminalRecord?.state === 'terminal') {
      expect(terminalRecord.disposition).toBe('resolved');
    }
  });

  it('cancels a ctx.run()-dispatched task through LongPollWorker, cooperatively, before the cancellation grace deadline', async () => {
    engine = new Engine({ activityExecution: { mode: 'remote' } });
    server = serve({ engine, port: 0, unauthenticatedAccess: 'allow' });

    // Long-poll has no server-to-worker push channel: the cancellation
    // signal only reaches this worker on its NEXT heartbeat response
    // (`LongPollWorker#sendHeartbeat`). A short interval turns "wait for the
    // cooperative cancellation" into a real, bounded, event-driven wait
    // rather than relying on the (also real, but much slower) 30s default
    // cancellation-grace fallback that settles `uncertain: true` for an
    // uncooperative activity.
    let abortSignalSeen: AbortSignal | undefined;
    longPollWorker = new LongPollWorker({
      serverUrl: server.url,
      deploymentName: 'long-poll-cancel-test',
      buildId: 'test-build',
      workflows: {
        'lp-cancel-workflow': {
          name: 'lp-cancel-workflow',
          activities: {
            slowActivity: (_input, context) => {
              abortSignalSeen = context?.signal;
              return new Promise((_resolve, reject) => {
                context?.signal.addEventListener('abort', () => {
                  reject(new Error('activity observed cancellation'));
                });
              });
            },
          },
        },
      },
      concurrency: 1,
      pollTimeout: 1_000,
      heartbeatIntervalMs: 20,
    });
    longPollWorker.start();

    const slowActivity = activity({
      name: 'slowActivity',
      execute: async (): Promise<never> => {
        throw new Error('local execution must never run in remote mode');
      },
    });
    engine.register(
      workflow({ name: 'lp-cancel-workflow' })
        .activities({ slowActivity })
        .execute(async function* (context: WorkflowContext) {
          return yield* context.run(slowActivity);
        }),
    );

    const handle = await engine.start('lp-cancel-workflow', null, { id: 'lp-cancel-1' });

    await waitForCondition(
      async () => {
        const record = await readOnlyTaskLedgerRecord(engine!);
        return record !== null && record.state === 'leased';
      },
      { timeoutMs: 5_000, intervalMs: 25, label: 'task to be leased via long-poll' },
    );

    await engine.cancel(handle.id);
    await expect(handle.result()).rejects.toThrow();

    await waitForCondition(
      async () => {
        const record = await readOnlyTaskLedgerRecord(engine!);
        return record !== null && record.state === 'terminal' && record.disposition === 'cancelled';
      },
      {
        timeoutMs: 5_000,
        intervalMs: 25,
        label: "durable task to resolve as cancelled via the worker's cooperative response",
      },
    );

    const terminalRecord = await readOnlyTaskLedgerRecord(engine);
    expect(terminalRecord?.state).toBe('terminal');
    if (terminalRecord?.state === 'terminal' && terminalRecord.disposition === 'cancelled') {
      // Present and `true` only for the non-cooperative, grace-deadline
      // fallback (`commitUncertainCancellation`) — absent here proves the
      // worker's own cooperative `taskResult` landed, not a timeout.
      expect(terminalRecord.uncertain).toBeUndefined();
    }
    expect(abortSignalSeen?.aborted).toBe(true);
  });
});
