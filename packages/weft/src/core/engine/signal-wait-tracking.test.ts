/**
 * COR-1472: `WorkflowState.waitingForSignals` lists the signals a running
 * workflow is parked on, durably, and `signal:waiting` announces each listing.
 *
 * These cover the lifecycle on `MemoryStorage`: when a name is listed, when it
 * is not (a signal already buffered), and each way a listed wait ends. The
 * restart matrix across storage backends lives in
 * `signal-wait-restart.test.ts`, and the Worker-mode restart in
 * `signal-wait-worker-restart.slow.test.ts`.
 */
import { afterEach, describe, expect, it, jest } from 'bun:test';

import { type BatchOperation, MemoryStorage } from "../../embedded/storage/src/index.ts";
import { restoreRealTimers, useFakeTimers } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { KEYS } from '../../storage/keys.ts';
import { decode, encode } from '../codec.ts';
import { SignalDeliveredEvent, SignalWaitingEvent } from '../events.ts';
import { workflow, type WorkflowContext, type WorkflowState } from '../types.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { withoutSignalWaits } from './signal-wait-state.ts';
import {
  nextSignalWaiting,
  recordSignalWaitingEvents,
  settleWorkflowStateWrites,
  waitingForSignalsOf,
} from './signal-wait-tracking.test-support.ts';
import {
  captureSignalWaitRun,
  clearSignalWait,
  recordSignalWaitBegan,
} from './signal-wait-tracking.ts';
import { decodeWorkflowState } from './validation.ts';

const approvalThenAfter = workflow({ name: 'approval-then-after' }).execute(async function* (
  ctx: WorkflowContext,
) {
  const approval = yield* ctx.waitForSignal<string>('approval');
  const after = yield* ctx.waitForSignal<string>('after');
  return { approval, after };
});

const twoConcurrentWaits = workflow({ name: 'two-concurrent-waits' }).execute(async function* (
  ctx: WorkflowContext,
) {
  return yield* ctx.all([ctx.waitForSignal<string>('first'), ctx.waitForSignal<string>('second')]);
});

const approvalOrTimeout = workflow({ name: 'approval-or-timeout' }).execute(async function* (
  ctx: WorkflowContext,
) {
  const outcome = yield* ctx.race([ctx.waitForSignal<string>('approval'), ctx.sleep('1h')]);
  const after = yield* ctx.waitForSignal<string>('after');
  return { outcome: outcome ?? 'timed-out', after };
});

/** Handles updates, so the engine cannot park it and waits through a live waiter instead. */
const handlerApprovalThenAfter = workflow({ name: 'handler-approval-then-after' }).execute(
  async function* (ctx: WorkflowContext) {
    ctx.onUpdate('noop', () => 'ok');
    const approval = yield* ctx.waitForSignal<string>('approval');
    const after = yield* ctx.waitForSignal<string>('after');
    return { approval, after };
  },
);

/** Holds before its wait until the test releases it, so a signal can be buffered first. */
let releaseGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
const gatedApproval = workflow({ name: 'gated-approval' })
  .activities({ gate: async () => releaseGate.promise })
  .execute(async function* (ctx: WorkflowContext) {
    yield* ctx.run('gate');
    return yield* ctx.waitForSignal<string>('approval');
  });

const workflows = [
  approvalThenAfter,
  twoConcurrentWaits,
  approvalOrTimeout,
  handlerApprovalThenAfter,
  gatedApproval,
];

function createEngine(storage = new MemoryStorage(), getNow?: () => number): Engine {
  const engine = new Engine({ storage, ...(getNow === undefined ? {} : { getNow }) });
  for (const definition of workflows) engine.register(definition);
  return engine;
}

afterEach(() => {
  restoreRealTimers();
  releaseGate = Promise.withResolvers<void>();
});

describe('waitingForSignals while a workflow is parked', () => {
  it('lists the awaited signal and announces it once with its workflow and name', async () => {
    await using engine = createEngine();
    const events = recordSignalWaitingEvents(engine);
    const waiting = nextSignalWaiting(engine, 'parked-1', 'approval');

    await engine.start('approval-then-after', null, { id: 'parked-1' });
    const event = await waiting;

    expect(event).toBeInstanceOf(SignalWaitingEvent);
    expect(event.type).toBe('signal:waiting');
    expect({ workflowId: event.workflowId, signalName: event.signalName }).toEqual({
      workflowId: 'parked-1',
      signalName: 'approval',
    });
    expect(await waitingForSignalsOf(engine, 'parked-1')).toEqual(['approval']);
    expect(events).toHaveLength(1);
  });

  it('is absent before any wait and after the workflow completes', async () => {
    await using engine = createEngine();
    const handle = await engine.start('approval-then-after', null, { id: 'parked-absent' });
    await nextSignalWaiting(engine, 'parked-absent', 'approval');

    await engine.signal('parked-absent', 'approval', 'yes');
    await nextSignalWaiting(engine, 'parked-absent', 'after');
    await engine.signal('parked-absent', 'after', 'done');

    expect(await handle.result()).toEqual({ approval: 'yes', after: 'done' });
    const state = await engine.get('parked-absent');
    expect(state?.status).toBe('completed');
    expect(state !== null && 'waitingForSignals' in state).toBe(false);
  });

  it('lists two concurrent waits in the order they began and removes only the delivered one', async () => {
    await using engine = createEngine();
    const events = recordSignalWaitingEvents(engine);
    const first = nextSignalWaiting(engine, 'concurrent-1', 'first');
    const second = nextSignalWaiting(engine, 'concurrent-1', 'second');

    const handle = await engine.start('two-concurrent-waits', null, { id: 'concurrent-1' });
    await Promise.all([first, second]);

    const began = events.map((event) => event.signalName);
    expect(began.toSorted()).toEqual(['first', 'second']);
    expect(await waitingForSignalsOf(engine, 'concurrent-1')).toEqual(began);

    await engine.signal('concurrent-1', 'first', 'one');
    await settleWorkflowStateWrites(engine, 'concurrent-1');
    expect(await waitingForSignalsOf(engine, 'concurrent-1')).toEqual(['second']);

    await engine.signal('concurrent-1', 'second', 'two');
    expect(await handle.result()).toEqual(['one', 'two']);
    expect(await waitingForSignalsOf(engine, 'concurrent-1')).toBeUndefined();
  });

  it('records the wait through a live waiter when the workflow handles updates', async () => {
    await using engine = createEngine();
    const handle = await engine.start('handler-approval-then-after', null, { id: 'handler-1' });
    await nextSignalWaiting(engine, 'handler-1', 'approval');
    expect(await waitingForSignalsOf(engine, 'handler-1')).toEqual(['approval']);

    const after = nextSignalWaiting(engine, 'handler-1', 'after');
    await engine.signal('handler-1', 'approval', 'yes');
    await after;
    expect(await waitingForSignalsOf(engine, 'handler-1')).toEqual(['after']);

    await engine.signal('handler-1', 'after', 'done');
    expect(await handle.result()).toEqual({ approval: 'yes', after: 'done' });
  });
});

describe('a signal buffered before the wait begins', () => {
  it('completes the wait at once, is never listed, and emits no signal:waiting', async () => {
    const storage = new MemoryStorage();
    const listedWrites: string[][] = [];
    const batch = storage.batch.bind(storage);
    storage.batch = async (operations: BatchOperation[]) => {
      recordListedWrites(operations, listedWrites);
      return await batch(operations);
    };
    const conditionalBatch = storage.conditionalBatch.bind(storage);
    storage.conditionalBatch = async (conditions, operations) => {
      recordListedWrites(operations, listedWrites);
      return await conditionalBatch(conditions, operations);
    };
    await using engine = createEngine(storage);
    const events = recordSignalWaitingEvents(engine);

    const handle = await engine.start('gated-approval', null, { id: 'buffered-1' });
    await engine.signal('buffered-1', 'approval', 'early');
    releaseGate.resolve();

    expect(await handle.result()).toBe('early');
    expect(events).toEqual([]);
    expect(listedWrites).toEqual([]);
  });
});

describe('a listed wait ends', () => {
  it('when its signal is delivered', async () => {
    await using engine = createEngine();
    const delivered: SignalDeliveredEvent[] = [];
    engine.addEventListener(SignalDeliveredEvent.type, (event) => {
      if (event instanceof SignalDeliveredEvent) delivered.push(event);
    });
    await engine.start('approval-then-after', null, { id: 'ends-delivery' });
    await nextSignalWaiting(engine, 'ends-delivery', 'approval');

    const after = nextSignalWaiting(engine, 'ends-delivery', 'after');
    await engine.signal('ends-delivery', 'approval', 'yes');
    await after;

    expect(await waitingForSignalsOf(engine, 'ends-delivery')).toEqual(['after']);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ workflowId: 'ends-delivery', signalName: 'approval' });
  });

  it('when the workflow is cancelled', async () => {
    await using engine = createEngine();
    const handle = await engine.start('approval-then-after', null, { id: 'ends-cancel' });
    const settled = handle.result().catch((error: unknown) => error);
    await nextSignalWaiting(engine, 'ends-cancel', 'approval');

    await engine.cancel('ends-cancel');
    await settled;

    const state = await engine.get('ends-cancel');
    expect(state?.status).toBe('cancelled');
    expect(state?.waitingForSignals).toBeUndefined();
  });

  it('when the workflow times out', async () => {
    let now = 1_000;
    await using engine = createEngine(new MemoryStorage(), () => now);
    const handle = await engine.start('approval-then-after', null, {
      id: 'ends-timeout',
      executionTimeout: 5_000,
    });
    const settled = handle.result().catch((error: unknown) => error);
    await nextSignalWaiting(engine, 'ends-timeout', 'approval');

    now = 7_000;
    await engine.scheduler.tick(now);
    await settled;

    const state = await engine.get('ends-timeout');
    expect(state?.status).toBe('timed-out');
    expect(state?.waitingForSignals).toBeUndefined();
  });

  it('when the race it waits in times out first', async () => {
    useFakeTimers(0);
    await using engine = createEngine();
    const handle = await engine.start('approval-or-timeout', null, { id: 'ends-race' });
    await nextSignalWaiting(engine, 'ends-race', 'approval');
    expect(await waitingForSignalsOf(engine, 'ends-race')).toEqual(['approval']);

    const after = nextSignalWaiting(engine, 'ends-race', 'after');
    jest.advanceTimersByTime(60 * 60 * 1_000);
    await after;
    expect(await waitingForSignalsOf(engine, 'ends-race')).toEqual(['after']);

    await engine.signal('ends-race', 'after', 'done');
    expect(await handle.result()).toEqual({ outcome: 'timed-out', after: 'done' });
  });

  it('when the workflow is suspended, and resume lists it again', async () => {
    await using engine = createEngine();
    await engine.start('approval-then-after', null, { id: 'ends-suspend' });
    await nextSignalWaiting(engine, 'ends-suspend', 'approval');

    await engine.suspend('ends-suspend');
    const suspended = await engine.get('ends-suspend');
    expect(suspended?.status).toBe('suspended');
    expect(suspended?.waitingForSignals).toBeUndefined();

    const relisted = nextSignalWaiting(engine, 'ends-suspend', 'approval');
    await engine.resume('ends-suspend');
    await relisted;
    expect(await waitingForSignalsOf(engine, 'ends-suspend')).toEqual(['approval']);
  });
});

describe('the signal-wait bookkeeping', () => {
  it('leaves the record alone when it is gone, belongs to another run, or is not running', async () => {
    await using engine = createEngine();
    const internals = getInternals(engine);
    await recordSignalWaitBegan(internals, 'missing', undefined, 'approval', () => true);
    expect(await engine.storage.get(KEYS.workflow('missing'))).toBeNull();

    await engine.start('approval-then-after', null, { id: 'bookkeeping-run' });
    await nextSignalWaiting(engine, 'bookkeeping-run', 'approval');
    const run = captureSignalWaitRun(internals, 'bookkeeping-run');
    const key = KEYS.workflow('bookkeeping-run');
    const runBytes = await engine.storage.get(key);
    if (runBytes === null) throw new Error('expected the running record');
    const replacement = { ...decodeWorkflowState(runBytes), workflowExecutionToken: 'other-run' };
    await engine.storage.put(key, encode(replacement));
    await clearSignalWait(internals, 'bookkeeping-run', run, 'approval');
    expect(await waitingForSignalsOf(engine, 'bookkeeping-run')).toEqual(['approval']);
    await engine.storage.put(key, runBytes);

    await engine.cancel('bookkeeping-run');
    await recordSignalWaitBegan(internals, 'bookkeeping-run', run, 'late', () => true);
    expect(await waitingForSignalsOf(engine, 'bookkeeping-run')).toBeUndefined();
  });

  it('decides again when another write changes the record between its read and its commit', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await engine.start('approval-then-after', null, { id: 'bookkeeping-race' });
    await nextSignalWaiting(engine, 'bookkeeping-race', 'approval');

    const conditionalBatch = storage.conditionalBatch.bind(storage);
    let interleavedWrites = 1;
    storage.conditionalBatch = async (conditions, operations) => {
      if (interleavedWrites > 0) {
        interleavedWrites -= 1;
        await touchWorkflowRecord(storage, 'bookkeeping-race', ['interleaved']);
      }
      return await conditionalBatch(conditions, operations);
    };

    const internals = getInternals(engine);
    await clearSignalWait(
      internals,
      'bookkeeping-race',
      captureSignalWaitRun(internals, 'bookkeeping-race'),
      'approval',
    );
    const state = await engine.get('bookkeeping-race');
    expect(state?.tags).toEqual(['interleaved']);
    expect(state?.waitingForSignals).toBeUndefined();
  });

  it('gives up without throwing when every attempt loses its race or storage fails', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await engine.start('approval-then-after', null, { id: 'bookkeeping-give-up' });
    await nextSignalWaiting(engine, 'bookkeeping-give-up', 'approval');
    const internals = getInternals(engine);
    const run = captureSignalWaitRun(internals, 'bookkeeping-give-up');

    const conditionalBatch = storage.conditionalBatch.bind(storage);
    let touches = 0;
    storage.conditionalBatch = async (conditions, operations) => {
      touches += 1;
      await touchWorkflowRecord(storage, 'bookkeeping-give-up', [`touch-${String(touches)}`]);
      return await conditionalBatch(conditions, operations);
    };
    await clearSignalWait(internals, 'bookkeeping-give-up', run, 'approval');
    expect(await waitingForSignalsOf(engine, 'bookkeeping-give-up')).toEqual(['approval']);
    storage.conditionalBatch = conditionalBatch;

    const get = storage.get.bind(storage);
    storage.get = async () => {
      throw new Error('storage unavailable');
    };
    await clearSignalWait(internals, 'bookkeeping-give-up', run, 'approval');
    storage.get = get;
    expect(await waitingForSignalsOf(engine, 'bookkeeping-give-up')).toEqual(['approval']);
  });

  it('strips the list from a record and drops a malformed persisted list on decode', () => {
    const state = {
      id: 'decode-1',
      type: 'approval-then-after',
      status: 'running',
      input: null,
      versionTuple: { workflowVersion: '1' },
      createdAt: 0,
      updatedAt: 0,
    } satisfies WorkflowState;
    expect(withoutSignalWaits(state)).toBe(state);
    expect(withoutSignalWaits({ ...state, waitingForSignals: ['approval'] })).toEqual(state);

    expect(
      decodeWorkflowState(encode({ ...state, waitingForSignals: ['a', 'b'] })).waitingForSignals,
    ).toEqual(['a', 'b']);
    for (const malformed of [[], ['a', 'a'], ['a', 1], 'approval']) {
      expect(
        decodeWorkflowState(encode({ ...state, waitingForSignals: malformed })).waitingForSignals,
      ).toBeUndefined();
    }
  });
});

/** Collect the `waitingForSignals` of every workflow record a batch writes. */
function recordListedWrites(operations: readonly BatchOperation[], listed: string[][]): void {
  for (const operation of operations) {
    if (operation.type !== 'put' || !operation.key.startsWith('wf:')) continue;
    const value: unknown = decode(operation.value);
    if (typeof value !== 'object' || value === null || !('waitingForSignals' in value)) continue;
    listed.push(value.waitingForSignals as string[]);
  }
}

/** Rewrite a workflow record's tags directly, as another engine's write would. */
async function touchWorkflowRecord(
  storage: MemoryStorage,
  workflowId: string,
  tags: string[],
): Promise<void> {
  const bytes = await storage.get(KEYS.workflow(workflowId));
  if (bytes === null) throw new Error(`expected a record for ${workflowId}`);
  await storage.put(KEYS.workflow(workflowId), encode({ ...decodeWorkflowState(bytes), tags }));
}

describe('waitingForSignals on a storage that cannot condition a write', () => {
  it('records the next wait without a fence on the stored record', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await engine.start('approval-then-after', null, { id: 'unconditional-1' });
    await nextSignalWaiting(engine, 'unconditional-1', 'approval');
    storage.capabilities = () => ({
      ...MemoryStorage.prototype.capabilities.call(storage),
      conditionalBatch: false,
    });

    const next = nextSignalWaiting(engine, 'unconditional-1', 'after');
    await engine.signal('unconditional-1', 'approval', 'yes');
    await next;

    expect(await waitingForSignalsOf(engine, 'unconditional-1')).toEqual(['after']);
  });
});
