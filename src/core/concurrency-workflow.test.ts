/**
 * Integration tests for the durable concurrency primitives running inside real
 * workflows. These exercise the three contracts the feature must guarantee:
 *
 *   1. Two workflows contending for a mutex serialize access; the second waits
 *      for release and acquires in FIFO order.
 *   2. A holder that crashes (never releases) does not deadlock the lock — the
 *      lease expires and a contender reclaims it, and recovery is unaffected.
 *   3. A semaphore with N permits admits at most N concurrent holders.
 *
 * All timing is virtual via TestEngine.advanceTime — no wall-clock sleeps. The
 * workflow reads a durable timestamp through a `readClock` activity kept in
 * sync with the engine's virtual clock, mirroring the production pattern of
 * capturing wall-clock time via an activity so the lease arithmetic is
 * replay-safe.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { flushPortableMicrotasks, yieldToPortableEventLoop } from '../testing/event-loop.ts';
import { restoreRealTimers } from '../testing/fake-timers.test-support.ts';
import { TestEngine } from '../testing/test-engine.ts';
import {
  DurableMutex,
  DurableSemaphore,
  initialLockRecord,
  type LockRecord,
} from './concurrency.ts';
import type { WorkflowAtomicState, WorkflowContext } from './types.ts';
import { activity, workflow } from './types.ts';

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await yieldToPortableEventLoop();
    await flushPortableMicrotasks(5);
  }
}

afterEach(() => {
  activeEngine?.[Symbol.dispose]();
  activeEngine = undefined;
  restoreRealTimers();
});

// The engine under test, so the clock activity can read virtual time. Set at
// the top of each test before any workflow runs.
let activeEngine: TestEngine | undefined;

// A clock activity reads the engine's virtual time durably. In production this
// would be `() => Date.now()`; in tests we read the TestEngine virtual clock so
// lease arithmetic advances with `advanceTime`. Reading time through an
// activity is the production-correct pattern: the value is recorded in the
// effect log and replays identically.
const readClock = activity({
  name: 'readClock',
  execute: async (): Promise<number> => {
    if (activeEngine === undefined) throw new Error('test clock not initialized');
    return activeEngine.now;
  },
});

const POLL_INTERVAL_MS = 1_000;
const LEASE_MS = 30_000;

// A mutex acquire loop: poll tryAcquire, sleeping between attempts so the wait
// is durable. Captures `now` durably before each attempt.
function* acquireMutex(
  ctx: WorkflowContext,
  mutex: DurableMutex,
  slot: WorkflowAtomicState<LockRecord>,
  maxAttempts: number,
) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const now = yield* ctx.run(readClock);
    const result = yield* mutex.tryAcquire(slot, { holderId: ctx.workflowId, now });
    if (result.acquired) return;
    yield* ctx.sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`failed to acquire mutex after ${maxAttempts} attempts`);
}

describe('durable mutex inside workflows', () => {
  it('serializes two contenders and admits the second in FIFO order after release', async () => {
    const engine = new TestEngine({ startTime: 0 });
    activeEngine = engine;
    const order: string[] = [];

    const criticalSection = activity({
      name: 'criticalSection',
      execute: async (label: string): Promise<string> => {
        order.push(label);
        return label;
      },
    });

    engine.register(
      workflow({ name: 'mutex-worker' }).execute(async function* (
        ctx: WorkflowContext,
        input: { label: string; holdMs: number },
      ) {
        const mutex = new DurableMutex({ leaseMs: LEASE_MS });
        const slot = ctx.state.workflow<LockRecord>('shared-resource:lock', {
          initial: initialLockRecord(),
        });
        yield* acquireMutex(ctx, mutex, slot, 100);
        yield* ctx.run(criticalSection, `${input.label}:enter`);
        yield* ctx.sleep(input.holdMs);
        yield* ctx.run(criticalSection, `${input.label}:exit`);
        const releaseNow = yield* ctx.run(readClock);
        yield* mutex.release(slot, { holderId: ctx.workflowId, now: releaseNow });
        return input.label;
      }),
    );

    const a = await engine.start(
      'mutex-worker',
      { label: 'a', holdMs: 5_000 },
      { id: 'workflow-a' },
    );
    await flush();
    // a has acquired the lock and is inside its critical section.
    expect(order).toEqual(['a:enter']);

    // b starts while a holds the lock; it must queue and wait.
    const b = await engine.start(
      'mutex-worker',
      { label: 'b', holdMs: 5_000 },
      { id: 'workflow-b' },
    );
    await flush();
    // b is still waiting — a has not exited.
    expect(order).toEqual(['a:enter']);

    // Advance past a's hold so it exits and releases.
    await engine.advanceTime(6_000);
    await flush();
    expect(order).toContain('a:exit');

    // b polls again, acquires, and runs its critical section.
    await engine.advanceTime(POLL_INTERVAL_MS);
    await flush();
    expect(order).toContain('b:enter');

    await engine.advanceTime(6_000);
    await flush();

    expect(await a.result()).toBe('a');
    expect(await b.result()).toBe('b');

    // Strict serialization and FIFO order: a fully exits before b enters.
    expect(order).toEqual(['a:enter', 'a:exit', 'b:enter', 'b:exit']);
  });

  it('frees a crashed holder via lease expiry without deadlocking, and is recovery-safe', async () => {
    const engine = new TestEngine({ startTime: 0 });
    activeEngine = engine;
    const order: string[] = [];

    const enter = activity({
      name: 'enterSection',
      execute: async (label: string): Promise<string> => {
        order.push(label);
        return label;
      },
    });

    // A single workflow type holds the lock in a `workflow`-scoped slot, which
    // is shared across every run of that type. The `crash` flag makes one run
    // crash before releasing; another run must reclaim it via lease expiry.
    engine.register(
      workflow({ name: 'lock-contender' }).execute(async function* (
        ctx: WorkflowContext,
        input: { label: string; crash: boolean },
      ) {
        const mutex = new DurableMutex({ leaseMs: LEASE_MS });
        const slot = ctx.state.workflow<LockRecord>('crash-resource:lock', {
          initial: initialLockRecord(),
        });
        // Enough attempts to outlast a stale lease (each poll grows the clock).
        yield* acquireMutex(ctx, mutex, slot, 1_000);
        yield* ctx.run(enter, `${input.label}:acquired`);
        if (input.crash) {
          throw new Error('holder crashed before releasing the lock');
        }
        const releaseNow = yield* ctx.run(readClock);
        yield* mutex.release(slot, { holderId: ctx.workflowId, now: releaseNow });
        return `${input.label}-done`;
      }),
    );

    const holder = await engine.start(
      'lock-contender',
      { label: 'holder', crash: true },
      { id: 'holder' },
    );
    await flush();
    expect(order).toEqual(['holder:acquired']);
    await expect(holder.result()).rejects.toThrow('holder crashed before releasing the lock');

    const waiter = await engine.start(
      'lock-contender',
      { label: 'waiter', crash: false },
      { id: 'waiter' },
    );
    await flush();
    // Lease is still live (holder acquired at ~t0, lease 30s). Waiter blocked.
    expect(order).toEqual(['holder:acquired']);

    // Advance past the lease boundary. The waiter's next poll reclaims the lock.
    await engine.advanceTime(LEASE_MS + POLL_INTERVAL_MS * 2);
    await flush();

    expect(order).toContain('waiter:acquired');
    expect(await waiter.result()).toBe('waiter-done');

    // Recovery safety: a fresh engine over the same storage recovers cleanly —
    // the lock record is plain CAS state, so there is nothing to replay
    // incorrectly and recoverAll succeeds with no surviving running workflows.
    const recovered = await engine.recover();
    const handles = await recovered.recoverAll();
    expect(handles).toEqual([]);
    recovered[Symbol.dispose]();
  });
});

describe('durable semaphore inside workflows', () => {
  it('admits at most N concurrent holders', async () => {
    const engine = new TestEngine({ startTime: 0 });
    activeEngine = engine;
    let concurrent = 0;
    let peakConcurrent = 0;

    const work = activity({
      name: 'semaphoreWork',
      execute: async (): Promise<void> => {
        concurrent += 1;
        peakConcurrent = Math.max(peakConcurrent, concurrent);
      },
    });

    const done = activity({
      name: 'semaphoreDone',
      execute: async (): Promise<void> => {
        concurrent -= 1;
      },
    });

    const PERMITS = 2;

    engine.register(
      workflow({ name: 'semaphore-worker' }).execute(async function* (ctx: WorkflowContext) {
        const semaphore = new DurableSemaphore({ permits: PERMITS, leaseMs: LEASE_MS });
        const slot = ctx.state.workflow<LockRecord>('rate-limited:lock', {
          initial: initialLockRecord(),
        });
        for (let attempt = 0; attempt < 1_000; attempt++) {
          const now = yield* ctx.run(readClock);
          const result = yield* semaphore.tryAcquire(slot, { holderId: ctx.workflowId, now });
          if (result.acquired) break;
          yield* ctx.sleep(POLL_INTERVAL_MS);
        }
        yield* ctx.run(work);
        yield* ctx.sleep(5_000);
        yield* ctx.run(done);
        const releaseNow = yield* ctx.run(readClock);
        yield* semaphore.release(slot, { holderId: ctx.workflowId, now: releaseNow });
        return ctx.workflowId;
      }),
    );

    const workers = await Promise.all(
      Array.from({ length: 5 }, (_value, index) =>
        engine.start('semaphore-worker', null, { id: `sem-${index}` }),
      ),
    );

    // Drive the system forward enough turns that every worker eventually
    // acquires, works, releases, and the queue drains.
    for (let i = 0; i < 12; i++) {
      await engine.advanceTime(5_000);
      await flush();
    }

    const results = await Promise.all(workers.map((handle) => handle.result()));
    expect(results.toSorted((left, right) => String(left).localeCompare(String(right)))).toEqual([
      'sem-0',
      'sem-1',
      'sem-2',
      'sem-3',
      'sem-4',
    ]);

    // The invariant: never more than PERMITS holders ran the work activity at
    // the same time.
    expect(peakConcurrent).toBeLessThanOrEqual(PERMITS);
    expect(peakConcurrent).toBeGreaterThan(0);
  });
});
