/**
 * #456: `ctx.race` / `ctx.all` must accept `sleep` and `wait-signal` branches,
 * not only `ctx.run` (activity) branches.
 *
 * A `sleep` branch is an abortable in-process timer (never a durable scheduler
 * timer); the coordination operation as a whole is the durable unit, so on
 * replay the cached winner short-circuits before any branch re-runs. sleep-WINS
 * paths use short real durations and assert on outcome; sleep-LOSES paths need
 * no timing — the race's AbortController cancels the timer.
 *
 * A `wait-signal` branch never consumes its durable signal itself: when woken it
 * resolves with a deferred-consume envelope, and ONLY the coordinator finalizes
 * (the single destructive consume) on the winner, strictly after the race/all
 * settles. So a losing wait-signal branch leaves the signal intact for a later
 * `waitForSignal` or a replay. The envelope propagates up through NESTED
 * coordinators (a nested `ctx.all` surfaces an array of envelopes), and the
 * top-level coordinator finalize-and-unwraps the winner — including walking
 * arrays — before the result reaches the durable cache. These tests pin both
 * halves of that contract, at the top level and nested.
 */
import { describe, expect, it } from 'bun:test';

import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { encode } from '../codec.ts';
import type { WorkflowContext } from '../types.ts';
import { workflow } from '../types.ts';
import { isDeferredConsumeEnvelope } from './deferred-consume-envelope.ts';
import { Engine } from './index.ts';
import type { EngineInternals } from './internals.ts';
import { getInternals } from './internals.ts';
import { executeSubOperation, MAX_TIMER_DELAY_MS, nextSleepTimerDelayMs } from './sub-operation.ts';

/**
 * A minimal `internals` for driving `executeWaitSignalSubOperation` directly,
 * mirroring `operations-coordination.test.ts`'s signal-internals helper. The
 * sequenced storage returns a different scan result per call so the
 * peek-before-register / re-peek-after-register / consume paths can be exercised
 * deterministically without a real signal-delivery race.
 */
function createSignalInternals(storage: unknown): EngineInternals {
  return {
    abortController: new AbortController(),
    inlineStrategy: null,
    signalWaiters: new Map<string, () => void>(),
    signalWaitersByWorkflow: new Map(),
    storage,
  } as unknown as EngineInternals;
}

function createSequencedStorage(entriesByScan: Array<Array<[string, Uint8Array]> | (() => never)>) {
  let scanIndex = 0;
  return {
    async delete() {},
    scan() {
      const entries = entriesByScan[scanIndex++] ?? [];
      if (typeof entries === 'function') entries();
      const concrete = entries as Array<[string, Uint8Array]>;
      return (async function* () {
        for (const entry of concrete) yield entry;
      })();
    },
  };
}

/**
 * A tiny stateful KV that yields the empty set on the FIRST scan and the seeded
 * entry on every later scan until a matching `delete`. This drives the
 * register-then-re-peek win path while still letting the envelope's deferred
 * `consumeSignal` find (and delete) the record on a later scan.
 */
function createDeferredVisibleStorage(key: string, value: Uint8Array) {
  let firstScanDone = false;
  let present = true;
  return {
    async delete(deleteKey: string) {
      if (deleteKey === key) present = false;
    },
    scan() {
      const visible = firstScanDone && present;
      firstScanDone = true;
      return (async function* () {
        if (visible) yield [key, value] as [string, Uint8Array];
      })();
    },
  };
}

const SUB_OPERATION_CALLBACKS = {
  createActivityOperationCallbacks: () => ({}),
  createChildWorkflowOperationCallbacks: () => ({}),
  createCoordinationOperationCallbacks: () => ({}),
  createStateOperationCallbacks: () => ({}),
} as unknown as Parameters<typeof executeSubOperation>[3];

describe('#456 ctx.race / ctx.all with sleep branches', () => {
  it('race([sleep, sleep]) resolves with the shorter sleep (both branches are sleeps)', async () => {
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'race-sleeps' }).execute(async function* (ctx: WorkflowContext) {
        // The shorter sleep wins; the longer one is aborted. sleep resolves to undefined.
        yield* ctx.race([ctx.sleep('10ms'), ctx.sleep('5s')]);
        return 'done';
      }),
    );

    const handle = await engine.start('race-sleeps', null);
    expect(await handle.result()).toBe('done');
  });

  it('race([sleep(0ms), sleep]) — a zero/past-fire sleep resolves immediately', async () => {
    // A `0ms` (or already-past) sleep has `scheduledFireAt <= getNow()` by the time
    // the branch runs, so `remainingMs` clamps to 0 and the branch resolves
    // synchronously without arming a timer. It therefore wins the race against the
    // long sleep deterministically.
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'race-zero-sleep' }).execute(async function* (ctx: WorkflowContext) {
        yield* ctx.race([ctx.sleep('0ms'), ctx.sleep('5s')]);
        return 'zero-won';
      }),
    );

    const handle = await engine.start('race-zero-sleep', null);
    expect(await handle.result()).toBe('zero-won');
  });

  it('race([run(activity), sleep]) — activity wins (supersede idiom)', async () => {
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'race-run-sleep' })
        .activities({ work: async () => 'work-result' })
        .execute(async function* (ctx: WorkflowContext) {
          const winner = yield* ctx.race([ctx.run('work'), ctx.sleep('5s')]);
          return winner;
        }),
    );

    const handle = await engine.start('race-run-sleep', null);
    expect(await handle.result()).toBe('work-result');
  });

  it('all([sleep, sleep]) waits for every sleep branch', async () => {
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'all-sleeps' }).execute(async function* (ctx: WorkflowContext) {
        const results = yield* ctx.all([ctx.sleep('5ms'), ctx.sleep('10ms')]);
        return results;
      }),
    );

    const handle = await engine.start('all-sleeps', null);
    // Both sleeps resolve to undefined.
    expect(await handle.result()).toEqual([undefined, undefined]);
  });

  it('all([run, sleep]) resolves with the activity result and the (undefined) sleep', async () => {
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'all-run-sleep' })
        .activities({ work: async () => 42 })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.all([ctx.run('work'), ctx.sleep('5ms')]);
        }),
    );

    const handle = await engine.start('all-run-sleep', null);
    expect(await handle.result()).toEqual([42, undefined]);
  });
});

describe('#456 nextSleepTimerDelayMs clamps to the host setTimeout ceiling', () => {
  it('clamps a multi-day remaining delay to MAX_TIMER_DELAY_MS (no setTimeout overflow)', () => {
    // A 30-day remaining delay exceeds the 32-bit setTimeout ceiling. Without the
    // clamp the host timer overflows and fires almost immediately, so a long sleep
    // would incorrectly win its race. The clamp caps each chunk at the ceiling and
    // the caller re-arms against the absolute deadline.
    const now = 1_000_000;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(nextSleepTimerDelayMs(now + thirtyDaysMs, now)).toBe(MAX_TIMER_DELAY_MS);
  });

  it('returns the exact remaining delay when it is within the ceiling', () => {
    const now = 1_000_000;
    expect(nextSleepTimerDelayMs(now + 5000, now)).toBe(5000);
  });

  it('clamps a past-due or equal deadline to 0 (resolve immediately)', () => {
    const now = 1_000_000;
    expect(nextSleepTimerDelayMs(now, now)).toBe(0);
    expect(nextSleepTimerDelayMs(now - 5000, now)).toBe(0);
  });

  it('returns exactly the ceiling when the remaining delay equals MAX_TIMER_DELAY_MS', () => {
    const now = 1_000_000;
    expect(nextSleepTimerDelayMs(now + MAX_TIMER_DELAY_MS, now)).toBe(MAX_TIMER_DELAY_MS);
  });
});

describe('#456 ctx.race / ctx.all with wait-signal branches', () => {
  it('race([waitForSignal, sleep]) — signal wins and the workflow sees its payload', async () => {
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'race-signal-wins' }).execute(async function* (ctx: WorkflowContext) {
        const winner = yield* ctx.race([ctx.waitForSignal<string>('ev'), ctx.sleep('5s')]);
        return winner;
      }),
    );

    const handle = await engine.start('race-signal-wins', null, { id: 'sig-wins' });
    await engine.signal('sig-wins', 'ev', 'from-signal');
    expect(await handle.result()).toBe('from-signal');
  });

  it('race([waitForSignal, sleep]) — sleep wins when no signal arrives (idle-timeout idiom)', async () => {
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'race-timeout-wins' }).execute(async function* (ctx: WorkflowContext) {
        const winner = yield* ctx.race([ctx.waitForSignal<string>('ev'), ctx.sleep('10ms')]);
        // sleep resolves undefined; a signal would have resolved a string.
        return winner === undefined ? 'timed-out' : `signalled:${String(winner)}`;
      }),
    );

    const handle = await engine.start('race-timeout-wins', null);
    expect(await handle.result()).toBe('timed-out');
  });

  it('race([run(activity), waitForSignal]) — activity wins (supersede idiom)', async () => {
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'race-run-signal' })
        .activities({ work: async () => 'work-result' })
        .execute(async function* (ctx: WorkflowContext) {
          const winner = yield* ctx.race([ctx.run('work'), ctx.waitForSignal<string>('ev')]);
          return winner;
        }),
    );

    const handle = await engine.start('race-run-signal', null);
    expect(await handle.result()).toBe('work-result');
  });

  it('all([run, waitForSignal]) resolves with the activity result and the signal payload', async () => {
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'all-run-signal' })
        .activities({ work: async () => 42 })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.all([ctx.run('work'), ctx.waitForSignal<string>('ev')]);
        }),
    );

    const handle = await engine.start('all-run-signal', null, { id: 'all-sig' });
    await engine.signal('all-sig', 'ev', 'signal-value');
    expect(await handle.result()).toEqual([42, 'signal-value']);
  });

  it('allows a race with branches waiting on DISTINCT signal names (event-or-close)', async () => {
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'event-or-close' }).execute(async function* (ctx: WorkflowContext) {
        const winner = yield* ctx.race([
          ctx.waitForSignal<string>('event'),
          ctx.waitForSignal<string>('closed'),
        ]);
        return winner;
      }),
    );

    const handle = await engine.start('event-or-close', null, { id: 'eoc' });
    await engine.signal('eoc', 'closed', 'shut-down');
    expect(await handle.result()).toBe('shut-down');
  });

  it('rejects a race with two branches waiting on the same signal name', async () => {
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'dup-signal-race' }).execute(async function* (ctx: WorkflowContext) {
        // Two branches on the same signal name would clobber each other's waiter.
        yield* ctx.race([ctx.waitForSignal<string>('ev'), ctx.waitForSignal<string>('ev')]);
        return 'unreachable';
      }),
    );

    const handle = await engine.start('dup-signal-race', null);
    await expect(handle.result()).rejects.toThrow(/same signal "ev"/);
  });
});

describe('#456 a losing wait-signal branch must not consume the signal', () => {
  it('a losing wait-signal branch leaves the signal for a later top-level waitForSignal', async () => {
    // The supersede idiom: race a waitForSignal against an instant activity. The
    // activity wins, so the waitForSignal branch is the loser and must tear down
    // WITHOUT consuming. A later top-level waitForSignal then receives the signal,
    // proving the loser left no stale waiter on the shared key and consumed
    // nothing. (run-wins is timer-free and deterministic.)
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'signal-loses' })
        .activities({ instantWin: async () => 'won' })
        .execute(async function* (ctx: WorkflowContext) {
          const first = yield* ctx.race([ctx.waitForSignal<string>('ev'), ctx.run('instantWin')]);
          // The run parks here on a top-level waitForSignal; the signal delivered
          // below must reach it.
          const second = yield* ctx.waitForSignal<string>('ev');
          return { first, second };
        }),
    );

    const handle = await engine.start('signal-loses', null, { id: 'sig-loses' });
    // Wait for the top-level waitForSignal to park, then deliver. (Signals are
    // delivered/buffered durably under a plain Engine.)
    await waitForCondition(() => getInternals(engine).parkedInlineWorkflows.has('sig-loses'), {
      timeoutMs: 2000,
      label: 'run parked on the top-level waitForSignal after the race settled',
    });
    await engine.signal('sig-loses', 'ev', 'late-signal');

    const result = (await handle.result()) as { first: unknown; second: unknown };
    expect(result.first).toBe('won');
    expect(result.second).toBe('late-signal');
  });

  it('a winning wait-signal branch consumes the signal exactly once and leaves no waiter', async () => {
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'signal-consumed-once' }).execute(async function* (ctx: WorkflowContext) {
        const winner = yield* ctx.race([ctx.waitForSignal<string>('ev'), ctx.sleep('5s')]);
        return winner;
      }),
    );

    const handle = await engine.start('signal-consumed-once', null, { id: 'sig-once' });
    await engine.signal('sig-once', 'ev', 'only-once');
    expect(await handle.result()).toBe('only-once');

    // The durable signal record was consumed exactly once: no residue, no waiter.
    const internals = getInternals(engine);
    expect(internals.signalWaiters.size).toBe(0);
    expect(internals.signalWaitersByWorkflow.has('sig-once')).toBe(false);
  });
});

describe('#456 wait-signal branch sub-operation paths (driven directly)', () => {
  it('resolves with a deferred-consume envelope when a signal is buffered after registration', async () => {
    // First peek empty → register → re-peek finds the buffered signal. The branch
    // must release its waiter and resolve with an envelope (NOT a consumed value);
    // the envelope's finalize() performs the single consume on demand.
    const internals = createSignalInternals(
      createDeferredVisibleStorage('sig:key', encode('buffered')),
    );

    const result = await executeSubOperation(
      internals,
      'wf-rebuffer',
      { type: 'wait-signal', operationId: 'ws', signalName: 'ev' } as never,
      SUB_OPERATION_CALLBACKS,
    );

    expect(isDeferredConsumeEnvelope(result)).toBe(true);
    expect(internals.signalWaiters.size).toBe(0);
    expect(internals.signalWaitersByWorkflow.size).toBe(0);
    // The envelope defers the consume; calling finalize() reads the buffered value.
    const consumed = isDeferredConsumeEnvelope(result) ? await result.finalize() : undefined;
    expect(consumed).toBe('buffered');
  });

  it('rejects when the underlying signal read throws (no unhandled rejection)', async () => {
    // The inner read pipeline rejects (storage error on the re-peek). The branch's
    // `.catch(fail)` must reject the branch promise and release the waiter, rather
    // than surfacing an unhandled rejection.
    const internals = createSignalInternals(
      createSequencedStorage([
        [],
        () => {
          throw new Error('storage exploded');
        },
      ]),
    );

    await expect(
      executeSubOperation(
        internals,
        'wf-fail',
        { type: 'wait-signal', operationId: 'ws', signalName: 'ev' } as never,
        SUB_OPERATION_CALLBACKS,
      ),
    ).rejects.toThrow('storage exploded');
    expect(internals.signalWaiters.size).toBe(0);
    expect(internals.signalWaitersByWorkflow.size).toBe(0);
  });

  it('rejects synchronously when the engine is already aborted before registration', async () => {
    // Engine tearing down: engineAbort is already set when the branch starts, so it
    // must reject immediately without registering a waiter.
    const internals = createSignalInternals(createSequencedStorage([[], []]));
    internals.abortController.abort();

    await expect(
      executeSubOperation(
        internals,
        'wf-aborted',
        { type: 'wait-signal', operationId: 'ws', signalName: 'ev' } as never,
        SUB_OPERATION_CALLBACKS,
      ),
    ).rejects.toThrow();
    expect(internals.signalWaiters.size).toBe(0);
  });
});

describe('#456 wait-signal inside ctx.all is unbounded by design', () => {
  it('all([run-that-fails, waitForSignal]) does not settle until the signal arrives', async () => {
    // ctx.all waits for EVERY branch (allSettled semantics, for durable partial
    // results) and does not abort siblings when one fails — matching activity
    // branches, which always run to completion. A wait-signal branch therefore
    // blocks the all until its signal is delivered, exactly like a top-level
    // waitForSignal. Authors must guarantee delivery or wrap the wait in a race
    // with a timeout. This pins that intended (unbounded) behavior.
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'all-signal-unbounded' })
        .activities({
          boom: async () => {
            throw new Error('branch failed');
          },
        })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.all([ctx.run('boom'), ctx.waitForSignal<string>('ev')]);
        }),
    );

    const handle = await engine.start('all-signal-unbounded', null, { id: 'all-unbounded' });

    // The all has NOT settled despite the failing branch: a waiter is parked on
    // 'ev' and the workflow is still running.
    await waitForCondition(() => getInternals(engine).signalWaiters.has('all-unbounded:ev'), {
      timeoutMs: 2000,
      label: 'wait-signal branch registered its waiter',
    });
    const stillRunning = await engine.get('all-unbounded');
    expect(stillRunning?.status).toBe('running');

    // Delivering the signal lets the all settle; the failing branch then surfaces.
    await engine.signal('all-unbounded', 'ev', 'unblock');
    await expect(handle.result()).rejects.toThrow('branch failed');
  });
});

describe('#456 nested wait-signal branches (envelope propagation through nested coordinators)', () => {
  it('nested ctx.all that WINS the outer race finalizes its envelope exactly once', async () => {
    // race([ run(slow), all([ waitForSignal, run(fast) ]) ]). The nested all
    // settles fast (the signal arrives while run(slow) is still pending), so the
    // nested all WINS the outer race. Its array result holds the wait-signal
    // envelope; the outer coordinator must walk the array and finalize it once.
    await using engine = new Engine();
    let releaseSlow: (v: string) => void = () => {};
    engine.register(
      workflow({ name: 'nested-all-wins' })
        .activities({
          slow: async () => new Promise<string>((resolve) => (releaseSlow = resolve)),
          fast: async () => 'fast-done',
        })
        .execute(async function* (ctx: WorkflowContext) {
          const winner = yield* ctx.race([
            ctx.run('slow'),
            ctx.all([ctx.waitForSignal<string>('ev'), ctx.run('fast')]),
          ]);
          return winner;
        }),
    );

    const handle = await engine.start('nested-all-wins', null, { id: 'naw' });
    await waitForCondition(() => getInternals(engine).signalWaiters.has('naw:ev'), {
      timeoutMs: 2000,
      label: 'nested wait-signal registered',
    });
    await engine.signal('naw', 'ev', 'ev-payload');
    // The nested all wins the outer race; its result is [signal-payload, fast].
    expect(await handle.result()).toEqual(['ev-payload', 'fast-done']);
    // Slow never resolves; releasing it now is a no-op (workflow already done).
    releaseSlow('ignored');
    const internals = getInternals(engine);
    expect(internals.signalWaiters.size).toBe(0);
    expect(internals.signalWaitersByWorkflow.has('naw')).toBe(false);
  });

  it('nested ctx.all that LOSES the outer race releases its waiter and consumes nothing', async () => {
    // race([ run(fast), all([ waitForSignal, sleep ]) ]). run(fast) wins; the
    // nested all (and its wait-signal branch) loses and must release its waiter
    // WITHOUT consuming. A later top-level waitForSignal still receives the signal.
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'nested-all-loses' })
        .activities({ fast: async () => 'fast-won' })
        .execute(async function* (ctx: WorkflowContext) {
          const first = yield* ctx.race([
            ctx.run('fast'),
            ctx.all([ctx.waitForSignal<string>('ev'), ctx.sleep('30s')]),
          ]);
          const second = yield* ctx.waitForSignal<string>('ev');
          return { first, second };
        }),
    );

    const handle = await engine.start('nested-all-loses', null, { id: 'nal' });
    await waitForCondition(() => getInternals(engine).parkedInlineWorkflows.has('nal'), {
      timeoutMs: 2000,
      label: 'parked on the top-level waitForSignal after the outer race settled',
    });
    // No leaked nested waiter survived the loss.
    expect(getInternals(engine).signalWaiters.size).toBe(0);
    await engine.signal('nal', 'ev', 'late-ev');

    const result = (await handle.result()) as { first: unknown; second: unknown };
    expect(result.first).toBe('fast-won');
    expect(result.second).toBe('late-ev');
  });

  it('nested ctx.race that LOSES the outer race with late delivery does not orphan the signal', async () => {
    // race([ run(fast), race([ waitForSignal, sleep ]) ]). run(fast) wins; the
    // nested race's wait-signal loses. A signal delivered AFTER the outer race
    // settles must NOT be silently swallowed by the dead nested branch — a later
    // top-level waitForSignal must receive it.
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'nested-race-loses' })
        .activities({ fast: async () => 'fast-won' })
        .execute(async function* (ctx: WorkflowContext) {
          const first = yield* ctx.race([
            ctx.run('fast'),
            ctx.race([ctx.waitForSignal<string>('ev'), ctx.sleep('30s')]),
          ]);
          const second = yield* ctx.waitForSignal<string>('ev');
          return { first, second };
        }),
    );

    const handle = await engine.start('nested-race-loses', null, { id: 'nrl' });
    await waitForCondition(() => getInternals(engine).parkedInlineWorkflows.has('nrl'), {
      timeoutMs: 2000,
      label: 'parked on the top-level waitForSignal after the outer race settled',
    });
    expect(getInternals(engine).signalWaiters.size).toBe(0);
    await engine.signal('nrl', 'ev', 'late-ev');

    const result = (await handle.result()) as { first: unknown; second: unknown };
    expect(result.first).toBe('fast-won');
    expect(result.second).toBe('late-ev');
  });

  it('top-level ctx.all containing a nested ctx.race with a wait-signal finalizes correctly', async () => {
    // all([ run, race([ waitForSignal, sleep ]) ]). The top coordinator is a
    // `parallel`, which finalizes each branch via executeOne before the slot is
    // built — including the nested race's envelope. Exercises the top-`all`
    // finalize-on-nested-result path (a different call site than the top-`race`
    // winner path).
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'all-with-nested-race' })
        .activities({ work: async () => 'work-done' })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.all([
            ctx.run('work'),
            ctx.race([ctx.waitForSignal<string>('ev'), ctx.sleep('30s')]),
          ]);
        }),
    );

    const handle = await engine.start('all-with-nested-race', null, { id: 'awnr' });
    await waitForCondition(() => getInternals(engine).signalWaiters.has('awnr:ev'), {
      timeoutMs: 2000,
      label: 'nested wait-signal registered',
    });
    await engine.signal('awnr', 'ev', 'ev-payload');
    expect(await handle.result()).toEqual(['work-done', 'ev-payload']);
    const internals = getInternals(engine);
    expect(internals.signalWaiters.size).toBe(0);
    expect(internals.signalWaitersByWorkflow.has('awnr')).toBe(false);
  });

  it('nested ctx.race that WINS the outer race finalizes its single envelope once', async () => {
    // race([ run(slow), race([ waitForSignal, sleep ]) ]). The signal arrives while
    // run(slow) is pending, so the nested race wins the outer race; its single
    // envelope must finalize once and the workflow sees the signal payload.
    await using engine = new Engine();
    let releaseSlow: (v: string) => void = () => {};
    engine.register(
      workflow({ name: 'nested-race-wins' })
        .activities({ slow: async () => new Promise<string>((resolve) => (releaseSlow = resolve)) })
        .execute(async function* (ctx: WorkflowContext) {
          const winner = yield* ctx.race([
            ctx.run('slow'),
            ctx.race([ctx.waitForSignal<string>('ev'), ctx.sleep('30s')]),
          ]);
          return winner;
        }),
    );

    const handle = await engine.start('nested-race-wins', null, { id: 'nrw' });
    await waitForCondition(() => getInternals(engine).signalWaiters.has('nrw:ev'), {
      timeoutMs: 2000,
      label: 'nested wait-signal registered',
    });
    await engine.signal('nrw', 'ev', 'ev-wins');
    expect(await handle.result()).toBe('ev-wins');
    releaseSlow('ignored');
    const internals = getInternals(engine);
    expect(internals.signalWaiters.size).toBe(0);
    expect(internals.signalWaitersByWorkflow.has('nrw')).toBe(false);
  });
});

describe('#456 a winning wait-signal survives replay without re-consuming', () => {
  it('a race won by waitForSignal returns the cached payload after a later park/resume replay', async () => {
    // ev wins the race and the durable `sig:ev` record is consumed. A LATER
    // waitForSignal('gate') parks the workflow; resuming replays the whole
    // generator, including the race op. The race must short-circuit from its
    // cached consumed value ('ev-payload') and NOT re-run the branch — re-running
    // would re-consume a now-deleted record, yielding `undefined` (a different
    // winner on replay = non-determinism). Pins that the CONSUMED value, not the
    // envelope, is what was cached.
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'signal-wins-replay' }).execute(async function* (ctx: WorkflowContext) {
        const winner = yield* ctx.race([ctx.waitForSignal<string>('ev'), ctx.sleep('30s')]);
        const gate = yield* ctx.waitForSignal<string>('gate');
        return { winner, gate };
      }),
    );

    const handle = await engine.start('signal-wins-replay', null, { id: 'swr' });
    await engine.signal('swr', 'ev', 'ev-payload');
    // The workflow now parks on the second waitForSignal('gate'); resume replays.
    await waitForCondition(() => getInternals(engine).parkedInlineWorkflows.has('swr'), {
      timeoutMs: 2000,
      label: 'parked on waitForSignal(gate) after the race resolved',
    });
    await engine.signal('swr', 'gate', 'gate-payload');

    const result = (await handle.result()) as { winner: unknown; gate: unknown };
    // If replay re-consumed, winner would be undefined.
    expect(result.winner).toBe('ev-payload');
    expect(result.gate).toBe('gate-payload');
  });

  it('an all branch won by waitForSignal reuses its fulfilled slot value after a park/resume replay', async () => {
    // all([ waitForSignal, run ]) where the wait-signal branch already won and the
    // signal was consumed. A LATER waitForSignal('gate') parks; resume replays the
    // `all` op. dispatchBranchesAllSettled must reuse the already-fulfilled slot's
    // CONSUMED value and not re-dispatch the wait-signal branch (the durable record
    // is gone). Exercises the partial-cache slot-resume path with a wait-signal.
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'all-signal-replay' })
        .activities({ work: async () => 'work-done' })
        .execute(async function* (ctx: WorkflowContext) {
          const both = yield* ctx.all([ctx.waitForSignal<string>('ev'), ctx.run('work')]);
          const gate = yield* ctx.waitForSignal<string>('gate');
          return { both, gate };
        }),
    );

    const handle = await engine.start('all-signal-replay', null, { id: 'asr' });
    await engine.signal('asr', 'ev', 'ev-payload');
    await waitForCondition(() => getInternals(engine).parkedInlineWorkflows.has('asr'), {
      timeoutMs: 2000,
      label: 'parked on waitForSignal(gate) after the all resolved',
    });
    await engine.signal('asr', 'gate', 'gate-payload');

    const result = (await handle.result()) as { both: unknown; gate: unknown };
    expect(result.both).toEqual(['ev-payload', 'work-done']);
    expect(result.gate).toBe('gate-payload');
  });
});
