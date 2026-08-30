import { describe, expect, it } from 'bun:test';

import { sleepForTesting } from '../../testing/fake-timers.test-support.ts';
import { workflow } from '../types.ts';
import { UpdateTimeoutError } from '../updates.ts';
import { disposeEngine } from './disposal.ts';
import type { QueuedInlineWorkflowExecutionStart } from './engine-internal-types.ts';
import { EngineDisposedError } from './errors.ts';
import { Engine } from './index.ts';
import {
  dropQueuedInlineWorkflowStart,
  flushQueuedInlineWorkflowStarts,
  type InlineLaunchQueueCallbacks,
} from './inline-launch-queue.ts';
import { getInternals } from './internals.ts';

/**
 * Seed a queued inline start directly into engine internals with an `onStarted`
 * spy, so a test can drive the inline-launch-queue paths (skip, throw, abort,
 * dispose) that settle a `defer: false` awaiter without racing the public start
 * path. Returns the spy's fired-state accessor.
 */
function seedQueuedInlineStart(
  internals: ReturnType<typeof getInternals>,
  workflowId: string,
  checkpoint: QueuedInlineWorkflowExecutionStart['checkpoint'],
): { fired: () => boolean } {
  let settled = false;
  const queued: QueuedInlineWorkflowExecutionStart = {
    workflowId,
    workflowType: 'seeded',
    input: null,
    checkpoint,
    nestingDepth: 0,
    executionDeadline: undefined,
    executionStateOwnerId: workflowId,
    onStarted: () => {
      settled = true;
    },
  };
  // Drop any start already queued for this id (e.g. from a prior engine.start in
  // the same test) so the seeded entry is the only one — avoids a double-start
  // race with an already-scheduled flush.
  internals.queuedInlineWorkflowStarts = internals.queuedInlineWorkflowStarts.filter(
    (start) => start.workflowId !== workflowId,
  );
  internals.queuedInlineWorkflowStarts.push(queued);
  internals.queuedInlineWorkflowStartIds.add(workflowId);
  internals.queuedOrLaunchingInlineWorkflowStartIds.add(workflowId);
  return { fired: () => settled };
}

const noopInlineLaunchCallbacks: InlineLaunchQueueCallbacks = {
  processPendingUpdatesAfterInlineAdvance: async () => {},
  swallowPromiseRejection: async (promise) => {
    try {
      await promise;
    } catch {
      // Swallow, mirroring the production callback used by the drain path.
    }
  },
};

// `disposeEngine` was extracted verbatim from `Engine[Symbol.dispose]`. The
// broad engine test suite exercises disposal only *indirectly* (through
// `Engine[Symbol.dispose]` during teardown), so a broken delegation would not
// be caught at this level. These tests call `disposeEngine(internals)` directly
// and pin the teardown postconditions that the extraction must preserve.
describe('disposeEngine', () => {
  it('aborts the engine signal, clears waiter maps, and tears down channels', () => {
    const engine = new Engine();
    const internals = getInternals(engine);

    // Seed observable state so "cleared" is a real assertion, not a no-op.
    let signalWaiterResolved = false;
    internals.signalWaiters.set('wf-1', () => {
      signalWaiterResolved = true;
    });
    internals.signalWaitersByWorkflow.set('wf-1', new Set(['wf-1']));
    internals.handleCache.set('wf-1', {
      ref: new WeakRef({}),
    } as ReturnType<typeof internals.handleCache.get> & object);
    const abortedWebhook = new AbortController();
    internals.pendingWebhooks.add(abortedWebhook);

    expect(internals.abortController.signal.aborted).toBe(false);

    disposeEngine(internals);

    // Abort fired and pending signal waiters were resolved before clearing.
    expect(internals.abortController.signal.aborted).toBe(true);
    expect(signalWaiterResolved).toBe(true);
    expect(internals.signalWaiters.size).toBe(0);
    expect(internals.signalWaitersByWorkflow.size).toBe(0);

    // Caches cleared; pending webhooks aborted and cleared.
    expect(internals.handleCache.size).toBe(0);
    expect(abortedWebhook.signal.aborted).toBe(true);
    expect(internals.pendingWebhooks.size).toBe(0);

    // Long-lived references nulled.
    expect(internals.alertManager).toBeNull();
    expect(internals.activityWorkerDispatcher).toBeNull();
    expect(internals.broadcastChannel).toBeNull();
    expect(internals.retentionSweepInterval).toBeNull();
    expect(internals.nextRetentionSweepAt).toBeNull();
  });

  it('settles and clears sleep resolver readiness waiters', () => {
    const engine = new Engine();
    const internals = getInternals(engine);
    let notified = 0;
    internals.sleepResolverReadyWaitersForTesting?.set(
      'wf-sleep',
      new Set([
        () => {
          notified += 1;
        },
      ]),
    );

    disposeEngine(internals);

    expect(notified).toBe(1);
    expect(internals.sleepResolverReadyWaitersForTesting?.size).toBe(0);
  });

  it('rejects pending result waiters before clearing them so callers do not hang', async () => {
    const engine = new Engine();
    const internals = getInternals(engine);

    // Seed a pending result waiter exactly as handle.result() would: a
    // {promise, resolve, reject} whose promise is only settled on workflow
    // termination. Without the dispose fix this promise is cleared but never
    // settled, so an awaiting caller hangs forever.
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    internals.resultResolvers.set('wf-pending', { promise, resolve, reject });

    disposeEngine(internals);

    // The waiter map is cleared AND the pending promise was rejected (settled),
    // mirroring the signalWaiters precedent.
    expect(internals.resultResolvers.size).toBe(0);
    await expect(promise).rejects.toBeInstanceOf(EngineDisposedError);
  });

  it('makes handle.result() reject (not hang) when the engine is disposed mid-flight', async () => {
    const engine = new Engine();
    engine.register(
      workflow({ name: 'sleeper' }).execute(async function* (ctx) {
        yield* ctx.sleep('1h');
        return 'done';
      }),
    );

    const handle = await engine.start('sleeper', null);
    const resultPromise = handle.result();

    engine[Symbol.dispose]();

    // dispose() rejects the pending result waiter synchronously, so the promise
    // is already settled here. Without the fix the waiter map is cleared but the
    // promise is never settled, so this await would hang and the test times out.
    await expect(resultPromise).rejects.toBeInstanceOf(EngineDisposedError);
  });

  it('rejects every pending result waiter when several workflows are in flight', async () => {
    const engine = new Engine();
    const internals = getInternals(engine);

    // Capture each waiter's settlement with a handler attached up front, before
    // dispose rejects them. disposeEngine rejects all three synchronously;
    // awaiting them sequentially would leave the later rejected promises
    // momentarily unhandled and could trip an unhandled-rejection warning.
    const outcomes = ['wf-1', 'wf-2', 'wf-3'].map((workflowId) => {
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();
      internals.resultResolvers.set(workflowId, { promise, resolve, reject });
      return promise.then(
        () => ({ rejected: false as const, error: undefined as unknown }),
        (error: unknown) => ({ rejected: true as const, error }),
      );
    });

    disposeEngine(internals);

    expect(internals.resultResolvers.size).toBe(0);
    const settled = await Promise.all(outcomes);
    for (const outcome of settled) {
      expect(outcome.rejected).toBe(true);
      expect(outcome.error).toBeInstanceOf(EngineDisposedError);
    }
  });

  it('rejects handle.result() called after the engine is already disposed', async () => {
    const engine = new Engine();
    engine.register(
      workflow({ name: 'sleeper-after' }).execute(async function* (ctx) {
        yield* ctx.sleep('1h');
        return 'done';
      }),
    );
    const handle = await engine.start('sleeper-after', null);

    engine[Symbol.dispose]();

    // The waiter map is empty post-dispose, so without the `disposed` guard this
    // would register a fresh waiter the torn-down engine never settles.
    await expect(handle.result()).rejects.toBeInstanceOf(EngineDisposedError);
  });

  it('keeps a resolved handle result cached across dispose', async () => {
    const engine = new Engine();
    engine.register(
      workflow({ name: 'quick' }).execute(async function* () {
        return 'finished';
      }),
    );
    const handle = await engine.start('quick', null);
    // Settle the result first; the waiter is resolved and removed from the map.
    await expect(handle.result()).resolves.toBe('finished');

    engine[Symbol.dispose]();

    // `handle.result()` memoizes its promise (`#resultPromise ??= ...`), so this
    // second call on the SAME handle returns the cached resolved value and never
    // re-enters the disposed guard. A handle that already produced a result
    // keeps it across dispose.
    await expect(handle.result()).resolves.toBe('finished');
  });

  it('rejects a fresh handle result() after dispose even for a completed workflow', async () => {
    const engine = new Engine();
    engine.register(
      workflow({ name: 'quick-fresh' }).execute(async function* () {
        return 'finished';
      }),
    );
    const started = await engine.start('quick-fresh', null, { defer: false });
    await started.result();

    engine[Symbol.dispose]();

    // A FRESH handle (no cached #resultPromise) routes through the disposed
    // guard. A disposed engine rejects new result() calls — the normal
    // Symbol.dispose contract (a disposed resource throws on use), rather than
    // reaching back into storage for a completed result.
    const freshHandle = engine.getHandle('quick-fresh');
    await expect(freshHandle.result()).rejects.toBeInstanceOf(EngineDisposedError);
  });

  it('leaves external update callers bounded by their own timeout, not EngineDisposedError', async () => {
    // Pins the deliberate asymmetry: update/review waiters are NOT settled by
    // dispose (they are internal generator wait-frames). External update callers
    // must surface their own response timeout rather than hang or observe
    // EngineDisposedError.
    const engine = new Engine();
    engine.register(
      workflow({ name: 'never-handles-update' }).execute(async function* (ctx) {
        yield* ctx.sleep('1h');
        return 'done';
      }),
    );
    const handle = await engine.start('never-handles-update', null);

    const updatePromise = handle.update('noop', null, { timeout: 50 }).then(
      () => ({ outcome: 'resolved' as const }),
      (error: unknown) => ({ outcome: 'rejected' as const, error }),
    );

    engine[Symbol.dispose]();

    const settled = await updatePromise;
    expect(settled.outcome).toBe('rejected');
    if (settled.outcome === 'rejected') {
      // Bounded by the update's own response timeout, NOT settled by dispose.
      expect(settled.error).toBeInstanceOf(UpdateTimeoutError);
      expect(settled.error).not.toBeInstanceOf(EngineDisposedError);
    }
  });

  it('is idempotent — a second dispose does not throw', () => {
    const engine = new Engine();
    const internals = getInternals(engine);

    disposeEngine(internals);
    expect(() => disposeEngine(internals)).not.toThrow();
    expect(internals.abortController.signal.aborted).toBe(true);
  });

  it('is the path Engine[Symbol.dispose] delegates to', () => {
    // Guards the delegation: disposing through the public surface must reach the
    // same teardown (abort signal set, caches cleared).
    const engine = new Engine();
    const internals = getInternals(engine);
    internals.handleCache.set('wf-1', {
      ref: new WeakRef({}),
    } as ReturnType<typeof internals.handleCache.get> & object);

    engine[Symbol.dispose]();

    expect(internals.abortController.signal.aborted).toBe(true);
    expect(internals.handleCache.size).toBe(0);
  });

  it('clears per-run services on dispose so credential-bearing closures do not leak', async () => {
    // A run that never reaches a terminal state keeps its `services` entry live
    // (terminal cleanup is the only other path that deletes it). Disposing the
    // engine with such an in-flight run must release the services map so an
    // abandoned run cannot strand a live credential-bearing closure in memory.
    const engine = new Engine();
    engine.register(
      workflow({ name: 'holds-services' }).execute(async function* (ctx) {
        yield* ctx.sleep('1h');
        return 'done';
      }),
    );

    const secret = { token: 'super-secret', revoke: () => undefined };
    const handle = await engine.start('holds-services', null, { id: 'leaky', services: secret });
    const internals = getInternals(engine);

    // The in-flight run holds its services entry until it terminates.
    expect(internals.workflowServices.has('leaky')).toBe(true);

    engine[Symbol.dispose]();

    // Dispose releases every retained services value, not just terminal ones.
    expect(internals.workflowServices.size).toBe(0);
    void handle;
  });
});

describe('defer:false synchronous launch', () => {
  it('resolves only after the inline workflow has actually begun executing', async () => {
    // The default (deferred) launch returns a handle as soon as the initial
    // state is persisted, before the inline-launch macrotask runs the generator.
    // `defer: false` must instead resolve only once execution has begun, so a
    // caller can rely on the run being live without a macrotask round-trip.
    const engine = new Engine();
    let bodyEntered = false;
    engine.register(
      workflow({ name: 'defer-false' }).execute(async function* (ctx) {
        bodyEntered = true;
        yield* ctx.sleep('1h');
        return 'done';
      }),
    );

    await engine.start('defer-false', null, { id: 'eager', defer: false });

    // With defer:false the start await does not return until the body has run
    // its first synchronous statement (execution began).
    expect(bodyEntered).toBe(true);
    engine[Symbol.dispose]();
  });

  it('default deferred launch returns before the inline body runs', async () => {
    // Pins the contrast: without defer:false, start resolves before the queued
    // inline macrotask drives the generator, so the body has not yet entered.
    const engine = new Engine();
    let bodyEntered = false;
    engine.register(
      workflow({ name: 'defer-true' }).execute(async function* (ctx) {
        bodyEntered = true;
        yield* ctx.sleep('1h');
        return 'done';
      }),
    );

    await engine.start('defer-true', null, { id: 'lazy' });

    expect(bodyEntered).toBe(false);
    // Yield one scheduler turn so the queued inline launch flushes, proving the
    // run is otherwise healthy. (With real timers, sleepForTesting yields a
    // single minimal turn regardless of the argument; 1 makes that intent clear.)
    await sleepForTesting(1);
    expect(bodyEntered).toBe(true);
    engine[Symbol.dispose]();
  });

  it('rejects defer:false under worker execution mode', async () => {
    // defer:false is an inline-only liveness gate; a worker-mode start queues to
    // the Worker transport and cannot be awaited for inline liveness. Mirror how
    // `services` already throws under worker mode rather than silently no-op.
    const engine = new Engine({
      workflowExecutionMode: 'worker',
      workerExecution: {
        workerUrl: new URL('../../workers/test-browser-worker.ts', import.meta.url),
        poolSize: 1,
      },
    });
    engine.register(
      workflow({ name: 'worker-defer' }).execute(async function* () {
        return 'done';
      }),
    );

    await expect(engine.start('worker-defer', null, { defer: false })).rejects.toThrow(
      /defer.*inline|inline.*defer/i,
    );
    await engine[Symbol.asyncDispose]();
  });

  it('rejects defer:false combined with a delayed start', async () => {
    // A delayed start (startAfter/startAt) has not begun executing, so there is
    // no inline liveness to await. defer:false must reject rather than silently
    // behave like defer:true and resolve before the scheduled run is live.
    const engine = new Engine();
    engine.register(
      workflow({ name: 'delayed-defer' }).execute(async function* () {
        return 'done';
      }),
    );

    await expect(
      engine.start('delayed-defer', null, { defer: false, startAfter: '1h' }),
    ).rejects.toThrow(/delayed start|startAt|startAfter/i);
    engine[Symbol.dispose]();
  });
});

describe('dropQueuedInlineWorkflowStart settles defer:false awaiters', () => {
  it('fires onStarted for a queued start dropped before it runs', () => {
    // Regression: a workflow cancelled/terminated while its inline start is still
    // queued is removed via dropQueuedInlineWorkflowStart (from termination). If
    // that drop does not fire the start's onStarted callback, a defer:false
    // caller awaiting liveness hangs forever. This pins that the drop settles it.
    const engine = new Engine();
    const internals = getInternals(engine);

    let settled = false;
    const queued: QueuedInlineWorkflowExecutionStart = {
      workflowId: 'cancelled-while-queued',
      workflowType: 'whatever',
      input: null,
      // The checkpoint shape is irrelevant to drop — it is filtered by id before
      // ever being read, so a minimal stand-in is sufficient for this unit.
      checkpoint: {} as QueuedInlineWorkflowExecutionStart['checkpoint'],
      nestingDepth: 0,
      executionDeadline: undefined,
      executionStateOwnerId: 'cancelled-while-queued',
      onStarted: () => {
        settled = true;
      },
    };
    internals.queuedInlineWorkflowStarts.push(queued);
    internals.queuedInlineWorkflowStartIds.add(queued.workflowId);
    internals.queuedOrLaunchingInlineWorkflowStartIds.add(queued.workflowId);

    const dropped = dropQueuedInlineWorkflowStart(internals, 'cancelled-while-queued');

    expect(dropped).toBe(true);
    // The dropped start's liveness callback fired, so a defer:false awaiter
    // resolves instead of hanging on a run that will never become live.
    expect(settled).toBe(true);
    expect(internals.queuedInlineWorkflowStarts.length).toBe(0);
    engine[Symbol.dispose]();
  });
});

describe('onStarted fires on every flush terminal path', () => {
  it('fires onStarted when the queued start is skipped because state is not running', async () => {
    // loadWorkflowState returns null for a workflowId with no persisted state, so
    // startQueuedInlineWorkflowExecution returns early — but the finally block
    // must still fire onStarted, or a defer:false awaiter hangs on a run that was
    // cancelled/terminated between queueing and flush.
    const engine = new Engine();
    const internals = getInternals(engine);
    const seeded = seedQueuedInlineStart(
      internals,
      'no-persisted-state',
      {} as QueuedInlineWorkflowExecutionStart['checkpoint'],
    );

    await flushQueuedInlineWorkflowStarts(internals, noopInlineLaunchCallbacks);

    expect(seeded.fired()).toBe(true);
    engine[Symbol.dispose]();
  });

  it('fires onStarted when starting the queued workflow throws', async () => {
    // A malformed checkpoint makes startWorkflowExecution throw inside the try.
    // The finally block must still fire onStarted so a defer:false awaiter
    // settles after a launch failure instead of hanging. The flush itself must
    // not reject (production wraps it in swallowPromiseRejection).
    const engine = new Engine();
    engine.register(
      workflow({ name: 'seeded' }).execute(async function* () {
        return 'done';
      }),
    );
    const internals = getInternals(engine);
    // Persist a running state so the skip-path guard passes and execution is
    // attempted, then hand a checkpoint stand-in that startWorkflowExecution
    // cannot consume, forcing a throw inside the try.
    const real = await engine.start('seeded', null, { id: 'will-throw' });
    void real;
    const seeded = seedQueuedInlineStart(
      internals,
      'will-throw',
      null as unknown as QueuedInlineWorkflowExecutionStart['checkpoint'],
    );

    await noopInlineLaunchCallbacks.swallowPromiseRejection(
      flushQueuedInlineWorkflowStarts(internals, noopInlineLaunchCallbacks),
    );

    expect(seeded.fired()).toBe(true);
    engine[Symbol.dispose]();
  });

  it('fires onStarted for every start in a batch even when an earlier one throws', async () => {
    // Per-iteration fault isolation: if the first queued start throws during
    // flush, the throw must not abandon the rest of the batch. The whole batch is
    // removed from the queue before iterating, so an escaping throw would leave
    // later starts' onStarted unfired forever — hanging their defer:false
    // awaiters. Both starts' liveness callbacks must fire.
    const engine = new Engine();
    engine.register(
      workflow({ name: 'seeded' }).execute(async function* () {
        return 'done';
      }),
    );
    const internals = getInternals(engine);
    // First start: persisted running state but a checkpoint stand-in that makes
    // execution throw. Second start: no persisted state, takes the skip path.
    const throwing = await engine.start('seeded', null, { id: 'batch-throws' });
    void throwing;
    const first = seedQueuedInlineStart(
      internals,
      'batch-throws',
      null as unknown as QueuedInlineWorkflowExecutionStart['checkpoint'],
    );
    const second = seedQueuedInlineStart(
      internals,
      'batch-skipped',
      {} as QueuedInlineWorkflowExecutionStart['checkpoint'],
    );

    await flushQueuedInlineWorkflowStarts(internals, noopInlineLaunchCallbacks);

    // Both fired despite the first start throwing — the loop isolated the fault.
    expect(first.fired()).toBe(true);
    expect(second.fired()).toBe(true);
    engine[Symbol.dispose]();
  });

  it('settles a defer:false awaiter when the engine is disposed before flush', async () => {
    // The abort early-return in flushQueuedInlineWorkflowStarts (reached when a
    // post-dispose macrotask fires) must discard the queue AND fire onStarted, or
    // a defer:false awaiter behind it hangs forever on the aborted engine.
    const engine = new Engine();
    const internals = getInternals(engine);
    const seeded = seedQueuedInlineStart(
      internals,
      'aborted-before-flush',
      {} as QueuedInlineWorkflowExecutionStart['checkpoint'],
    );

    // Abort the engine (as dispose does), then run the flush — it hits the
    // abort early-return path.
    internals.abortController.abort();
    await flushQueuedInlineWorkflowStarts(internals, noopInlineLaunchCallbacks);

    expect(seeded.fired()).toBe(true);
    expect(internals.queuedInlineWorkflowStarts.length).toBe(0);
    // The membership indexes must not still claim the discarded start, or
    // isInlineWorkflowLocallyOwned would report a torn-down run as live.
    expect(internals.queuedInlineWorkflowStartIds.has('aborted-before-flush')).toBe(false);
    expect(internals.queuedOrLaunchingInlineWorkflowStartIds.has('aborted-before-flush')).toBe(
      false,
    );
    engine[Symbol.dispose]();
  });
});

describe('drain pending inline launches on asyncDispose', () => {
  it('completes synchronous disposal even when a queued start rejects mid-drain', async () => {
    // If the drain rejects (e.g. a storage error loading a queued start), the
    // asyncDispose try/finally must still run synchronous disposal, or the engine
    // is left half-disposed: abort un-fired, awaiters hung, channels open.
    const engine = new Engine();
    const internals = getInternals(engine);
    // Seed a start whose flush will reject: stub the storage read to throw, so
    // startQueuedInlineWorkflowExecution propagates an error the drain swallows.
    seedQueuedInlineStart(
      internals,
      'rejects-mid-drain',
      {} as QueuedInlineWorkflowExecutionStart['checkpoint'],
    );
    const originalGet = internals.storage.get.bind(internals.storage);
    internals.storage.get = async () => {
      throw new Error('storage exploded during drain');
    };

    // asyncDispose must resolve (not reject) and fully dispose despite the error.
    await engine[Symbol.asyncDispose]();

    expect(internals.disposed).toBe(true);
    expect(internals.abortController.signal.aborted).toBe(true);
    expect(internals.queuedInlineWorkflowStarts.length).toBe(0);
    internals.storage.get = originalGet;
  });

  it('is safe to call [Symbol.asyncDispose] after a synchronous dispose', async () => {
    // The already-disposed guard skips the drain and just re-runs (idempotent)
    // synchronous dispose. Mixing `dispose()` then `await asyncDispose()` must
    // resolve cleanly rather than re-draining a torn-down engine.
    const engine = new Engine();
    engine[Symbol.dispose]();

    await engine[Symbol.asyncDispose]();

    expect(getInternals(engine).disposed).toBe(true);
  });

  it('flushes queued inline starts before [Symbol.asyncDispose] returns', async () => {
    // A deferred start leaves a queued inline launch on a setTimeout(0)
    // macrotask. asyncDispose must drain that queue before returning, so a
    // disposed engine has no dangling macrotask that could starve a test
    // runner's event loop or execute against torn-down state.
    const engine = new Engine();
    let bodyEntered = false;
    engine.register(
      workflow({ name: 'drained' }).execute(async function* (ctx) {
        bodyEntered = true;
        yield* ctx.sleep('1h');
        return 'done';
      }),
    );

    await engine.start('drained', null, { id: 'pending' });
    const internals = getInternals(engine);
    // The start is queued but the inline macrotask has not run yet.
    expect(internals.queuedInlineWorkflowStarts.length).toBeGreaterThan(0);
    expect(bodyEntered).toBe(false);

    await engine[Symbol.asyncDispose]();

    // After asyncDispose the queued start was actually *drained* — the body ran —
    // not merely discarded. This distinguishes a real drain from the old behavior
    // where dispose emptied the queue without executing the pending launch. The
    // queue is empty and the engine is disposed with no dangling macrotask left.
    expect(bodyEntered).toBe(true);
    expect(internals.queuedInlineWorkflowStarts.length).toBe(0);
    expect(internals.disposed).toBe(true);
  });
});
