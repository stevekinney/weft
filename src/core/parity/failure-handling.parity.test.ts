import { describe, expect, it } from 'bun:test';

import { serve, type WeftServer } from '../../server/index.ts';
import { KEYS } from '../../storage/interface.ts';
import { waitForRealTimersForTesting } from '../../testing/fake-timers.test-support.ts';
import { TestEngine } from '../../testing/test-engine.ts';
import { decode } from '../codec.ts';
import { Engine } from '../engine.ts';
import { activity, workflow, type WorkflowContext } from '../types.ts';

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  {
    timeoutMs = 2_000,
    intervalMs = 5,
    label = 'condition',
  }: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await waitForRealTimersForTesting(intervalMs);
  }
  const message = `Timed out after ${timeoutMs}ms waiting for ${label}`;
  throw lastError instanceof Error
    ? new Error(`${message}: ${lastError.message}`)
    : new Error(message);
}

describe('Temporal failure-handling parity', () => {
  it('retries a transient activity with exponential backoff, then succeeds', async () => {
    using engine = new TestEngine({ startTime: 0 });
    const attempts: number[] = [];

    const flaky = activity({
      name: 'parityFlakyActivity',
      retry: { maxAttempts: 3, initialBackoff: 100, backoffMultiplier: 2, maxBackoff: 1_000 },
      execute: async () => {
        attempts.push(engine.now);
        if (attempts.length < 3) {
          throw new Error(`transient failure ${attempts.length}`);
        }
        return 'charged';
      },
    });

    engine.register(
      workflow({ name: 'parity-retry-success' }).execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.run(flaky);
      }),
    );

    const handle = await engine.start('parity-retry-success', null);
    await waitFor(() => attempts.length === 1, { label: 'first retry attempt' });

    await engine.advanceTime(99);
    expect(attempts).toEqual([0]);

    await engine.advanceTime(1);
    await waitFor(() => attempts.length === 2, { label: 'second retry attempt' });
    expect(attempts).toEqual([0, 100]);

    await engine.advanceTime(199);
    expect(attempts).toEqual([0, 100]);

    await engine.advanceTime(1);
    await expect(handle.result()).resolves.toBe('charged');
    expect(attempts).toEqual([0, 100, 300]);
  });

  it('surfaces the terminal failure after retry attempts are exhausted', async () => {
    using engine = new TestEngine({ startTime: 0 });
    let attempts = 0;

    const alwaysFails = activity({
      name: 'parityAlwaysFails',
      retry: { maxAttempts: 2, initialBackoff: 50, backoffMultiplier: 2, maxBackoff: 500 },
      execute: async () => {
        attempts++;
        throw new Error(`terminal failure ${attempts}`);
      },
    });

    engine.register(
      workflow({ name: 'parity-retry-exhausted' }).execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.run(alwaysFails);
      }),
    );

    const handle = await engine.start('parity-retry-exhausted', null);
    await waitFor(() => attempts === 1, { label: 'first failing attempt' });
    await engine.advanceTime(50);

    await expect(handle.result()).rejects.toThrow('terminal failure 2');
    expect(attempts).toBe(2);
  });

  it('retries idempotent activities through the reconciled dispatch path', async () => {
    using engine = new TestEngine({ startTime: 0 });
    const attempts: number[] = [];

    const idempotentCharge = activity({
      name: 'parityIdempotentCharge',
      retry: { maxAttempts: 2, initialBackoff: 25, backoffMultiplier: 2, maxBackoff: 100 },
      idempotencyKey: () => 'charge:order-1',
      verify: (_result, context) =>
        context?.phase === 'pre-dispatch-reconciliation' ? 'not-completed' : true,
      execute: async () => {
        attempts.push(engine.now);
        if (attempts.length === 1) {
          throw new Error('processor unavailable');
        }
        return 'charge:ok';
      },
    });

    engine.register(
      workflow({ name: 'parity-idempotent-retry' }).execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.run(idempotentCharge);
      }),
    );

    const handle = await engine.start('parity-idempotent-retry', null);
    await waitFor(() => attempts.length === 1, { label: 'first idempotent attempt' });
    await engine.advanceTime(25);

    await expect(handle.result()).resolves.toBe('charge:ok');
    expect(attempts).toEqual([0, 25]);
  });

  it('recovers a pending retry backoff after engine restart', async () => {
    using engine = new TestEngine({ startTime: 0 });
    const attempts: number[] = [];

    const restartFlaky = activity({
      name: 'parityRestartFlakyActivity',
      retry: { maxAttempts: 2, initialBackoff: 25, backoffMultiplier: 2, maxBackoff: 100 },
      execute: async () => {
        attempts.push(attempts.length + 1);
        if (attempts.length === 1) {
          throw new Error('retry after restart');
        }
        return 'recovered';
      },
    });
    const restartWorkflow = workflow({ name: 'parity-retry-restart' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.run(restartFlaky);
    });

    engine.register(restartWorkflow);
    const originalHandle = await engine.start('parity-retry-restart', null);
    await waitFor(() => attempts.length === 1, { label: 'first restart retry attempt' });

    using recovered = engine.recover();
    engine[Symbol.dispose]();
    recovered.register(restartWorkflow);

    await recovered.recoverAll();
    expect(attempts).toEqual([1]);
    const recoveredHandle = recovered.getHandle(originalHandle.id);
    await recovered.advanceTime(25);

    await expect(recoveredHandle.result()).resolves.toBe('recovered');
    expect(attempts).toEqual([1, 2]);
  });

  it('preserves an earlier completed-retry-sleep across restart when a later activity retries', async () => {
    // Regression: writeActivityRetryAttempt for a later step must not clobber
    // the completedRetrySleeps recorded for an earlier retried step. The clobber
    // is only observable across recovery: the persisted state replays, and a
    // dropped completedRetrySleeps makes the recovered run re-execute the first
    // activity's already-completed backoff sleep.
    using engine = new TestEngine({ startTime: 0 });
    const firstAttempts: number[] = [];
    const secondAttempts: number[] = [];

    const firstFlaky = activity({
      name: 'parityFirstFlaky',
      retry: { maxAttempts: 2, initialBackoff: 50, backoffMultiplier: 2, maxBackoff: 200 },
      execute: async () => {
        firstAttempts.push(firstAttempts.length + 1);
        if (firstAttempts.length === 1) throw new Error('first transient');
        return 'first-ok';
      },
    });
    const secondFlaky = activity({
      name: 'paritySecondFlaky',
      retry: { maxAttempts: 2, initialBackoff: 75, backoffMultiplier: 2, maxBackoff: 200 },
      execute: async () => {
        secondAttempts.push(secondAttempts.length + 1);
        if (secondAttempts.length === 1) throw new Error('second transient');
        return 'second-ok';
      },
    });
    const twoStepWorkflow = workflow({ name: 'parity-two-step-retry' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const first = yield* ctx.run(firstFlaky);
      const second = yield* ctx.run(secondFlaky);
      return `${first}/${second}`;
    });

    engine.register(twoStepWorkflow);
    const originalHandle = await engine.start('parity-two-step-retry', null);

    // First activity fails, completes its 50ms backoff, succeeds. Second activity
    // then fails and parks on its 75ms backoff — the moment its retry attempt is
    // written, which must keep the first step's completedRetrySleeps intact.
    await waitFor(() => firstAttempts.length === 1, { label: 'first activity attempt' });
    await engine.advanceTime(50);
    await waitFor(() => firstAttempts.length === 2, { label: 'first activity retry' });
    await waitFor(() => secondAttempts.length === 1, { label: 'second activity attempt' });

    // Recover with the second activity still parked on backoff.
    using recovered = engine.recover();
    engine[Symbol.dispose]();
    recovered.register(twoStepWorkflow);
    await recovered.recoverAll();

    // The first activity's result is cached; recovery must not re-run it.
    expect(firstAttempts).toEqual([1, 2]);

    const recoveredHandle = recovered.getHandle(originalHandle.id);
    await recovered.advanceTime(75);

    await expect(recoveredHandle.result()).resolves.toBe('first-ok/second-ok');
    expect(firstAttempts).toEqual([1, 2]);
    expect(secondAttempts).toEqual([1, 2]);
  });

  it('does not retry errors listed as non-retryable', async () => {
    using engine = new TestEngine({ startTime: 0 });
    let attempts = 0;

    const validationFailure = activity({
      name: 'parityValidationFailure',
      retry: {
        maxAttempts: 3,
        initialBackoff: 50,
        backoffMultiplier: 2,
        maxBackoff: 500,
        nonRetryableErrors: ['ValidationError'],
      },
      execute: async () => {
        attempts++;
        const error = new Error('bad checkout input');
        error.name = 'ValidationError';
        throw error;
      },
    });

    engine.register(
      workflow({ name: 'parity-non-retryable' }).execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.run(validationFailure);
      }),
    );

    const handle = await engine.start('parity-non-retryable', null);

    await expect(handle.result()).rejects.toThrow('bad checkout input');
    expect(attempts).toBe(1);

    await engine.advanceTime(1_000);
    expect(attempts).toBe(1);
  });

  it('runs saga compensators in reverse order and unwinds completed side effects', async () => {
    using engine = new TestEngine();
    const sideEffects: string[] = [];
    const compensations: string[] = [];

    const reserveInventory = activity({
      name: 'parityReserveInventory',
      execute: async (sku: string) => {
        sideEffects.push(`reserve:${sku}`);
        return `reservation:${sku}`;
      },
      compensate: async (sku: string, reservationId: string) => {
        compensations.push(`release:${sku}:${reservationId}`);
      },
    });
    const chargeCard = activity({
      name: 'parityChargeCard',
      execute: async (amount: number) => {
        sideEffects.push(`charge:${amount}`);
        return `charge:${amount}`;
      },
      compensate: async (amount: number, chargeId: string) => {
        compensations.push(`refund:${amount}:${chargeId}`);
      },
    });
    const shipOrder = activity({
      name: 'parityShipOrder',
      execute: async () => {
        throw new Error('carrier unavailable');
      },
    });

    engine.register(
      workflow({ name: 'parity-saga-compensation' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        return yield* ctx.saga([
          { definition: reserveInventory, input: 'sku-1' },
          { definition: chargeCard, input: 42 },
          { definition: shipOrder, input: null },
        ]);
      }),
    );

    const handle = await engine.start('parity-saga-compensation', null);
    await expect(handle.result()).rejects.toThrow('carrier unavailable');

    expect(sideEffects).toEqual(['reserve:sku-1', 'charge:42']);
    expect(compensations).toEqual(['refund:42:charge:42', 'release:sku-1:reservation:sku-1']);
  });

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

      await waitFor(() => server?.registry.size === 1, { label: 'remote worker registration' });

      await server.dispatchTask({
        operationId: 'parity-heartbeating-task',
        activityName: 'parityRemoteActivity',
        input: null,
        visibilityTimeout: 120,
      });

      await waitFor(() => taskAttempts.length === 1, { label: 'first remote task dispatch' });
      const beforeHeartbeat = decode(
        (await engine.storage.get(KEYS.operationInflight('parity-heartbeating-task')))!,
      ) as { deadline: number };

      await waitForRealTimersForTesting(60);
      if (socket === undefined) {
        throw new Error('Remote worker socket was not initialized');
      }
      socket.send(JSON.stringify({ type: 'heartbeat', workerId: 'parity-heartbeat-worker' }));
      await waitFor(
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

      const originalDeadlineDelay = Math.max(0, beforeHeartbeat.deadline - Date.now()) + 20;
      expect(Date.now() + originalDeadlineDelay).toBeLessThan(afterHeartbeat.deadline);
      await waitForRealTimersForTesting(originalDeadlineDelay);
      expect(taskAttempts).toEqual([1]);
      expect(server.registry.isAssigned('parity-heartbeating-task')).toBe(true);

      await waitFor(
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
