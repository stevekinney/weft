import { describe, expect, it } from 'bun:test';

import { serve, type WeftServer } from '../../server/index.ts';
import { KEYS } from '../../storage/interface.ts';
import { waitForRealTimersForTesting } from '../../testing/fake-timers.test-support.ts';
import { decode } from '../codec.ts';
import { Engine } from '../engine.ts';
import { waitForParityCondition } from './real-timer-wait.test-support.ts';

/**
 * This case is intentionally separated from the rest of the failure-handling
 * parity suite. It drives a real {@link serve} instance, a real WebSocket
 * worker connection, and the real 20ms visibility poll racing a real task
 * deadline — none of which can be put on controllable time without rebuilding
 * the transport. Under the parallel pre-commit run, CPU contention can delay the
 * heartbeat round-trip past the original deadline so the poll reclaims the task
 * before the extension lands, flaking the `[1]`-then-`[1, 2]` attempt sequence.
 * The arithmetic invariant (the deadline extended) is deterministic; the
 * attempt-sequence invariant is real-time by construction.
 *
 * It therefore lives in its own file and is registered in
 * `LOAD_SENSITIVE_TEST_PATHS` (scripts/husky/run-tests.ts) so the pre-commit
 * parallel full-suite step skips it; CI runs it in the full suite (CI's runner
 * does not reproduce the local parallel-load contention). See the codegen-tsc
 * and worker-execution-suspension entries for the same rationale.
 */

describe('Temporal failure-handling parity (remote-task heartbeat reclaim)', () => {
  it('keeps a heartbeating remote task assigned while reclaiming one that stops heartbeating', async () => {
    const engine = new Engine();
    let server: WeftServer | undefined;
    let socket: WebSocket | undefined;
    const taskAttempts: number[] = [];

    try {
      server = serve({
        engine,
        port: 0,
        unauthenticatedAccess: 'allow',
        visibilityPollIntervalMs: 20,
      });

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

      await waitForRealTimersForTesting(60);
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

      // The heartbeat extended the deadline past the original expiry. This is
      // the invariant under test and it is proven deterministically by
      // arithmetic — no wall-clock wait. (A previous sleep-until-original-
      // deadline then `expect(taskAttempts).toEqual([1])` re-proved the same
      // property over real time, but under parallel CPU load the sleep
      // overshot the original deadline and the 20ms visibility poll reclaimed
      // the task early, flaking the assertion. Do not reintroduce it.)
      const originalDeadlineDelay = Math.max(0, beforeHeartbeat.deadline - Date.now()) + 20;
      expect(Date.now() + originalDeadlineDelay).toBeLessThan(afterHeartbeat.deadline);
      expect(taskAttempts).toEqual([1]);
      expect(server.registry.isAssigned('parity-heartbeating-task')).toBe(true);

      await waitForParityCondition(
        () => {
          return taskAttempts.length >= 2;
        },
        { timeoutMs: 500, label: 'remote task reclaimed after heartbeats stop' },
      );
      expect(taskAttempts).toEqual([1, 2]);
    } finally {
      socket?.close();
      await server?.stop();
      engine[Symbol.dispose]();
    }
  });
});
