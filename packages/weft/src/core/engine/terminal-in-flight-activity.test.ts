/**
 * COR-1597: a run that a cancel, a timeout, or the history circuit breaker ends has its
 * `handle.result()` settle only after the top-level `activity` it had in flight has settled, so a
 * reader that acts on the result sees what the activity wrote. Every other termination settles
 * at once, and nothing waits on code that never settles: a configured `timeout` bounds an
 * activity that ignores `ctx.signal`, and disposal rejects the held result with the terminal
 * error already committed, never with `EngineDisposedError`.
 *
 * Every rejection is observed through an attached handler, so a result that wrongly stays
 * pending fails the test on its own assertion instead of hanging it.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { createDeferred, waitForRealTimersForTesting } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { KEYS } from '../../storage/keys.ts';
import { nextAsyncPendingToken } from '../../testing/async-activity.test-support.ts';
import { encode } from '../codec.ts';
import { WorkflowTimeoutError } from '../timeouts.ts';
import type { ActivityContext, WorkflowContext } from '../types.ts';
import { activity, HISTORY_CIRCUIT_BREAKER_REASON, workflow } from '../types.ts';
import { bootstrapWorkflowResultResolver, createWorkflowResultWaiter } from './handle-result.ts';
import { Engine } from './index.ts';
import type { EngineInternals } from './internals.ts';
import { getInternals } from './internals.ts';
import {
  heldActivity,
  macrotasks,
  nextId,
  observe,
  statusOf,
} from './terminal-in-flight-activity.test-support.ts';
import { beginPendingTerminalSettlement } from './terminal-settlement-pending.ts';

describe('a terminated run settles its result after its in-flight inline activity (COR-1597)', () => {
  it("a cancelled run's result stays pending until its in-flight inline activity settles", async () => {
    await using engine = new Engine();
    const { heldWorkflow, started, gate, record } = heldActivity();
    engine.register(heldWorkflow);
    const id = nextId('cancel');
    const handle = await engine.start('held-workflow', null, { id });
    const result = observe(handle.result());
    await started.promise;

    await engine.cancel(id);

    expect(await statusOf(engine, id)).toBe('cancelled');
    await macrotasks(5);
    expect(result.state).toBe('pending');
    expect(record.completed).toBe(0);

    gate.resolve();
    await result.settled;

    expect(result.state).toBe('rejected');
    expect(result.reason).toEqual(new Error('Workflow cancelled'));
    expect(record.completed).toBe(1);
  });

  it("a timed-out run's result stays pending until its in-flight inline activity settles", async () => {
    await using engine = new Engine();
    const { heldWorkflow, started, gate, record } = heldActivity();
    engine.register(heldWorkflow);
    const id = nextId('timeout');
    const handle = await engine.start('held-workflow', null, { id });
    const result = observe(handle.result());
    await started.promise;

    await engine.timeout(id);

    expect(await statusOf(engine, id)).toBe('timed-out');
    await macrotasks(5);
    expect(result.state).toBe('pending');

    gate.resolve();
    await result.settled;

    expect(result.state).toBe('rejected');
    expect(result.reason).toBeInstanceOf(WorkflowTimeoutError);
    expect(record.completed).toBe(1);
  });

  it("a history-breaker termination settles its result after the breaching operation's activity", async () => {
    // One event is allowed, so the first activity's checkpoint fits and the held activity's
    // checkpoint breaches the cap: the run is terminated inside the turn that goes on to start
    // that same activity.
    await using engine = new Engine({ history: { maxEvents: 1 } });
    const { heldWorkflow, started, gate, record } = heldActivity({ afterQuickActivity: true });
    engine.register(heldWorkflow);
    const id = nextId('breaker');
    const handle = await engine.start('held-workflow', null, { id });
    const result = observe(handle.result());
    await started.promise;
    await macrotasks(5);

    expect(await statusOf(engine, id)).toBe('timed-out');
    expect(record.ran).toBe(1);
    expect(result.state).toBe('pending');

    gate.resolve();
    await result.settled;

    expect(result.state).toBe('rejected');
    expect(result.reason).toBeInstanceOf(WorkflowTimeoutError);
    expect((result.reason as WorkflowTimeoutError).terminationReason).toBe(
      HISTORY_CIRCUIT_BREAKER_REASON,
    );
    expect(record.completed).toBe(1);
    expect(record.signalAbortedInside).toBe(false);
  });

  it('a result first requested after the terminal commit waits for the in-flight activity', async () => {
    const variants = [
      { label: 'default ownership', options: {}, poll: false },
      {
        label: 'workflow-lease polling',
        options: {
          ownership: 'workflow-lease' as const,
          workflowClaimTtl: 200,
          workflowClaimRenewInterval: 20,
          recover: false,
        },
        poll: false,
      },
      {
        label: 'workflow-lease manual maintenance',
        options: {
          ownership: 'workflow-lease' as const,
          backgroundTasks: 'manual' as const,
          workflowClaimTtl: 200,
          workflowClaimRenewInterval: 20,
          recover: false,
        },
        poll: true,
      },
    ];
    for (const variant of variants) {
      await using engine = await Engine.create({
        storage: new MemoryStorage(),
        ...variant.options,
      });
      const { heldWorkflow, started, gate, record } = heldActivity();
      engine.register(heldWorkflow);
      const id = nextId('late');
      const handle = await engine.start('held-workflow', null, { id });
      await started.promise;
      await engine.cancel(id);

      // First asked for after the terminal state is committed, with the activity still held.
      const result = observe(handle.result());
      await macrotasks(5);
      if (variant.poll) await engine.runMaintenance();
      // Real time: three renew intervals, so the automatic poll runs several times while held.
      await waitForRealTimersForTesting(60);
      if (variant.poll) await engine.runMaintenance();
      expect(result.state, variant.label).toBe('pending');

      gate.resolve();
      await result.settled;

      expect(result.state, variant.label).toBe('rejected');
      expect(result.reason, variant.label).toEqual(new Error('Workflow cancelled'));
      expect(record.completed, variant.label).toBe(1);
    }
  });

  it('a second termination of a held run does not release its result early', async () => {
    await using engine = new Engine();
    const { heldWorkflow, started, gate } = heldActivity();
    engine.register(heldWorkflow);
    const id = nextId('twice');
    const handle = await engine.start('held-workflow', null, { id });
    const result = observe(handle.result());
    await started.promise;

    await engine.cancel(id);
    await engine.cancel(id);
    await engine.timeout(id);
    await macrotasks(5);
    expect(result.state).toBe('pending');

    gate.resolve();
    await result.settled;
    expect(result.state).toBe('rejected');
    expect(result.reason).toEqual(new Error('Workflow cancelled'));
  });

  it('cancelling a run waiting on a signal with an update handler rejects its result at once', async () => {
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'update-handler-wait' }).execute(async function* (ctx: WorkflowContext) {
        ctx.onUpdate('noop', () => 'ok');
        return yield* ctx.waitForSignal<string>('go');
      }),
    );
    const id = nextId('update-wait');
    const handle = await engine.start('update-handler-wait', null, { id });
    const result = observe(handle.result());
    await macrotasks(3);

    await engine.cancel(id);
    await macrotasks(1);

    expect(result.state).toBe('rejected');
    expect(result.reason).toEqual(new Error('Workflow cancelled'));
  });

  it('cancelling a run whose activity deferred to async completion rejects its result at once', async () => {
    await using engine = new Engine();
    const awaitCallback = activity({
      name: 'awaitCallback',
      execute: (_input: void, context?: ActivityContext): unknown => context!.completeAsync(),
    });
    engine.register(
      workflow({ name: 'deferred-activity' })
        .activities({ awaitCallback })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run(awaitCallback);
        }),
    );
    const id = nextId('async');
    const pending = nextAsyncPendingToken(engine);
    const handle = await engine.start('deferred-activity', null, { id });
    const result = observe(handle.result());
    await pending;
    await macrotasks(3);

    await engine.cancel(id);
    await macrotasks(1);

    expect(result.state).toBe('rejected');
    expect(result.reason).toEqual(new Error('Workflow cancelled'));
  });

  it('a non-cooperating activity with a timeout releases the terminal result at the timeout', async () => {
    await using engine = new Engine();
    const started = createDeferred();
    const stuck = activity({
      name: 'stuck',
      timeout: 40,
      // Ignores `ctx.signal` and never settles: only the per-attempt timeout ends the wait.
      execute: async () => {
        started.resolve();
        return new Promise<never>(() => {});
      },
    });
    engine.register(
      workflow({ name: 'stuck-workflow' })
        .activities({ stuck })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run(stuck);
        }),
    );
    const id = nextId('stuck');
    const handle = await engine.start('stuck-workflow', null, { id });
    const result = observe(handle.result());
    await started.promise;

    await engine.cancel(id);
    expect(result.state).toBe('pending');
    await result.settled;

    expect(result.state).toBe('rejected');
    expect(result.reason).toEqual(new Error('Workflow cancelled'));
  });

  it('disposing the engine rejects a held result with the committed terminal error', async () => {
    for (const kind of ['cancel', 'timeout'] as const) {
      const engine = new Engine();
      const started = createDeferred();
      const neverStarted = activity({
        name: 'neverStarted',
        execute: async () => {
          started.resolve();
          return new Promise<never>(() => {});
        },
      });
      engine.register(
        workflow({ name: 'never-workflow' })
          .activities({ neverStarted })
          .execute(async function* (ctx: WorkflowContext) {
            return yield* ctx.run(neverStarted);
          }),
      );
      const id = nextId(`dispose-${kind}`);
      const handle = await engine.start('never-workflow', null, { id });
      const result = observe(handle.result());
      await started.promise;
      await (kind === 'cancel' ? engine.cancel(id) : engine.timeout(id));
      await macrotasks(3);
      expect(result.state, kind).toBe('pending');

      engine[Symbol.dispose]();
      await result.settled;

      expect(result.state, kind).toBe('rejected');
      if (kind === 'cancel') {
        expect(result.reason).toEqual(new Error('Workflow cancelled'));
      } else {
        expect(result.reason).toBeInstanceOf(WorkflowTimeoutError);
      }
    }
  });

  it("a start-new replacement keeps its result waiter while the replaced run's terminal settlement is pending", async () => {
    await using engine = new Engine();
    const started = createDeferred();
    const gate = createDeferred();
    const echo = activity({
      name: 'echo',
      execute: async (input: string) => {
        if (input === 'first') {
          started.resolve();
          await gate.promise;
        }
        return input;
      },
    });
    engine.register(
      workflow({ name: 'replaceable' })
        .activities({ echo })
        .execute(async function* (ctx: WorkflowContext, input: string) {
          // The replacement waits for a signal, so its result is still pending when the first
          // run's terminal settlement lands.
          if (input === 'second') yield* ctx.waitForSignal('go');
          return yield* ctx.run(echo, input);
        }),
    );
    const id = nextId('replace');
    const first = await engine.start('replaceable', 'first', { id });
    const firstResult = observe(first.result());
    await started.promise;
    await engine.cancel(id);
    expect(firstResult.state).toBe('pending');

    const second = await engine.start('replaceable', 'second', {
      id,
      onTerminalConflict: 'start-new',
    });
    const secondResult = observe(second.result());
    await macrotasks(3);
    const replacementWaiter = getInternals(engine).resultResolvers.get(id);
    expect(replacementWaiter).toBeDefined();

    // The replaced run's result is still held for its activity: the replacement path leaves it to
    // the pending settlement rather than retiring it as replaced.
    await macrotasks(3);
    expect(firstResult.state).toBe('pending');

    gate.resolve();
    await firstResult.settled;
    await macrotasks(3);

    expect(firstResult.state).toBe('rejected');
    expect(firstResult.reason).toEqual(new Error('Workflow cancelled'));
    expect(getInternals(engine).resultResolvers.get(id)).toBe(replacementWaiter);
    expect(secondResult.state).toBe('pending');

    await engine.signal(id, 'go', null);
    await secondResult.settled;
    expect(secondResult.state).toBe('resolved');
  });
});

describe('a terminal commit that lands while a result read yields (COR-1597)', () => {
  it('holds the waiter that a pending settlement claims during the read', async () => {
    // A claim this engine holds makes the read yield a macrotask before it settles. The commit,
    // and so the pending settlement, can land in that gap, and the read must look again.
    const storage = new MemoryStorage();
    await storage.put(
      KEYS.workflow('yielded-read'),
      encode({
        id: 'yielded-read',
        type: 'held-workflow',
        status: 'cancelled',
        workflowExecutionToken: 'run-a',
        createdAt: 1,
        updatedAt: 2,
      }),
    );
    const internals = {
      storage,
      workflowClaimRegistry: { engineId: 'engine-a', currentEpoch: () => 1 },
      resultResolvers: new Map(),
      pendingTerminalSettlements: new Set(),
      disposed: false,
    } as never as EngineInternals;
    const waiter = createWorkflowResultWaiter(internals, 'yielded-read');
    void waiter.promise.catch(() => {});

    const outcome = bootstrapWorkflowResultResolver(internals, 'yielded-read', waiter);
    // Scheduled before the read's own yield, so it runs first and lands inside the gap.
    setTimeout(() => {
      beginPendingTerminalSettlement(
        internals,
        { workflowId: 'yielded-read', workflowExecutionToken: 'run-a' },
        Promise.resolve(),
        new Error('Workflow cancelled'),
      );
    }, 0);

    expect(await outcome).toBe('pending');
    expect(internals.resultResolvers.get('yielded-read')).toBe(waiter);
  });
});
