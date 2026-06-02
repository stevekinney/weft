import { describe, expect, it } from 'bun:test';

import { workflow } from '../types.ts';
import { disposeEngine, EngineDisposedError } from './disposal.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';

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
      ref: new WeakRef({} as object),
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
      ref: new WeakRef({} as object),
    } as ReturnType<typeof internals.handleCache.get> & object);

    engine[Symbol.dispose]();

    expect(internals.abortController.signal.aborted).toBe(true);
    expect(internals.handleCache.size).toBe(0);
  });
});
