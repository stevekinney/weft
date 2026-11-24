/**
 * COR-1597, the bounds of the hold: a result is held only while a top-level activity is genuinely
 * running inline. An activity that defers to out-of-band completion (`completeAsync()` or remote
 * dispatch) hands the router a promise that never settles, so the hold releases the moment it
 * defers, however the cancel or the breaker raced its checkpoint. A purge, and a replacement run,
 * leave the held result to the settlement that owns it. Another operation type that is recorded
 * but whose turn lives on (a signal wait cancelled during its checkpoint persist) is never waited
 * for.
 *
 * Every rejection is observed through an attached handler, so a result that wrongly stays pending
 * fails the test on its own assertion instead of hanging it.
 */
import { describe, expect, it } from 'bun:test';

import { createDeferred } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { WorkflowTimeoutError } from '../timeouts.ts';
import type { ActivityContext, WorkflowContext } from '../types.ts';
import { activity, HISTORY_CIRCUIT_BREAKER_REASON, workflow } from '../types.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import {
  heldActivity,
  holdingStorage,
  macrotasks,
  nextId,
  observe,
  statusOf,
} from './terminal-in-flight-activity.test-support.ts';

/** A quick activity that arms the storage hold, then an activity that defers to `completeAsync()`. */
function deferringWorkflow(options: { readonly arm?: () => void } = {}) {
  const reached = createDeferred();
  const record = { ran: 0 };
  const quick = activity({
    name: 'quick',
    execute: async () => {
      options.arm?.();
      return 'quick-done';
    },
  });
  const awaitCallback = activity({
    name: 'awaitCallback',
    execute: (_input: void, context?: ActivityContext): unknown => {
      record.ran += 1;
      reached.resolve();
      return context!.completeAsync();
    },
  });
  const definition = workflow({ name: 'deferring-workflow' })
    .activities({ quick, awaitCallback })
    .execute(async function* (ctx: WorkflowContext) {
      yield* ctx.run(quick);
      return yield* ctx.run(awaitCallback);
    });
  return { definition, reached: reached.promise, record };
}

describe('a deferring activity never holds the result (COR-1597)', () => {
  it('a cancel during the checkpoint persist of an activity that then defers to async completion rejects its result promptly', async () => {
    const id = nextId('defer-persist');
    const holding = holdingStorage(id);
    await using engine = new Engine({ storage: holding.storage });
    const { definition, reached, record } = deferringWorkflow({ arm: holding.arm });
    engine.register(definition);
    const handle = await engine.start('deferring-workflow', null, { id });
    const result = observe(handle.result());
    await holding.held;
    expect(record.ran).toBe(0);

    await engine.cancel(id);
    expect(await statusOf(engine, id)).toBe('cancelled');
    holding.release();
    await reached;
    await macrotasks(5);

    expect(result.state).toBe('rejected');
    expect(result.reason).toEqual(new Error('Workflow cancelled'));
    expect(getInternals(engine).pendingTerminalSettlements.size).toBe(0);
  });

  it('a history-breaker termination inside the checkpoint of a deferring activity rejects its result promptly', async () => {
    const id = nextId('defer-breaker');
    await using engine = new Engine({ history: { maxEvents: 1 } });
    const { definition, reached, record } = deferringWorkflow();
    engine.register(definition);
    const handle = await engine.start('deferring-workflow', null, { id });
    const result = observe(handle.result());
    await reached;
    await macrotasks(5);

    expect(record.ran).toBe(1);
    expect(await statusOf(engine, id)).toBe('timed-out');
    expect(result.state).toBe('rejected');
    expect(result.reason).toBeInstanceOf(WorkflowTimeoutError);
    expect((result.reason as WorkflowTimeoutError).terminationReason).toBe(
      HISTORY_CIRCUIT_BREAKER_REASON,
    );
    expect(getInternals(engine).pendingTerminalSettlements.size).toBe(0);
  });
});

describe('a purge leaves a held result to its pending settlement (COR-1597)', () => {
  it('a first result() after a purge of the held run waits, then rejects with the committed terminal error', async () => {
    await using engine = new Engine();
    const { heldWorkflow, started, gate, record } = heldActivity();
    engine.register(heldWorkflow);
    const id = nextId('purge-before');
    const handle = await engine.start('held-workflow', null, { id });
    await started.promise;
    await engine.cancel(id);
    await engine.purge({ status: 'cancelled' });
    expect(await engine.get(id)).toBeNull();

    const result = observe(handle.result());
    await macrotasks(5);
    expect(result.state).toBe('pending');
    expect(record.completed).toBe(0);

    gate.resolve();
    await result.settled;

    expect(result.state).toBe('rejected');
    expect(result.reason).toEqual(new Error('Workflow cancelled'));
    expect(record.completed).toBe(1);
    expect(getInternals(engine).resultResolvers.has(id)).toBe(false);
    expect(getInternals(engine).pendingTerminalSettlements.size).toBe(0);
  });

  it('a purge after the first result() leaves the registered waiter pending, then rejects it once', async () => {
    await using engine = new Engine();
    const { heldWorkflow, started, gate, record } = heldActivity();
    engine.register(heldWorkflow);
    const id = nextId('purge-after');
    const handle = await engine.start('held-workflow', null, { id });
    const result = observe(handle.result());
    await started.promise;
    await engine.cancel(id);
    await engine.purge({ status: 'cancelled' });
    await macrotasks(5);

    expect(result.state).toBe('pending');
    expect(record.completed).toBe(0);

    gate.resolve();
    await result.settled;

    expect(result.state).toBe('rejected');
    expect(result.reason).toEqual(new Error('Workflow cancelled'));
    expect(record.completed).toBe(1);
    expect(getInternals(engine).resultResolvers.has(id)).toBe(false);
  });
});

describe('what a pending settlement may reject (COR-1597)', () => {
  it("a replacement whose replaced run had no waiter keeps its own waiter when the replaced run's turn ends", async () => {
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
      workflow({ name: 'replaceable-without-waiter' })
        .activities({ echo })
        .execute(async function* (ctx: WorkflowContext, input: string) {
          if (input === 'second') yield* ctx.waitForSignal('go');
          return yield* ctx.run(echo, input);
        }),
    );
    const id = nextId('replace-no-waiter');
    // No result() on the first run: the termination captures no waiter for it.
    await engine.start('replaceable-without-waiter', 'first', { id });
    await started.promise;
    await engine.cancel(id);
    const second = await engine.start('replaceable-without-waiter', 'second', {
      id,
      onTerminalConflict: 'start-new',
    });
    const secondResult = observe(second.result());
    await macrotasks(3);
    const replacementWaiter = getInternals(engine).resultResolvers.get(id);
    expect(replacementWaiter).toBeDefined();

    gate.resolve();
    await macrotasks(5);

    expect(getInternals(engine).resultResolvers.get(id)).toBe(replacementWaiter);
    expect(secondResult.state).toBe('pending');
    await engine.signal(id, 'go', null);
    await secondResult.settled;
    expect(secondResult.state).toBe('resolved');
  });

  it('cancelling a signal wait during its checkpoint persist rejects its result at once', async () => {
    const id = nextId('signal-persist');
    const holding = holdingStorage(id);
    await using engine = new Engine({ storage: holding.storage });
    const quick = activity({
      name: 'quick',
      execute: async () => {
        holding.arm();
        return 'quick-done';
      },
    });
    engine.register(
      workflow({ name: 'update-handler-after-quick' })
        .activities({ quick })
        .execute(async function* (ctx: WorkflowContext) {
          ctx.onUpdate('noop', () => 'ok');
          yield* ctx.run(quick);
          return yield* ctx.waitForSignal<string>('go');
        }),
    );
    const handle = await engine.start('update-handler-after-quick', null, { id });
    const result = observe(handle.result());
    await holding.held;
    // The write held is the signal wait's checkpoint: that turn is recorded and still in flight.
    expect(getInternals(engine).inFlightOperations.get(id)?.operation.type).toBe('wait-signal');

    await engine.cancel(id);
    await macrotasks(2);

    expect(result.state).toBe('rejected');
    expect(result.reason).toEqual(new Error('Workflow cancelled'));
    holding.release();
  });
});
