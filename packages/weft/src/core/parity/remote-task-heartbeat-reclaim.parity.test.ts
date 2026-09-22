import { describe, expect, it } from 'bun:test';

import { serve, type ServeOptions, type WeftServer } from '../../server/index.ts';
import { useManualTaskReconciliationForTesting } from '../../server/runtime/task-reconciliation.ts';
import type { Storage } from '../../storage/interface.ts';
import { REMOTE_WORKER_PROTOCOL_VERSION } from '../../worker/protocol.ts';
import { manifestForActivities } from '../../worker/registry-fixtures.test-support.ts';
import { Engine } from '../engine.ts';
import type { RemoteTaskLeased } from '../task-ledger/task-ledger-types.ts';
import { decodeRemoteTaskRecord, taskLedgerKey } from '../task-ledger/task-ledger.ts';
import { waitForParityCondition } from './real-timer-wait.test-support.ts';

/** Reads the ledger record for `operationId`, asserting it is currently leased. */
async function readLeasedRecord(storage: Storage, operationId: string): Promise<RemoteTaskLeased> {
  const record = decodeRemoteTaskRecord(await storage.get(taskLedgerKey(operationId)));
  if (record === null || record.state !== 'leased') {
    throw new Error(
      `Expected a leased ledger record for "${operationId}", got: ${record?.state ?? 'absent'}`,
    );
  }
  return record;
}

/**
 * This case is intentionally separated from the rest of the failure-handling
 * parity suite. It drives a real {@link serve} instance, a real WebSocket
 * worker connection, and the real heartbeat persistence path. Periodic task
 * reconciliation is disabled through an internal test-only option marker so the test
 * can drive stale-deadline and expired-deadline scans explicitly. This keeps
 * the production transport boundary without making correctness depend on CPU
 * scheduling or wall-clock polling.
 */

describe('Temporal failure-handling parity (remote-task heartbeat reclaim)', () => {
  it('rejects manual scans before the test server registers its options', () => {
    const engine = new Engine();
    const manualReconciliation = useManualTaskReconciliationForTesting({
      engine,
      port: 0,
      unauthenticatedAccess: 'allow',
    } satisfies ServeOptions);

    expect(() => manualReconciliation.scanAt('unregistered-task', 1, 2)).toThrow(
      'Manual task reconciliation requires a running test server',
    );

    engine[Symbol.dispose]();
  });

  it('keeps a heartbeating remote task assigned while reclaiming one that stops heartbeating', async () => {
    const engine = new Engine();
    let server: WeftServer | undefined;
    let socket: WebSocket | undefined;
    const taskAttempts: number[] = [];
    // COR-230: the attempt-fenced `activityHeartbeat` must echo the current
    // dispatch's `attemptToken`, unlike the retired v4 bare-heartbeat
    // fan-out this test used to exercise. Captured from each `task` frame.
    let latestAttemptToken: string | undefined;

    try {
      const manualReconciliation = useManualTaskReconciliationForTesting({
        engine,
        port: 0,
        unauthenticatedAccess: 'allow',
      } satisfies ServeOptions);
      server = serve(manualReconciliation.options);

      socket = new WebSocket(`ws://localhost:${server.port}/v1/tasks/default/stream`);
      socket.addEventListener('open', () => {
        socket?.send(
          JSON.stringify({
            type: 'register',
            workerId: 'parity-heartbeat-worker',
            manifest: manifestForActivities(['parityRemoteActivity']),
            concurrency: 1,
            protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
          }),
        );
      });
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as {
          type: string;
          operationId?: string;
          attempt?: number;
          attemptToken?: string;
        };
        if (message.type !== 'task') return;
        taskAttempts.push(message.attempt ?? 1);
        latestAttemptToken = message.attemptToken;
      });

      await waitForParityCondition(() => server?.registry.size === 1, {
        label: 'remote worker registration',
      });

      await server.dispatchTask({
        operationId: 'parity-heartbeating-task',
        activityName: 'test.parityRemoteActivity',
        workflowType: 'test',
        input: null,
        visibilityTimeout: 120,
      });

      await waitForParityCondition(() => taskAttempts.length === 1, {
        label: 'first remote task dispatch',
      });
      const beforeHeartbeat = await readLeasedRecord(engine.storage, 'parity-heartbeating-task');

      const dispatchTime = beforeHeartbeat.leaseDeadline - 120;
      await waitForParityCondition(() => Date.now() >= dispatchTime + 10, {
        label: 'clock advanced before heartbeat',
      });
      if (socket === undefined) {
        throw new Error('Remote worker socket was not initialized');
      }
      if (latestAttemptToken === undefined) {
        throw new Error('Expected a captured attemptToken from the dispatched task frame');
      }

      // COR-230, acceptance criterion 1: a bare session `heartbeat` proves
      // the WEBSOCKET is alive, not the ATTEMPT — it must not extend this
      // (or any) task's visibility deadline, unlike the retired v4
      // bare-heartbeat fan-out this test used to exercise. Prove the
      // negative directly, on the durable record, before proving the
      // positive below — this is the exact split Temporal's own
      // `RecordActivityTaskHeartbeat` (per-task-token) draws against a
      // connection-level liveness signal, so strengthening this parity case
      // to pin BOTH halves is the point of this rewrite.
      const lastHeartbeatBeforeBare = server.registry.getAll()[0]?.lastHeartbeat ?? 0;
      socket.send(JSON.stringify({ type: 'heartbeat', workerId: 'parity-heartbeat-worker' }));
      await waitForParityCondition(
        () => (server?.registry.getAll()[0]?.lastHeartbeat ?? 0) > lastHeartbeatBeforeBare,
        { label: 'session heartbeat observed by the registry' },
      );
      const afterBareHeartbeat = await readLeasedRecord(engine.storage, 'parity-heartbeating-task');
      expect(afterBareHeartbeat.leaseDeadline).toBe(beforeHeartbeat.leaseDeadline);

      // COR-230: only an `activityHeartbeat` naming this exact attempt
      // renews it, fenced by `operationId` + `attemptToken` through the same
      // identity check `taskResult` uses.
      socket.send(
        JSON.stringify({
          type: 'activityHeartbeat',
          workerId: 'parity-heartbeat-worker',
          operationId: 'parity-heartbeating-task',
          attemptToken: latestAttemptToken,
        }),
      );
      await waitForParityCondition(
        async () => {
          const current = await readLeasedRecord(engine.storage, 'parity-heartbeating-task');
          return current.leaseDeadline > beforeHeartbeat.leaseDeadline;
        },
        { label: 'heartbeat deadline extension' },
      );
      const afterHeartbeat = await readLeasedRecord(engine.storage, 'parity-heartbeating-task');

      await manualReconciliation.scanAt(
        'parity-heartbeating-task',
        beforeHeartbeat.leaseDeadline,
        beforeHeartbeat.leaseDeadline + 1,
      );

      expect(afterHeartbeat.leaseDeadline).toBeGreaterThan(beforeHeartbeat.leaseDeadline + 1);
      expect(taskAttempts).toEqual([1]);
      expect(server.registry.isAssigned('parity-heartbeating-task')).toBe(true);

      // requeueExpiredAttempt's deadline precondition is checked against the
      // real wall clock inside commitTaskLedgerTransition (Date.now()), not
      // the simulated `now` passed to scanAt — that simulated value only
      // decides which deadline-tracker heap entries scanExpiredTasks drains.
      // Wait for real time to actually reach the lease deadline before the
      // scan that expects reassignment to succeed.
      await waitForParityCondition(() => Date.now() >= afterHeartbeat.leaseDeadline, {
        label: 'real clock to reach the post-heartbeat lease deadline',
      });
      await manualReconciliation.scanAt(
        'parity-heartbeating-task',
        afterHeartbeat.leaseDeadline,
        afterHeartbeat.leaseDeadline + 1,
      );
      await waitForParityCondition(() => taskAttempts.includes(2), {
        label: 'reclaimed attempt delivery',
      });
      const reassigned = await readLeasedRecord(engine.storage, 'parity-heartbeating-task');
      expect(reassigned.attempt).toBe(2);
      expect(taskAttempts).toEqual([1, 2]);
      expect(server.registry.isAssigned('parity-heartbeating-task')).toBe(true);
    } finally {
      socket?.close();
      await server?.stop();
      engine[Symbol.dispose]();
    }
  });
});
