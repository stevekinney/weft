import { describe, expect, it, spyOn } from 'bun:test';

import { serve, type ServeOptions, type WeftServer } from '../../server/index.ts';
import type { ServerContext } from '../../server/runtime/context.ts';
import { scanExpiredTasks } from '../../server/runtime/task-reconciliation.ts';
import { KEYS } from '../../storage/interface.ts';
import { decode } from '../codec.ts';
import { Engine } from '../engine.ts';
import { waitForParityCondition } from './real-timer-wait.test-support.ts';

const MANUAL_TASK_RECONCILIATION_FOR_TESTING = Symbol.for('weft.manual-task-reconciliation');
const SERVER_CONTEXT_FOR_TESTING = Symbol.for('weft.server-context-for-testing');

/**
 * This case is intentionally separated from the rest of the failure-handling
 * parity suite. It drives a real {@link serve} instance, a real WebSocket
 * worker connection, and the real heartbeat persistence path. Periodic task
 * reconciliation is disabled through an internal test-only symbol so the test
 * can drive stale-deadline and expired-deadline scans explicitly. This keeps
 * the production transport boundary without making correctness depend on CPU
 * scheduling or wall-clock polling.
 */

describe('Temporal failure-handling parity (remote-task heartbeat reclaim)', () => {
  it('keeps a heartbeating remote task assigned while reclaiming one that stops heartbeating', async () => {
    const engine = new Engine();
    let server: WeftServer | undefined;
    let socket: WebSocket | undefined;
    const taskAttempts: number[] = [];

    try {
      const serverOptions = {
        engine,
        port: 0,
        unauthenticatedAccess: 'allow',
        [MANUAL_TASK_RECONCILIATION_FOR_TESTING]: true,
      } satisfies ServeOptions & {
        readonly [MANUAL_TASK_RECONCILIATION_FOR_TESTING]: true;
      };
      server = serve(serverOptions);

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

      const serverContext = (
        server as WeftServer & {
          readonly [SERVER_CONTEXT_FOR_TESTING]: ServerContext;
        }
      )[SERVER_CONTEXT_FOR_TESTING];

      await scanAt(
        serverContext,
        serverOptions,
        'parity-heartbeating-task',
        beforeHeartbeat.deadline,
        beforeHeartbeat.deadline + 1,
      );

      expect(afterHeartbeat.deadline).toBeGreaterThan(beforeHeartbeat.deadline + 1);
      expect(taskAttempts).toEqual([1]);
      expect(server.registry.isAssigned('parity-heartbeating-task')).toBe(true);

      await scanAt(
        serverContext,
        serverOptions,
        'parity-heartbeating-task',
        afterHeartbeat.deadline,
        afterHeartbeat.deadline + 1,
      );
      const reassigned = decode(
        (await engine.storage.get(KEYS.operationInflight('parity-heartbeating-task')))!,
      ) as { attempt?: number };
      expect(reassigned.attempt).toBe(2);
      expect(server.registry.isAssigned('parity-heartbeating-task')).toBe(true);
    } finally {
      socket?.close();
      await server?.stop();
      engine[Symbol.dispose]();
    }
  });
});

async function scanAt(
  context: ServerContext,
  options: ServeOptions,
  operationId: string,
  trackedDeadline: number,
  now: number,
): Promise<void> {
  context.deadlineTracker.add({ operationId, deadline: trackedDeadline });
  const dateNow = spyOn(Date, 'now').mockReturnValue(now);
  try {
    await scanExpiredTasks(context, options, () => {});
  } finally {
    dateNow.mockRestore();
  }
}
