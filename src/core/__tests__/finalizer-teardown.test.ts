/**
 * End-to-end tests for the engine-driven finalizer teardown (#446 Phase 2).
 *
 * A workflow whose definition declares a `finalizer` activity and records a
 * resource id via `ctx.setFinalizerState` gets that finalizer DRIVEN by the engine
 * after a `cancelled`/`timed-out` terminal — durably, with retry/backoff, recovery
 * re-drive, and a dead-letter horizon. These tests exercise the whole loop through
 * the public `Engine` API: success, status gating, retry→success, dead-letter, the
 * crash-recovery re-drive, and the purge / bulk-delete / start-new interlocks that
 * keep the leak-prevention guarantee from being undermined by a competing delete.
 *
 * Synchronization is deterministic, never a wall-clock sleep: workflow start/park is
 * awaited via the in-memory `parkedInlineWorkflows` set, and timer-driven dispatch is
 * advanced with `engine.scheduler.tick` against a controllable `getNow`. Blocking
 * finalizers are controllable deferreds — settled and awaited before the engine is
 * disposed, so no background work leaks past a test.
 */

import { describe, expect, it } from 'bun:test';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { decode, encode } from '../codec.ts';
import { Engine, WorkflowTeardownPendingError } from '../engine.ts';
import { type TeardownClaim } from '../engine/state-utilities.ts';
import type { TeardownDeadLetterRecord } from '../engine/termination.ts';
import type { WorkflowTeardownStatus } from '../events.ts';
import type { AnyActivityDefinition, WorkflowContext } from '../types.ts';
import { activity, workflow } from '../types.ts';

/** A finalizer whose run is gated on an explicit `release()` (or `reject()`) — never a sleep. */
interface ControllableFinalizer {
  destroy: AnyActivityDefinition;
  /** Resolves once the finalizer body has been entered (the engine claimed + started it). */
  started: Promise<void>;
  /** Let the in-flight finalizer attempt complete successfully. */
  release: () => void;
  /** Fail the in-flight finalizer attempt. */
  reject: (error: Error) => void;
  /** Workflow ids the finalizer recorded as torn down, in order. */
  destroyed: unknown[];
}

function createControllableFinalizer(name: string): ControllableFinalizer {
  const destroyed: unknown[] = [];
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  let settle!: { release: () => void; reject: (error: Error) => void };
  const gate = new Promise<void>((resolve, reject) => {
    settle = { release: resolve, reject };
  });
  const destroy = activity({
    name,
    execute: async (input: unknown) => {
      destroyed.push(input);
      signalStarted();
      await gate;
    },
  });
  return { destroy, started, release: settle.release, reject: settle.reject, destroyed };
}

/**
 * Wait (without reaching into engine internals) until a finalizer-bearing workflow has
 * recorded its resource and parked: poll the durable `finalizerState` key, which the
 * suspend commit flushes when the inline workflow parks on `waitForSignal` after
 * `ctx.setFinalizerState`. This is the exact precondition the teardown marker needs, so
 * cancelling after it stages the marker deterministically — never a sleep-before-assert.
 */
async function waitForRecordedState(engine: Engine, workflowId: string): Promise<void> {
  await waitForCondition(
    async () => (await engine.storage.get(KEYS.finalizerState(workflowId))) !== null,
    {
      label: `workflow ${workflowId} recorded finalizer state and parked`,
      timeoutMs: 2000,
      intervalMs: 5,
    },
  );
}

/**
 * Wait until a workflow that records NO finalizer state has parked: poll its durable
 * checkpoint, written by the suspend commit. Used only by the "no marker is written"
 * cases, which do not depend on any recorded resource.
 */
async function waitForParked(engine: Engine, workflowId: string): Promise<void> {
  await waitForCondition(
    async () => (await engine.storage.get(KEYS.checkpoint(workflowId))) !== null,
    {
      label: `workflow ${workflowId} parked on waitForSignal (checkpoint committed)`,
      timeoutMs: 2000,
      intervalMs: 5,
    },
  );
}

/**
 * Start a finalizer-bearing workflow, wait for it to park, then cancel it so the
 * teardown marker + timer are staged. Returns the live `now` getter's current value is
 * supplied by the caller's closure, so the caller controls the clock.
 */
async function startAndCancel(engine: Engine, type: string, id: string): Promise<void> {
  const handle = await engine.start(type, null, { id });
  await waitForRecordedState(engine, id);
  await engine.cancel(handle.id);
  await expect(handle.result()).rejects.toThrow('Workflow cancelled');
}

/** Register a finalizer-bearing workflow that records `sandboxId` then parks forever. */
function registerTeardownWorkflow(
  engine: Engine,
  type: string,
  finalizer: AnyActivityDefinition,
  sandboxId: string,
): void {
  const provision = workflow({ name: type, finalizer }).execute(async function* (
    ctx: WorkflowContext,
  ) {
    ctx.setFinalizerState({ sandboxId });
    yield* ctx.waitForSignal('never');
  });
  engine.register(provision);
}

/** Collect `workflow:teardown` events as `{ status, attempts, error }` tuples. */
function collectTeardownEvents(
  engine: Engine,
): Array<{ workflowId: string; status: WorkflowTeardownStatus; attempts: number; error?: string }> {
  const events: Array<{
    workflowId: string;
    status: WorkflowTeardownStatus;
    attempts: number;
    error?: string;
  }> = [];
  engine.addEventListener('workflow:teardown', (event) => {
    events.push({
      workflowId: event.workflowId,
      status: event.status,
      attempts: event.attempts,
      ...(event.error === undefined ? {} : { error: event.error }),
    });
  });
  return events;
}

describe('engine-driven finalizer teardown (#446 Phase 2)', () => {
  it('runs the finalizer with the recorded state after the workflow is cancelled', async () => {
    const destroyed: unknown[] = [];
    const destroySandbox = activity({
      name: 'destroy-sandbox-cancel',
      execute: async (input: unknown) => {
        destroyed.push(input);
      },
    });

    const now = 1_000_000;
    const engine = new Engine({ getNow: () => now });
    registerTeardownWorkflow(engine, 'teardown-on-cancel', destroySandbox, 'sbx-cancel');
    const events = collectTeardownEvents(engine);

    await startAndCancel(engine, 'teardown-on-cancel', 'teardown-cancel-1');

    // The teardown timer fires at terminalization time — tick the scheduler to drive it.
    await engine.scheduler.tick(now);

    expect(destroyed).toEqual([{ sandboxId: 'sbx-cancel' }]);
    expect(events).toEqual([{ workflowId: 'teardown-cancel-1', status: 'completed', attempts: 1 }]);

    // Both durable keys are swept once the finalizer succeeds.
    expect(await engine.storage.get(KEYS.teardownOwed('teardown-cancel-1'))).toBeNull();
    expect(await engine.storage.get(KEYS.finalizerState('teardown-cancel-1'))).toBeNull();

    engine[Symbol.dispose]();
  });

  it('runs the finalizer after the workflow times out', async () => {
    const destroyed: unknown[] = [];
    const destroySandbox = activity({
      name: 'destroy-sandbox-timeout',
      execute: async (input: unknown) => {
        destroyed.push(input);
      },
    });

    const now = 1_000_000;
    const engine = new Engine({ getNow: () => now });
    registerTeardownWorkflow(engine, 'teardown-on-timeout', destroySandbox, 'sbx-timeout');

    const handle = await engine.start('teardown-on-timeout', null, { id: 'teardown-timeout-1' });
    await waitForRecordedState(engine, 'teardown-timeout-1');
    await engine.timeout(handle.id);
    await expect(handle.result()).rejects.toThrow('exceeded execution timeout');

    await engine.scheduler.tick(now);

    expect(destroyed).toEqual([{ sandboxId: 'sbx-timeout' }]);

    engine[Symbol.dispose]();
  });

  it('does not drive a finalizer when the workflow type declares none', async () => {
    const now = 1_000_000;
    const engine = new Engine({ getNow: () => now });
    const provision = workflow({ name: 'teardown-no-finalizer' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.waitForSignal('never');
    });
    engine.register(provision);

    const handle = await engine.start('teardown-no-finalizer', null, { id: 'teardown-none-1' });
    await waitForParked(engine, 'teardown-none-1');
    await engine.cancel(handle.id);
    await expect(handle.result()).rejects.toThrow('Workflow cancelled');
    await engine.scheduler.tick(now);

    // No finalizer declared → no owed marker is ever written.
    expect(await engine.storage.get(KEYS.teardownOwed('teardown-none-1'))).toBeNull();

    engine[Symbol.dispose]();
  });

  it('does not drive a finalizer when no resource was recorded', async () => {
    let finalizerRan = false;
    const destroySandbox = activity({
      name: 'destroy-sandbox-unrecorded',
      execute: async () => {
        finalizerRan = true;
      },
    });

    const now = 1_000_000;
    const engine = new Engine({ getNow: () => now });
    // Declares a finalizer but never calls ctx.setFinalizerState, so there is no
    // resource to destroy — the engine must not drive the finalizer.
    const provision = workflow({
      name: 'teardown-no-state',
      finalizer: destroySandbox,
    }).execute(async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('never');
    });
    engine.register(provision);

    const handle = await engine.start('teardown-no-state', null, { id: 'teardown-nostate-1' });
    await waitForParked(engine, 'teardown-nostate-1');
    await engine.cancel(handle.id);
    await expect(handle.result()).rejects.toThrow('Workflow cancelled');
    await engine.scheduler.tick(now);

    expect(finalizerRan).toBe(false);
    expect(await engine.storage.get(KEYS.teardownOwed('teardown-nostate-1'))).toBeNull();

    engine[Symbol.dispose]();
  });

  it('retries the finalizer on failure and emits a failed event, then succeeds', async () => {
    let attempts = 0;
    const flakyDestroy = activity({
      name: 'destroy-sandbox-flaky',
      execute: async () => {
        attempts += 1;
        if (attempts < 2) throw new Error('transient destroy failure');
      },
    });

    let now = 1_000_000;
    const engine = new Engine({ getNow: () => now });
    registerTeardownWorkflow(engine, 'teardown-retry', flakyDestroy, 'sbx-retry');
    const events = collectTeardownEvents(engine);

    await startAndCancel(engine, 'teardown-retry', 'teardown-retry-1');

    // First attempt fails → failed event + owed marker re-armed for backoff.
    await engine.scheduler.tick(now);
    expect(events).toEqual([
      {
        workflowId: 'teardown-retry-1',
        status: 'failed',
        attempts: 1,
        error: 'transient destroy failure',
      },
    ]);
    expect(await engine.storage.get(KEYS.teardownOwed('teardown-retry-1'))).not.toBeNull();

    // Advance the clock past the first backoff window (1m) so the rescheduled
    // timer is due, then tick again — the retry succeeds.
    now += 120_000;
    await engine.scheduler.tick(now);
    expect(events[1]).toEqual({ workflowId: 'teardown-retry-1', status: 'completed', attempts: 2 });
    expect(attempts).toBe(2);
    expect(await engine.storage.get(KEYS.teardownOwed('teardown-retry-1'))).toBeNull();
    expect(await engine.storage.get(KEYS.finalizerState('teardown-retry-1'))).toBeNull();

    engine[Symbol.dispose]();
  });

  it('dead-letters the teardown at the retry horizon, leaving a durable record with the failed input', async () => {
    const alwaysFails = activity({
      name: 'destroy-sandbox-doomed',
      execute: async () => {
        throw new Error('permanent destroy failure');
      },
    });

    let now = 2_000_000;
    const engine = new Engine({ getNow: () => now });
    registerTeardownWorkflow(engine, 'teardown-deadletter', alwaysFails, 'sbx-doomed');
    const events = collectTeardownEvents(engine);

    await startAndCancel(engine, 'teardown-deadletter', 'teardown-dl-1');

    // Drive every backoff window: 8 attempts, each rescheduled at most +1h, so
    // advancing 2h between ticks always makes the next attempt due.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await engine.scheduler.tick(now);
      if (events.some((event) => event.status === 'dead-lettered')) break;
      now += 7_200_000;
    }

    const deadLettered = events.find((event) => event.status === 'dead-lettered');
    expect(deadLettered).toEqual({
      workflowId: 'teardown-dl-1',
      status: 'dead-lettered',
      attempts: 8,
      error: 'permanent destroy failure',
    });

    // Owed marker + finalizer state are gone; the dead-letter record survives with the
    // full audit shape, including the recorded resource input. (testing MF4.)
    expect(await engine.storage.get(KEYS.teardownOwed('teardown-dl-1'))).toBeNull();
    expect(await engine.storage.get(KEYS.finalizerState('teardown-dl-1'))).toBeNull();
    const deadLetterBytes = await engine.storage.get(KEYS.teardownDeadLetter('teardown-dl-1'));
    expect(deadLetterBytes).not.toBeNull();
    const record = decode(deadLetterBytes!) as TeardownDeadLetterRecord;
    expect(record.type).toBe('teardown-deadletter');
    expect(record.attempts).toBe(8);
    expect(record.lastError).toContain('permanent destroy failure');
    expect(record.finalizerInput).toEqual({ sandboxId: 'sbx-doomed' });
    expect(typeof record.deadLetteredAt).toBe('number');

    engine[Symbol.dispose]();
  });

  it('re-drives a stale running claim after an engine crash mid-teardown (DISCRIMINATING)', async () => {
    // The load-bearing test: a `running` claim left behind by a crashed holder (its drive
    // never settled) must be reclaimed by a fresh engine — but only once the claim is STALE
    // by TIME, never while it could still be live. We simulate the crash by writing the
    // `running` claim directly to the shared store (engine1 claimed `owed → running`, then
    // died before settling), avoiding any dangling in-flight promise. The discriminating
    // assertion is the two-tick split: engine2 must BACK OFF on a fresh claim and only
    // reclaim after the clock crosses the stale threshold. A reclaim-immediately bug or a
    // never-reclaim bug each fail exactly one of the two ticks.
    const storage = new MemoryStorage();
    let now = 3_000_000;
    const destroyedBy: string[] = [];

    // engine1 stages the teardown (owed marker + timer + finalizer state) via the real
    // terminal path, then we overwrite the marker to the `running` state a crashed holder
    // would leave behind. Its placeholder finalizer never actually runs.
    const placeholder = activity({ name: 'destroy-sandbox-crash', execute: async () => {} });
    const engine1 = new Engine({ storage, getNow: () => now });
    registerTeardownWorkflow(engine1, 'teardown-crash', placeholder, 'sbx-crash');

    await startAndCancel(engine1, 'teardown-crash', 'teardown-crash-1');

    // Read the real claim token so the running-claim overwrite stays aligned with its timer.
    const owedBytes = await storage.get(KEYS.teardownOwed('teardown-crash-1'));
    expect(owedBytes).not.toBeNull();
    const owed = decode(owedBytes!) as TeardownClaim;
    const staleRunning: TeardownClaim = {
      status: 'running',
      attempts: owed.attempts,
      token: owed.token,
      claimedAt: now, // claimed "now" by engine1; will age into staleness below.
    };
    await storage.batch([
      { type: 'put', key: KEYS.teardownOwed('teardown-crash-1'), value: encode(staleRunning) },
    ]);
    engine1[Symbol.dispose](); // "crash" — no in-flight drive, no leaked promise.

    // engine2 on the same store: a completing finalizer that records the destroying engine.
    const completingDestroy = activity({
      name: 'destroy-sandbox-crash',
      execute: async () => {
        destroyedBy.push('engine-2');
      },
    });
    const engine2 = new Engine({ storage, getNow: () => now });
    registerTeardownWorkflow(engine2, 'teardown-crash', completingDestroy, 'sbx-crash');
    await engine2.recoverAll();

    // First tick: the `running` claim is FRESH (claimedAt === now) — engine2 must back off,
    // leaving the claim and re-arming, NOT reclaiming a possibly-live holder.
    await engine2.scheduler.tick(now);
    expect(destroyedBy).toEqual([]);
    expect(await storage.get(KEYS.teardownOwed('teardown-crash-1'))).not.toBeNull();

    // Advance past the stale threshold (no finalizer timeout → 5m budget + 30s margin).
    now += 330_001;
    await engine2.scheduler.tick(now);

    // Now the stale claim is reclaimed, the finalizer re-runs, and the keys are cleared.
    expect(destroyedBy).toEqual(['engine-2']);
    expect(await storage.get(KEYS.teardownOwed('teardown-crash-1'))).toBeNull();
    expect(await storage.get(KEYS.finalizerState('teardown-crash-1'))).toBeNull();

    engine2[Symbol.dispose]();
  });

  it('does not consume a retry when the in-flight finalizer is aborted by engine shutdown', async () => {
    // A clean engine disposal that aborts a cooperating finalizer is NOT a finalizer
    // failure: the next owner must retry from the SAME attempt count, never advancing the
    // dead-letter horizon just because the engine was disposed. (Codex MF4 / junior MF2.)
    const storage = new MemoryStorage();
    let now = 4_000_000;

    // A finalizer that cooperates with its abort signal: it rejects when aborted, which
    // `runFinalizerActivity` reports as abortedByShutdown.
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cooperating = activity({
      name: 'destroy-cooperating',
      execute: (_input: unknown, context?: { signal: AbortSignal }) => {
        entered();
        return new Promise<void>((_resolve, reject) => {
          context?.signal.addEventListener('abort', () => reject(context.signal.reason), {
            once: true,
          });
        });
      },
    });

    const engine1 = new Engine({ storage, getNow: () => now });
    registerTeardownWorkflow(engine1, 'teardown-shutdown', cooperating, 'sbx-shutdown');
    await startAndCancel(engine1, 'teardown-shutdown', 'teardown-shutdown-1');

    // Claim + start the finalizer, then dispose mid-flight (aborts the cooperating run).
    const drive = engine1.scheduler.tick(now);
    await enteredPromise;
    engine1[Symbol.dispose]();
    await drive;

    // The marker is back to `owed` with attempts UNCHANGED at 0 (no attempt was charged).
    const markerBytes = await storage.get(KEYS.teardownOwed('teardown-shutdown-1'));
    expect(markerBytes).not.toBeNull();
    expect(decode(markerBytes!)).toMatchObject({ status: 'owed', attempts: 0 });
    expect(await storage.get(KEYS.teardownDeadLetter('teardown-shutdown-1'))).toBeNull();

    // A fresh engine re-drives it to success on attempt 1.
    const destroyed: unknown[] = [];
    const completing = activity({
      name: 'destroy-cooperating',
      execute: async (input: unknown) => {
        destroyed.push(input);
      },
    });
    const engine2 = new Engine({ storage, getNow: () => now });
    registerTeardownWorkflow(engine2, 'teardown-shutdown', completing, 'sbx-shutdown');
    const events = collectTeardownEvents(engine2);
    await engine2.recoverAll();
    now += 60_000; // past the self-heal re-arm delay so the re-armed timer is due.
    await engine2.scheduler.tick(now);

    expect(destroyed).toEqual([{ sandboxId: 'sbx-shutdown' }]);
    expect(events).toEqual([
      { workflowId: 'teardown-shutdown-1', status: 'completed', attempts: 1 },
    ]);

    engine2[Symbol.dispose]();
  });
});

describe('finalizer teardown interlocks with deletion paths (#446 Phase 2)', () => {
  it('refuses to purge a workflow while its teardown is still owed, then purges once cleared', async () => {
    // While the teardown is owed (a held-open finalizer keeps the `running` claim),
    // purge must skip the run — deleting it would drop the finalizer-state input → leak.
    // Once the finalizer succeeds and clears the marker, purge proceeds. (testing suggestion.)
    const blocking = createControllableFinalizer('destroy-sandbox-purge');
    const storage = new MemoryStorage();
    const now = 1_000_000;
    const engine = new Engine({ storage, getNow: () => now });
    registerTeardownWorkflow(engine, 'teardown-purge-gate', blocking.destroy, 'sbx-purge');

    await startAndCancel(engine, 'teardown-purge-gate', 'teardown-purge-1');

    // Claim + start the held-open finalizer so the owed marker is held as `running`.
    const drive = engine.scheduler.tick(now);
    await blocking.started;
    // finally ensures the held-open finalizer + its drive are settled and the engine
    // disposed even if an assertion throws — no leaked background promise. (round-2 testing MF.)
    try {
      const blocked = await engine.purge();
      expect(blocked.deleted).toBe(0);
      // The workflow record survives because the teardown is still owed.
      expect(await storage.get(KEYS.workflow('teardown-purge-1'))).not.toBeNull();
      expect(await storage.get(KEYS.finalizerState('teardown-purge-1'))).not.toBeNull();

      // Let the finalizer finish; the marker clears, so purge now proceeds.
      blocking.release();
      await drive;
      expect(await storage.get(KEYS.teardownOwed('teardown-purge-1'))).toBeNull();

      const unblocked = await engine.purge();
      expect(unblocked.deleted).toBe(1);
      expect(await storage.get(KEYS.workflow('teardown-purge-1'))).toBeNull();
    } finally {
      blocking.release();
      await drive;
      engine[Symbol.dispose]();
    }
  });

  it('bulk-delete skips a teardown-owing workflow and reports it', async () => {
    const blocking = createControllableFinalizer('destroy-sandbox-bulk');
    const storage = new MemoryStorage();
    const now = 1_000_000;
    const engine = new Engine({ storage, getNow: () => now });
    registerTeardownWorkflow(engine, 'teardown-bulk-skip', blocking.destroy, 'sbx-bulk');

    await startAndCancel(engine, 'teardown-bulk-skip', 'teardown-bulk-1');

    const drive = engine.scheduler.tick(now);
    await blocking.started;
    try {
      const result = await engine.deleteAll({ status: ['cancelled'] });
      expect(result.deleted).toBe(0);
      expect(result.skippedTeardownPending).toEqual(['teardown-bulk-1']);
      expect(await storage.get(KEYS.workflow('teardown-bulk-1'))).not.toBeNull();
    } finally {
      // Settle the held-open finalizer + its drive and dispose, even on assertion failure.
      blocking.release();
      await drive;
      engine[Symbol.dispose]();
    }
  });

  it('rejects a start-new restart with a transient error while teardown is owed', async () => {
    const blocking = createControllableFinalizer('destroy-sandbox-startnew');
    const storage = new MemoryStorage();
    const now = 1_000_000;
    const engine = new Engine({ storage, getNow: () => now });
    registerTeardownWorkflow(engine, 'teardown-start-new', blocking.destroy, 'sbx-startnew');

    await startAndCancel(engine, 'teardown-start-new', 'teardown-startnew-1');

    const drive = engine.scheduler.tick(now);
    await blocking.started;
    try {
      // Restarting under the same id while teardown is owed must be refused with the
      // distinct, transient error — never silently displacing the prior finalizer.
      await expect(
        engine.start('teardown-start-new', null, {
          id: 'teardown-startnew-1',
          onTerminalConflict: 'start-new',
        }),
      ).rejects.toBeInstanceOf(WorkflowTeardownPendingError);

      // The prior run's finalizer state is intact (not displaced by the restart).
      expect(await storage.get(KEYS.finalizerState('teardown-startnew-1'))).not.toBeNull();
    } finally {
      blocking.release();
      await drive;
      engine[Symbol.dispose]();
    }
  });
});
