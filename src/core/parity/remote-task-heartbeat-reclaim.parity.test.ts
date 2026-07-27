import { describe, expect, it } from 'bun:test';

import { serve, type ServeOptions, type WeftServer } from '../../server/index.ts';
import { useManualTaskReconciliationForTesting } from '../../server/runtime/task-reconciliation.ts';
import { KEYS } from '../../storage/interface.ts';
import { decode } from '../codec.ts';
import { Engine } from '../engine.ts';
import { waitForParityCondition } from './real-timer-wait.test-support.ts';

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
            activities: ['parityRemoteActivity'],
            concurrency: 1,
            protocolVersion: 2,
          }),
        );
      });
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as {
          type: string;
          operationId?: string;
          attempt?: number;
        };
        if (message.type !== 'task') return;
        taskAttempts.push(message.attempt ?? 1);
      });

      await waitForParityCondition(() => server?.registry.size === 1, {
        label: 'remote worker registration',
      });

      await server.dispatchTask({
        operationId: 'parity-heartbeating-task',
        activityName: 'parityRemoteActivity',
        input: null,
        visibilityTimeout: 120,
      });

      await waitForParityCondition(() => taskAttempts.length === 1, {
        label: 'first remote task dispatch',
      });
      const beforeHeartbeat = decode(
        (await engine.storage.get(KEYS.operationInflight('parity-heartbeating-task')))!,
      ) as { deadline: number };

      const dispatchTime = beforeHeartbeat.deadline - 120;
      await waitForParityCondition(() => Date.now() >= dispatchTime + 10, {
        label: 'clock advanced before heartbeat',
      });
      if (socket === undefined) {
        throw new Error('Remote worker socket was not initialized');
      }
      socket.send(JSON.stringify({ type: 'heartbeat', workerId: 'parity-heartbeat-worker' }));
      await waitForParityCondition(
        async () => {
          const current = decode(
            (await engine.storage.get(KEYS.operationInflight('parity-heartbeating-task')))!,
          ) as { deadline: number };
          return current.deadline > beforeHeartbeat.deadline;
        },
        { label: 'heartbeat deadline extension' },
      );
      const afterHeartbeat = decode(
        (await engine.storage.get(KEYS.operationInflight('parity-heartbeating-task')))!,
      ) as { deadline: number };

      await manualReconciliation.scanAt(
        'parity-heartbeating-task',
        beforeHeartbeat.deadline,
        beforeHeartbeat.deadline + 1,
      );

      expect(afterHeartbeat.deadline).toBeGreaterThan(beforeHeartbeat.deadline + 1);
      expect(taskAttempts).toEqual([1]);
      expect(server.registry.isAssigned('parity-heartbeating-task')).toBe(true);

      await manualReconciliation.scanAt(
        'parity-heartbeating-task',
        afterHeartbeat.deadline,
        afterHeartbeat.deadline + 1,
      );
      await waitForParityCondition(() => taskAttempts.includes(2), {
        label: 'reclaimed attempt delivery',
      });
      const reassigned = decode(
        (await engine.storage.get(KEYS.operationInflight('parity-heartbeating-task')))!,
      ) as { attempt?: number };
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
