import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../storage/memory.ts';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';
import { Engine } from './engine.ts';
import type { WorkflowContext } from './types/workflow-context.ts';
import { workflow } from './types/workflow-function.ts';

/**
 * Engine-level tests for `ctx.waitUntil(predicate, timeout?)`. These run real
 * workflows so they prove the dedicated `wait-condition` engine op, the inline
 * `onUpdate` re-drive hook, the deterministic deadline timer, and the
 * recovery-consistency property (the predicate outcome and the state that
 * justified it survive or revert together).
 *
 * Weft signals are pull-only (`ctx.waitForSignal`) and run no state-mutating
 * handler, so `onUpdate` is the push path a `waitUntil` predicate observes.
 */

async function flush(): Promise<void> {
  await sleepForTesting(10);
}

describe('ctx.waitUntil', () => {
  it('returns immediately (no yield) when the predicate is already true', async () => {
    using engine = new Engine();
    engine.register(
      workflow({ name: 'already-true' }).execute(async function* (ctx: WorkflowContext) {
        yield* ctx.waitUntil(() => true);
        return 'done';
      }),
    );

    const handle = await engine.start('already-true', null);
    await expect(handle.result()).resolves.toBe('done');
  });

  it('returns true immediately when a timed predicate is already true', async () => {
    using engine = new Engine();
    engine.register(
      workflow({ name: 'timed-already-true' }).execute(async function* (ctx: WorkflowContext) {
        const met = yield* ctx.waitUntil(() => true, '1h');
        return met;
      }),
    );

    const handle = await engine.start('timed-already-true', null);
    await expect(handle.result()).resolves.toBe(true);
  });

  it('re-evaluates the predicate when an inline update handler mutates state', async () => {
    using engine = new Engine();
    engine.register(
      workflow({ name: 'update-driven' }).execute(async function* (ctx: WorkflowContext) {
        let value = 0;
        ctx.onUpdate('bump', (amount) => {
          value += amount as number;
          return value;
        });
        yield* ctx.waitUntil(() => value >= 3);
        return value;
      }),
    );

    const handle = await engine.start('update-driven', null);
    await flush();

    // Two updates that don't yet satisfy the predicate keep it waiting...
    await engine.update(handle.id, 'bump', 1);
    await flush();
    expect(await engine.get(handle.id).then((s) => s?.status)).toBe('running');

    // ...the third pushes value to 3, and the inline-update hook re-drives the
    // predicate, which now passes.
    await engine.update(handle.id, 'bump', 2);
    await expect(handle.result()).resolves.toBe(3);
  });

  it('re-evaluates even when the update handler throws after mutating state (catch-path hook)', async () => {
    using engine = new Engine();
    engine.register(
      workflow({ name: 'throwing-update' }).execute(async function* (ctx: WorkflowContext) {
        let armed = false;
        ctx.onUpdate('arm-then-throw', () => {
          armed = true;
          throw new Error('handler boom');
        });
        yield* ctx.waitUntil(() => armed);
        return 'unblocked';
      }),
    );

    const handle = await engine.start('throwing-update', null);
    await flush();

    // The update mutates `armed` and then throws. The caller sees the error, but
    // the catch-path re-drive still re-evaluates the predicate (now true), so the
    // workflow unblocks.
    await expect(engine.update(handle.id, 'arm-then-throw', null)).rejects.toThrow('handler boom');
    await expect(handle.result()).resolves.toBe('unblocked');
  });

  it('resolves false when the deadline elapses before the predicate is met', async () => {
    let now = 1_000_000;
    const storage = new MemoryStorage();
    using engine = new Engine({ storage, getNow: () => now });
    engine.register(
      workflow({ name: 'times-out' }).execute(async function* (ctx: WorkflowContext) {
        const met = yield* ctx.waitUntil(() => false, '5m');
        return met;
      }),
    );

    const handle = await engine.start('times-out', null);
    await flush();
    expect(await engine.get(handle.id).then((s) => s?.status)).toBe('running');

    // The deterministic deadline timer must be durably scheduled before it can
    // fire. Asserting its index key exists fails the test if a regression drops
    // `scheduleConditionDeadline` — without it `fireTimer` below would be a no-op
    // and the false-on-timeout path would silently stop being exercised.
    expect(await storage.get(`timer-idx:cond:${handle.id}:0`)).not.toBeNull();

    // Advance past the deadline and fire the deterministic condition timer
    // (step 0 — it is the first durable op in the body).
    now += 5 * 60 * 1000 + 1;
    await engine.fireTimer({
      id: `cond:${handle.id}:0`,
      workflowId: handle.id,
      fireAt: now,
      kind: 'wait-condition',
    });

    await expect(handle.result()).resolves.toBe(false);
  });

  it('polls once and resolves false for a zero timeout when the predicate is unmet', async () => {
    let now = 1_000_000;
    using engine = new Engine({ getNow: () => now });
    engine.register(
      workflow({ name: 'zero-timeout' }).execute(async function* (ctx: WorkflowContext) {
        // A `0` timeout means "evaluate once, then give up": the deadline equals
        // `now`, so the engine's initial predicate-first/deadline-second check
        // resolves it immediately. Same semantics as `ctx.sleep(0)` — `0` is a
        // valid duration; only negatives are rejected.
        const met = yield* ctx.waitUntil(() => false, 0);
        return met;
      }),
    );

    const handle = await engine.start('zero-timeout', null);
    await expect(handle.result()).resolves.toBe(false);
    // It never needs the deadline timer — settled before arming.
    now += 1;
    expect(await engine.get(handle.id).then((s) => s?.status)).toBe('completed');
  });

  it('fails the workflow for a negative timeout (parseDuration rejects it, like ctx.sleep)', async () => {
    using engine = new Engine();
    engine.register(
      workflow({ name: 'negative-timeout' }).execute(async function* (ctx: WorkflowContext) {
        // A negative duration is invalid. `parseDuration` throws a RangeError
        // inside the generator before the request is ever yielded, so the
        // workflow fails at the call site — no waitUntil-specific validation.
        const met = yield* ctx.waitUntil(() => false, -1);
        return met;
      }),
    );

    const handle = await engine.start('negative-timeout', null);
    await expect(handle.result()).rejects.toThrow();
    expect(await engine.get(handle.id).then((s) => s?.status)).toBe('failed');
  });

  it('resolves true (met) over false (timeout) when the predicate becomes true at the deadline', async () => {
    let now = 1_000_000;
    using engine = new Engine({ getNow: () => now });
    engine.register(
      workflow({ name: 'tie-break' }).execute(async function* (ctx: WorkflowContext) {
        let ready = false;
        ctx.onUpdate('arm', () => {
          ready = true;
        });
        const met = yield* ctx.waitUntil(() => ready, '5m');
        return met;
      }),
    );

    const handle = await engine.start('tie-break', null);
    await flush();

    // Make the predicate true (via update) AND move time to the deadline, then
    // fire the timer. Predicate-first ordering means the wait resolves MET, not
    // timed-out.
    now += 5 * 60 * 1000;
    await engine.update(handle.id, 'arm', null);
    await engine.fireTimer({
      id: `cond:${handle.id}:0`,
      workflowId: handle.id,
      fireAt: now,
      kind: 'wait-condition',
    });

    await expect(handle.result()).resolves.toBe(true);
  });

  it('waits forever (no timeout) until the predicate is satisfied', async () => {
    using engine = new Engine();
    let unblocked = 0;
    engine.register(
      workflow({ name: 'wait-forever' }).execute(async function* (ctx: WorkflowContext) {
        let ready = false;
        ctx.onUpdate('go', () => {
          ready = true;
        });
        const result = yield* ctx.waitUntil(() => ready);
        unblocked += 1;
        // `void` outcome — no boolean returned for the no-timeout overload.
        return result === undefined ? 'void-outcome' : 'unexpected';
      }),
    );

    const handle = await engine.start('wait-forever', null);
    await flush();
    expect(unblocked).toBe(0);

    await engine.update(handle.id, 'go', null);
    await expect(handle.result()).resolves.toBe('void-outcome');
  });

  it('rejects ctx.waitUntil used as a ctx.race branch (true predicate) with an actionable error', async () => {
    using engine = new Engine();
    engine.register(
      workflow({ name: 'race-misuse-true' }).execute(async function* (ctx: WorkflowContext) {
        yield* ctx.race([ctx.waitUntil(() => true), ctx.sleep('1h')]);
        return 'unreachable';
      }),
    );

    // Regression for the always-true hang: because waitUntil ALWAYS yields a
    // wait-condition request (no generator fast-path), the race-branch guard
    // throws here just as it does for a false predicate — instead of silently
    // resolving the branch and hanging on the 1h sleep.
    const handle = await engine.start('race-misuse-true', null);
    await expect(handle.result()).rejects.toThrow(
      'ctx.waitUntil() cannot be used as a ctx.race() / ctx.all() / ctx.speculate() branch',
    );
  });

  it('rejects ctx.waitUntil used as a ctx.race branch (false predicate) with an actionable error', async () => {
    using engine = new Engine();
    engine.register(
      workflow({ name: 'race-misuse-false' }).execute(async function* (ctx: WorkflowContext) {
        yield* ctx.race([ctx.waitUntil(() => false), ctx.sleep('1h')]);
        return 'unreachable';
      }),
    );

    const handle = await engine.start('race-misuse-false', null);
    await expect(handle.result()).rejects.toThrow(
      'ctx.waitUntil() cannot be used as a ctx.race() / ctx.all() / ctx.speculate() branch',
    );
  });

  it('fails the workflow (does not hang) when the predicate throws on its initial evaluation', async () => {
    using engine = new Engine();
    engine.register(
      workflow({ name: 'predicate-throws-initial' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        yield* ctx.waitUntil(() => {
          throw new Error('predicate boom');
        });
        return 'unreachable';
      }),
    );

    const handle = await engine.start('predicate-throws-initial', null);
    // A throwing predicate must surface as a workflow failure at the
    // `yield* ctx.waitUntil` site (like a throwing activity/memo), not park the
    // run forever. The `result()` promise resolving either way proves no hang.
    await expect(handle.result()).rejects.toThrow('predicate boom');
    expect(await engine.get(handle.id).then((s) => s?.status)).toBe('failed');
  });

  it('fails the workflow (does not hang) when the predicate throws on an update-driven re-evaluation', async () => {
    using engine = new Engine();
    engine.register(
      workflow({ name: 'predicate-throws-redrive' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        let armed = false;
        ctx.onUpdate('arm', () => {
          armed = true;
        });
        // First evaluation (armed === false) is benign and parks. The update
        // arms the flag and re-drives, and THAT re-evaluation throws.
        yield* ctx.waitUntil(() => {
          if (armed) throw new Error('redrive boom');
          return false;
        });
        return 'unreachable';
      }),
    );

    const handle = await engine.start('predicate-throws-redrive', null);
    await flush();
    expect(await engine.get(handle.id).then((s) => s?.status)).toBe('running');

    await engine.update(handle.id, 'arm', null);
    await expect(handle.result()).rejects.toThrow('redrive boom');
    expect(await engine.get(handle.id).then((s) => s?.status)).toBe('failed');
  });

  it('tears down the waiter when the workflow is cancelled while parked', async () => {
    using engine = new Engine();
    engine.register(
      workflow({ name: 'cancel-while-waiting' }).execute(async function* (ctx: WorkflowContext) {
        ctx.onUpdate('noop', () => undefined);
        yield* ctx.waitUntil(() => false, '1h');
        return 'never';
      }),
    );

    const handle = await engine.start('cancel-while-waiting', null);
    await flush();
    expect(await engine.get(handle.id).then((s) => s?.status)).toBe('running');

    // Cancelling a parked wait-condition wakes the processor loop via the
    // terminal-cleanup resolve; the `isWorkflowRunning` re-check then stops it
    // without driving the evicted generator, and the waiter map is cleared.
    await engine.cancel(handle.id);
    await flush();
    expect(await engine.get(handle.id).then((s) => s?.status)).toBe('cancelled');
  });

  it('ignores an update poke when no waitUntil is active (notify no-op branch)', async () => {
    using engine = new Engine();
    engine.register(
      workflow({ name: 'update-without-wait' }).execute(async function* (ctx: WorkflowContext) {
        ctx.onUpdate('ping', () => 'pong');
        // This workflow parks on a SIGNAL, never on waitUntil. An update delivered
        // here still fires `notifyConditionWaiters`, which finds no active
        // condition waiter for this workflow and is a harmless no-op (the false
        // branch of the resolver lookup).
        const value = yield* ctx.waitForSignal<string>('go');
        return value;
      }),
    );

    const handle = await engine.start('update-without-wait', null);
    await flush();

    // The update is handled by the inline handler; its poke finds no condition
    // waiter and does nothing. The workflow stays parked until the signal.
    await expect(engine.update(handle.id, 'ping', null)).resolves.toBe('pong');
    expect(await engine.get(handle.id).then((s) => s?.status)).toBe('running');

    await engine.signal(handle.id, 'go', 'done');
    await expect(handle.result()).resolves.toBe('done');
  });
});

describe('ctx.waitUntil recovery consistency', () => {
  it('(a) a wait satisfied and committed before the crash returns its cached outcome on recovery', async () => {
    const storage = new MemoryStorage();
    let predicateInvocationsAfterRecovery = 0;
    const build = (engine: Engine, countAfterRecovery: boolean) =>
      engine.register(
        workflow({ name: 'cached-after-crash' }).execute(async function* (ctx: WorkflowContext) {
          let armed = false;
          ctx.onUpdate('arm', () => {
            armed = true;
          });
          // The wait is satisfied on the first run, then a COMMITTED waitForSignal
          // step after it moves the frontier past the wait's slot.
          yield* ctx.waitUntil(() => {
            if (countAfterRecovery) predicateInvocationsAfterRecovery += 1;
            return armed;
          });
          yield* ctx.waitForSignal<string>('finish');
          return 'done';
        }),
      );

    {
      using first = new Engine({ storage });
      build(first, false);
      const handle = await first.start('cached-after-crash', null, { id: 'cached-id' });
      await flush();
      // Satisfy the wait, then park on the committed `finish` waitForSignal.
      await first.update('cached-id', 'arm', null);
      await flush();
      expect(await first.get(handle.id).then((s) => s?.status)).toBe('running');
    }

    // Recover: the wait-condition slot is cached, so the predicate is NOT
    // re-invoked — the outcome is read from accumulatedResults.
    using recovered = new Engine({ storage });
    build(recovered, true);
    const [handle] = await recovered.recoverAll();
    await flush();
    expect(predicateInvocationsAfterRecovery).toBe(0);

    // The run is past the wait, parked on `finish`; resuming completes it.
    await recovered.signal('cached-id', 'finish', 'done');
    await expect(handle!.result()).resolves.toBe('done');
  });

  it('(b) a wait still parked at the crash re-evaluates on recovery and stays waiting until re-driven', async () => {
    const storage = new MemoryStorage();
    let predicateInvocationsAfterRecovery = 0;
    const build = (engine: Engine, countAfterRecovery: boolean) =>
      engine.register(
        workflow({ name: 'parked-at-crash' }).execute(async function* (ctx: WorkflowContext) {
          let value = 0;
          ctx.onUpdate('bump', (amount) => {
            value += amount as number;
            return value;
          });
          // No committed step after the wait. The wait is UNSATISFIED when we
          // crash, so its slot is never committed; on recovery the predicate
          // re-evaluates fresh against the durably-reconstructed value.
          yield* ctx.waitUntil(() => {
            if (countAfterRecovery) predicateInvocationsAfterRecovery += 1;
            return value >= 2;
          });
          return value;
        }),
      );

    {
      using first = new Engine({ storage });
      build(first, false);
      const handle = await first.start('parked-at-crash', null, { id: 'parked-id' });
      await flush();
      // One coordinated update is durably recorded but does NOT satisfy the
      // predicate (needs value >= 2). The run is still parked when we crash.
      await first.update('parked-id', 'bump', 1);
      await flush();
      expect(await first.get(handle.id).then((s) => s?.status)).toBe('running');
    }

    // Recover: the wait slot was never committed, so on recovery the predicate
    // re-evaluates fresh. The durable update was already applied to the response
    // log but the inline `value` closure starts at 0 on replay; the run is back
    // waiting (consistent — outcome matches the state the engine can reconstruct).
    using recovered = new Engine({ storage });
    build(recovered, true);
    const [handle] = await recovered.recoverAll();
    await flush();
    expect(predicateInvocationsAfterRecovery).toBeGreaterThan(0);
    expect(await recovered.get(handle!.id).then((s) => s?.status)).toBe('running');

    // Two more updates after recovery satisfy the predicate and the run completes
    // — consistent state throughout.
    await recovered.update(handle!.id, 'bump', 1);
    await recovered.update(handle!.id, 'bump', 1);
    await expect(handle!.result()).resolves.toBe(2);
  });
});
