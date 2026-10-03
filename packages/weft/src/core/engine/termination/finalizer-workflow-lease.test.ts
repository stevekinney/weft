/**
 * COR-1415: the engine-driven finalizer drive arbitrates by the `teardownOwed` marker's
 * byte-for-byte CAS alone, in every ownership mode.
 *
 * A cancelled or timed-out workflow owes its definition-level finalizer after a terminal
 * that has already released (or rotated away) the workflow's per-workflow claim, so a marker
 * write fenced on `wf-owner-epoch:<id>` fails closed forever. These tests pin that every
 * teardown marker and timer write is engine-scoped, that no teardown hold ever enters the
 * workflow claim registry (so the reclaim scan cannot take one over), and that the claim CAS
 * arms a watchdog timer in the same batch, which is what keeps a crashed winner live. They
 * also pin the timer discipline: a loser stays silent, so timers never multiply across
 * engines, and every retry carries a new token, so a leftover timer cannot start an attempt
 * ahead of its backoff.
 *
 * Time is a controllable `now` per engine; synchronization is polling durable keys or
 * awaiting the drive itself, never a sleep.
 */
import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../../storage/interface.ts';
import { MemoryStorage } from '../../../storage/memory.ts';
import { waitForCondition } from '../../../testing/fake-timers.test-support.ts';
import { collectTeardownEvents } from '../../__tests__/finalizer-teardown.test-support.ts';
import { decode } from '../../codec.ts';
import { Engine } from '../../engine.ts';
import type { WorkflowTeardownStatus } from '../../events.ts';
import type { AnyActivityDefinition, WorkflowContext } from '../../types.ts';
import { activity, workflow } from '../../types.ts';
import { getInternals } from '../internals.ts';
import { createTeardownTimerId, type TeardownClaim } from '../state-utilities.ts';
import type { RunnableFinalizer } from './finalizer-activity.ts';
import {
  claimTeardownMarker,
  encodeOwedClaim,
  encodeRunningClaim,
  fireAtAfterFired,
  observedMarkerHold,
  OUTSIDE_FIRED_TIMER,
  rearmLiveClaimWatchdog,
  rearmTeardownTimer,
  reassertOwedAfterShutdown,
  settleOnRunningClaim,
  teardownBackoffMs,
  teardownTimerOperations,
} from './finalizer-claim.ts';

/** Past the default finalizer stale-running horizon (5m budget + 30s margin). */
const STALE_RUNNING_HORIZON_MS = 6 * 60_000;
/** The stale-running horizon of a finalizer with no timeout: 5m budget + 30s margin. */
const DEFAULT_STALE_HORIZON_MS = 5 * 60_000 + 30_000;
/** Well past the 1m claim TTL, well inside the stale-running horizon. */
const PAST_CLAIM_TTL_MS = 5 * 60_000;
const SELF_HEAL_INTERVAL_MS = 30_000;
const TEARDOWN_TIMER_PREFIX = 'wf-teardown:';

type Mode = 'workflow-lease' | 'lease' | 'none';
type Clock = { now: number };

const ALL_MODES: readonly Mode[] = ['workflow-lease', 'lease', 'none'];
/** Modes that can host several live engines on one store. */
const MULTI_ENGINE_MODES: readonly Mode[] = ['workflow-lease', 'none'];

async function createEngine(mode: Mode, storage: MemoryStorage, clock: Clock): Promise<Engine> {
  if (mode === 'lease') {
    return Engine.create({
      storage,
      ownership: 'lease',
      startScheduler: false,
      recover: false,
      getNow: () => clock.now,
    });
  }
  return Engine.create({
    storage,
    ownership: mode,
    ...(mode === 'workflow-lease'
      ? { workflowClaimTtl: '1m', workflowClaimRenewInterval: '5s' }
      : {}),
    recover: false,
    backgroundTasks: 'manual',
    getNow: () => clock.now,
  });
}

function registerTeardownType(
  engine: Engine,
  type: string,
  finalizer: AnyActivityDefinition,
): void {
  engine.register(
    workflow({ name: type, finalizer }).execute(async function* (ctx: WorkflowContext) {
      ctx.setFinalizerState({ sandboxId: `sandbox-${ctx.workflowId}` });
      yield* ctx.waitForSignal('never');
    }),
  );
}

function countingFinalizer(name: string): { destroy: AnyActivityDefinition; destroyed: unknown[] } {
  const destroyed: unknown[] = [];
  const destroy = activity({
    name,
    execute: async (input: unknown) => {
      destroyed.push(input);
    },
  });
  return { destroy, destroyed };
}

/**
 * A finalizer whose FIRST call parks on a gate (and signals it started); later calls finish
 * immediately. `release()` lets the parked call return.
 */
/** A structurally runnable finalizer for tests that call the claim primitives directly. */
function noopFinalizer(name: string): RunnableFinalizer {
  return { name, execute: async () => undefined };
}

function parkedFinalizer(name: string): {
  destroy: AnyActivityDefinition;
  starts: () => number;
  started: Promise<void>;
  release: () => void;
} {
  let starts = 0;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const destroy = activity({
    name,
    execute: async () => {
      starts += 1;
      if (starts === 1) {
        signalStarted();
        await gate;
      }
    },
  });
  return { destroy, starts: () => starts, started, release };
}

async function startAndTerminate(
  engine: Engine,
  storage: MemoryStorage,
  type: string,
  id: string,
  terminate: 'cancel' | 'timeout' = 'cancel',
): Promise<void> {
  const handle = await engine.start(type, null, { id });
  await waitForCondition(async () => (await storage.get(KEYS.finalizerState(id))) !== null, {
    label: `workflow ${id} recorded finalizer state and parked`,
    timeoutMs: 2000,
    intervalMs: 5,
  });
  if (terminate === 'cancel') {
    await engine.cancel(id);
  } else {
    await engine.timeout(id);
  }
  await handle.result().then(
    () => {
      throw new Error(`workflow ${id} unexpectedly completed`);
    },
    () => undefined,
  );
}

const timerCount = (storage: MemoryStorage): Promise<number> =>
  storage.count(TEARDOWN_TIMER_PREFIX);

async function readClaim(storage: MemoryStorage, id: string): Promise<TeardownClaim | null> {
  const bytes = await storage.get(KEYS.teardownOwed(id));
  return bytes === null ? null : (decode(bytes) as TeardownClaim);
}

/** Every `wf-teardown:` key currently in storage, for asserting exact timer identity. */
async function timerKeys(storage: MemoryStorage): Promise<string[]> {
  const keys: string[] = [];
  for await (const [key] of storage.scan(TEARDOWN_TIMER_PREFIX)) keys.push(key);
  return keys;
}

for (const mode of ALL_MODES) {
  describe(`finalizer teardown, ownership: ${mode} (COR-1415)`, () => {
    it('runs the definition-level finalizer exactly once after cancel and reports succeeded', async () => {
      const storage = new MemoryStorage();
      const clock: Clock = { now: 1_000_000 };
      const { destroy, destroyed } = countingFinalizer(`destroy-cancel-${mode}`);
      await using engine = await createEngine(mode, storage, clock);
      registerTeardownType(engine, `cancel-${mode}`, destroy);
      const events = collectTeardownEvents(engine);
      const id = `cancel-${mode}-1`;

      await startAndTerminate(engine, storage, `cancel-${mode}`, id);
      await engine.scheduler.tick(clock.now);

      expect(destroyed).toEqual([{ sandboxId: `sandbox-${id}` }]);
      expect(events).toEqual([{ workflowId: id, status: 'completed', attempts: 1 }]);
      expect(await engine.getFinalizerStatus(id)).toMatchObject({ status: 'succeeded' });
      expect(await storage.get(KEYS.teardownOwed(id))).toBeNull();
      expect(await storage.get(KEYS.finalizerState(id))).toBeNull();
      // Neither the fired timer nor the watchdog the claim armed outlives the settle.
      expect(await timerCount(storage)).toBe(0);

      // A second tick finds nothing to drive: still exactly one run.
      clock.now += SELF_HEAL_INTERVAL_MS;
      await engine.scheduler.tick(clock.now);
      expect(destroyed).toHaveLength(1);
    });

    it('runs the definition-level finalizer exactly once after an execution timeout', async () => {
      const storage = new MemoryStorage();
      const clock: Clock = { now: 2_000_000 };
      const { destroy, destroyed } = countingFinalizer(`destroy-timeout-${mode}`);
      await using engine = await createEngine(mode, storage, clock);
      registerTeardownType(engine, `timeout-${mode}`, destroy);
      const events = collectTeardownEvents(engine);
      const id = `timeout-${mode}-1`;

      await startAndTerminate(engine, storage, `timeout-${mode}`, id, 'timeout');
      await engine.scheduler.tick(clock.now);

      expect(destroyed).toEqual([{ sandboxId: `sandbox-${id}` }]);
      expect(events).toEqual([{ workflowId: id, status: 'completed', attempts: 1 }]);
      expect(await engine.getFinalizerStatus(id)).toMatchObject({ status: 'succeeded' });
      expect(await storage.get(KEYS.teardownOwed(id))).toBeNull();
      expect(await timerCount(storage)).toBe(0);
    });

    it('does not start the next attempt before its backoff when an earlier stray timer fires', async () => {
      const storage = new MemoryStorage();
      const clock: Clock = { now: 3_000_000 };
      let calls = 0;
      const failing = activity({
        name: `destroy-backoff-${mode}`,
        execute: async () => {
          calls += 1;
          throw new Error('provider is down');
        },
      });
      await using engine = await createEngine(mode, storage, clock);
      registerTeardownType(engine, `backoff-${mode}`, failing);
      const events = collectTeardownEvents(engine);
      const id = `backoff-${mode}-1`;
      await startAndTerminate(engine, storage, `backoff-${mode}`, id);

      const staleTokens: string[] = [(await readClaim(storage, id))!.token];
      await engine.scheduler.tick(clock.now);
      expect(calls).toBe(1);

      let attempt = 1;
      let settledAt = clock.now;
      for (let step = 0; step < 7; step += 1) {
        const marker = (await readClaim(storage, id))!;
        expect(marker).toMatchObject({ status: 'owed', attempts: attempt });
        // Every retry settle writes a NEW token, so no earlier timer can drive it.
        expect(staleTokens).not.toContain(marker.token);
        const markerBytes = await storage.get(KEYS.teardownOwed(id));
        const dueAt = settledAt + teardownBackoffMs(attempt);

        // A leftover timer for each earlier claim comes due ahead of the backoff.
        for (const staleToken of staleTokens) {
          await storage.batch(
            teardownTimerOperations(staleToken, id, dueAt - 1_000, OUTSIDE_FIRED_TIMER),
          );
        }
        clock.now = dueAt - 1_000;
        await engine.scheduler.tick(clock.now);
        expect(calls).toBe(attempt);
        expect(await storage.get(KEYS.teardownOwed(id))).toEqual(markerBytes);
        expect(await timerCount(storage)).toBe(1);

        staleTokens.push(marker.token);
        clock.now = dueAt;
        settledAt = dueAt;
        await engine.scheduler.tick(clock.now);
        attempt += 1;
        expect(calls).toBe(attempt);
      }

      // Attempts advanced by exactly one per backoff, up to the dead-letter horizon.
      expect(calls).toBe(8);
      const expectedStatuses: WorkflowTeardownStatus[] = [
        ...Array.from({ length: 7 }, (): WorkflowTeardownStatus => 'failed'),
        'dead-lettered',
      ];
      expect(events.map((event) => event.status)).toEqual(expectedStatuses);
      expect(await storage.get(KEYS.teardownOwed(id))).toBeNull();
      // The durable dead-letter record reads back as a failed finalizer at the horizon.
      expect(await engine.getFinalizerStatus(id)).toMatchObject({ status: 'failed', attempts: 8 });
      expect(await timerCount(storage)).toBe(0);
    });

    it('clears an undecodable marker instead of waiting on it forever', async () => {
      const storage = new MemoryStorage();
      const clock: Clock = { now: 4_000_000 };
      const { destroy, destroyed } = countingFinalizer(`destroy-corrupt-${mode}`);
      await using engine = await createEngine(mode, storage, clock);
      registerTeardownType(engine, `corrupt-${mode}`, destroy);
      const events = collectTeardownEvents(engine);
      const id = `corrupt-${mode}-1`;
      await startAndTerminate(engine, storage, `corrupt-${mode}`, id);

      await storage.batch([
        { type: 'put', key: KEYS.teardownOwed(id), value: new Uint8Array([0xff, 0xfe, 0xfd]) },
      ]);
      await engine.scheduler.tick(clock.now);

      expect(destroyed).toEqual([]);
      expect(events).toEqual([]);
      expect(await storage.get(KEYS.teardownOwed(id))).toBeNull();
      expect(await timerCount(storage)).toBe(0);
    });
  });
}

for (const mode of MULTI_ENGINE_MODES) {
  describe(`finalizer teardown across engines, ownership: ${mode} (COR-1415)`, () => {
    it('a crash between the terminal commit and the first timer fire leaves a timer for a second engine to adopt', async () => {
      const storage = new MemoryStorage();
      const clock: Clock = { now: 5_000_000 };
      const first = countingFinalizer(`destroy-crash-${mode}`);
      const engine1 = await createEngine(mode, storage, clock);
      registerTeardownType(engine1, `crash-${mode}`, first.destroy);
      const id = `crash-${mode}-1`;
      await startAndTerminate(engine1, storage, `crash-${mode}`, id);
      // The terminal commit staged the owed marker and exactly one first timer.
      expect(await readClaim(storage, id)).toMatchObject({ status: 'owed', attempts: 0 });
      expect(await timerCount(storage)).toBe(1);
      // engine1 "dies" before its teardown timer is ever driven.
      await engine1[Symbol.asyncDispose]();
      expect(first.destroyed).toEqual([]);

      const second = countingFinalizer(`destroy-crash-${mode}`);
      await using engine2 = await createEngine(mode, storage, clock);
      registerTeardownType(engine2, `crash-${mode}`, second.destroy);
      await engine2.recoverAll();
      await engine2.scheduler.tick(clock.now);

      expect(second.destroyed).toEqual([{ sandboxId: `sandbox-${id}` }]);
      expect(await engine2.getFinalizerStatus(id)).toMatchObject({ status: 'succeeded' });
      await engine2.scheduler.tick(clock.now + 1);
      expect(second.destroyed).toHaveLength(1);
    });

    it('a rearm resolution leaves exactly one live timer after the tick, even when the slot collides with the fired key', async () => {
      // The first engine terminates the workflow and dies; the second engine has no
      // registration for the type, so the fired teardown timer resolves to `rearm`. Its clock
      // reads behind the scheduler's, so the quantized self-heal slot equals the fired key,
      // which the scheduler deletes after the callback. The re-arm must land strictly later.
      const storage = new MemoryStorage();
      const firedAt = 3_000_000; // a multiple of the 30s self-heal interval.
      const clock1: Clock = { now: firedAt };
      const engine1 = await createEngine(mode, storage, clock1);
      registerTeardownType(
        engine1,
        `unregistered-${mode}`,
        countingFinalizer(`destroy-unreg-${mode}`).destroy,
      );
      const id = `unregistered-${mode}-1`;
      await startAndTerminate(engine1, storage, `unregistered-${mode}`, id);
      const token = (await readClaim(storage, id))!.token;
      await engine1[Symbol.asyncDispose]();
      expect(await timerKeys(storage)).toEqual([
        KEYS.teardownTimer(firedAt, createTeardownTimerId(token)),
      ]);

      // `now + 30s` lands exactly on the fired slot, so `nextSelfHealSlot(now)` collides.
      const clock2: Clock = { now: firedAt - SELF_HEAL_INTERVAL_MS };
      await using engine2 = await createEngine(mode, storage, clock2);
      await engine2.scheduler.tick(firedAt);

      expect(await timerKeys(storage)).toEqual([
        KEYS.teardownTimer(firedAt + SELF_HEAL_INTERVAL_MS, createTeardownTimerId(token)),
      ]);
      expect(await readClaim(storage, id)).toMatchObject({ status: 'owed', token });
    });

    it('engines racing the same fired timer and its successors run the finalizer once and never multiply timers', async () => {
      const storage = new MemoryStorage();
      // Each engine has its own clock, so a re-arm at `getNow() + delay` would write a
      // distinct timer key per engine.
      const clockA: Clock = { now: 6_000_000 };
      const clockB: Clock = { now: 6_000_001 };
      const clockC: Clock = { now: 6_000_002 };
      const parked = parkedFinalizer(`destroy-multiply-${mode}`);
      await using engineA = await createEngine(mode, storage, clockA);
      await using engineB = await createEngine(mode, storage, clockB);
      await using engineC = await createEngine(mode, storage, clockC);
      for (const engine of [engineA, engineB, engineC]) {
        registerTeardownType(engine, `multiply-${mode}`, parked.destroy);
      }
      const events = collectTeardownEvents(engineA);
      const id = `multiply-${mode}-1`;
      await startAndTerminate(engineA, storage, `multiply-${mode}`, id);

      const driveA = engineA.scheduler.tick(clockA.now);
      await parked.started;
      await Promise.all([engineB.scheduler.tick(clockB.now), engineC.scheduler.tick(clockC.now)]);

      // The losers are silent: the winner's claim armed the only live timer, its watchdog.
      expect(parked.starts()).toBe(1);
      const watchdogKeys = await timerKeys(storage);
      expect(watchdogKeys).toHaveLength(1);

      for (let interval = 0; interval < 4; interval += 1) {
        clockB.now += SELF_HEAL_INTERVAL_MS;
        clockC.now += SELF_HEAL_INTERVAL_MS;
        await Promise.all([engineB.scheduler.tick(clockB.now), engineC.scheduler.tick(clockC.now)]);
        expect(parked.starts()).toBe(1);
        expect(await timerKeys(storage)).toEqual(watchdogKeys);
      }

      parked.release();
      await driveA;
      expect(parked.starts()).toBe(1);
      expect(events).toEqual([{ workflowId: id, status: 'completed', attempts: 1 }]);
      expect(await engineB.getFinalizerStatus(id)).toMatchObject({ status: 'succeeded' });
      expect(await timerCount(storage)).toBe(0);
    });

    it('a winner that dies mid-finalizer is reclaimed by its watchdog exactly once', async () => {
      const storage = new MemoryStorage();
      const clockA: Clock = { now: 7_000_000 };
      const clockB: Clock = { now: 7_000_001 };
      const clockC: Clock = { now: 7_000_002 };
      const parked = parkedFinalizer(`destroy-watchdog-${mode}`);
      await using engineA = await createEngine(mode, storage, clockA);
      await using engineB = await createEngine(mode, storage, clockB);
      await using engineC = await createEngine(mode, storage, clockC);
      for (const engine of [engineA, engineB, engineC]) {
        registerTeardownType(engine, `watchdog-${mode}`, parked.destroy);
      }
      const eventsA = collectTeardownEvents(engineA);
      const eventsB = collectTeardownEvents(engineB);
      const eventsC = collectTeardownEvents(engineC);
      const id = `watchdog-${mode}-1`;
      await startAndTerminate(engineA, storage, `watchdog-${mode}`, id);

      const driveA = engineA.scheduler.tick(clockA.now);
      await parked.started;
      // A peer consumes the fired timer and yields; only the watchdog stays behind. A's
      // drive then "dies": it never returns until the end of the test.
      await engineB.scheduler.tick(clockB.now);
      expect(parked.starts()).toBe(1);
      expect(await timerCount(storage)).toBe(1);

      // Two peers reach the watchdog at the same moment: the marker CAS lets one reclaim.
      clockB.now += STALE_RUNNING_HORIZON_MS;
      clockC.now += STALE_RUNNING_HORIZON_MS;
      await Promise.all([engineB.scheduler.tick(clockB.now), engineC.scheduler.tick(clockC.now)]);

      // The first run never settled, so exactly one more run happens.
      expect(parked.starts()).toBe(2);
      expect([...eventsB, ...eventsC]).toEqual([
        { workflowId: id, status: 'completed', attempts: 1 },
      ]);
      expect(await engineB.getFinalizerStatus(id)).toMatchObject({ status: 'succeeded' });
      expect(await storage.get(KEYS.teardownOwed(id))).toBeNull();
      expect(await timerCount(storage)).toBe(0);

      clockB.now += SELF_HEAL_INTERVAL_MS;
      await engineB.scheduler.tick(clockB.now);
      expect(parked.starts()).toBe(2);

      // The original drive finally returns: its settle loses the CAS and says nothing.
      parked.release();
      await driveA;
      expect(eventsA).toEqual([]);
      expect(await storage.get(KEYS.teardownOwed(id))).toBeNull();
      expect(await timerCount(storage)).toBe(0);
      expect(await engineA.getFinalizerStatus(id)).toMatchObject({ status: 'succeeded' });
    });

    it('a watchdog firing after a successful settle is inert', async () => {
      const storage = new MemoryStorage();
      const clock: Clock = { now: 8_000_000 };
      const { destroy, destroyed } = countingFinalizer(`destroy-inert-${mode}`);
      await using engine = await createEngine(mode, storage, clock);
      registerTeardownType(engine, `inert-${mode}`, destroy);
      const id = `inert-${mode}-1`;
      await startAndTerminate(engine, storage, `inert-${mode}`, id);
      await engine.scheduler.tick(clock.now);
      expect(destroyed).toHaveLength(1);

      // A zombie's leftover timer for the settled claim lands after the settle.
      await rearmTeardownTimer(
        getInternals(engine),
        id,
        'zombie-token',
        1_000,
        OUTSIDE_FIRED_TIMER,
      );
      expect(await timerCount(storage)).toBe(1);
      clock.now += STALE_RUNNING_HORIZON_MS;
      await engine.scheduler.tick(clock.now);

      expect(destroyed).toHaveLength(1);
      expect(await storage.get(KEYS.teardownOwed(id))).toBeNull();
      expect(await timerCount(storage)).toBe(0);
      expect(await engine.getFinalizerStatus(id)).toMatchObject({ status: 'succeeded' });
    });

    it('a yield re-arms the watchdog when the horizon at fire time is longer than the one at claim time', async () => {
      // Engine A claims with a 10s finalizer timeout (horizon 40s) and dies. The engine that
      // later sees the watchdog reads a finalizer with no timeout (horizon 5m30s), so it
      // judges the claim fresh and yields. The fired watchdog is deleted by the scheduler, so
      // the yield itself must leave a timer at the longer horizon or the marker is stranded.
      const storage = new MemoryStorage();
      const clock: Clock = { now: 8_200_000 };
      const { destroy, destroyed } = countingFinalizer(`destroy-horizon-${mode}`);
      await using engine = await createEngine(mode, storage, clock);
      registerTeardownType(engine, `horizon-${mode}`, destroy);
      const id = `horizon-${mode}-1`;
      await startAndTerminate(engine, storage, `horizon-${mode}`, id);

      const owed = await readClaim(storage, id);
      const token = owed!.token;
      const owedBytes = (await storage.get(KEYS.teardownOwed(id)))!;
      const claimedAt = clock.now;
      const shortFinalizer: RunnableFinalizer = {
        ...noopFinalizer(`destroy-horizon-short-${mode}`),
        timeout: '10s',
      };
      expect(
        await claimTeardownMarker(
          getInternals(engine),
          id,
          owedBytes,
          0,
          token,
          shortFinalizer,
          OUTSIDE_FIRED_TIMER,
        ),
      ).not.toBeNull();

      // The claimer dies. Its watchdog (and the terminal commit's first timer) fire here.
      clock.now = claimedAt + 40_000;
      await engine.scheduler.tick(clock.now);
      expect(destroyed).toHaveLength(0);
      expect(await timerKeys(storage)).toEqual([
        KEYS.teardownTimer(claimedAt + DEFAULT_STALE_HORIZON_MS, createTeardownTimerId(token)),
      ]);

      // At the longer horizon the claim is stale and is reclaimed exactly once.
      clock.now = claimedAt + DEFAULT_STALE_HORIZON_MS;
      await engine.scheduler.tick(clock.now);
      expect(destroyed).toHaveLength(1);
      expect(await storage.get(KEYS.teardownOwed(id))).toBeNull();
      expect(await timerCount(storage)).toBe(0);
    });

    it('a yield re-arms the watchdog when a tick runs ahead of the engine clock', async () => {
      // `tick(now)` takes a caller-supplied `now`; the claim still reads fresh on the engine
      // clock, so the drive yields on the fired watchdog. The re-arm must not reuse the fired
      // key (the scheduler deletes it after the callback), or the marker is stranded.
      const storage = new MemoryStorage();
      const clock: Clock = { now: 8_300_000 };
      const { destroy, destroyed } = countingFinalizer(`destroy-ahead-${mode}`);
      await using engine = await createEngine(mode, storage, clock);
      registerTeardownType(engine, `ahead-${mode}`, destroy);
      const id = `ahead-${mode}-1`;
      await startAndTerminate(engine, storage, `ahead-${mode}`, id);

      const token = (await readClaim(storage, id))!.token;
      const owedBytes = (await storage.get(KEYS.teardownOwed(id)))!;
      const claimedAt = clock.now;
      expect(
        await claimTeardownMarker(
          getInternals(engine),
          id,
          owedBytes,
          0,
          token,
          noopFinalizer(`destroy-ahead-claimer-${mode}`),
          OUTSIDE_FIRED_TIMER,
        ),
      ).not.toBeNull();
      const watchdogAt = claimedAt + DEFAULT_STALE_HORIZON_MS;
      expect(await timerKeys(storage)).toContain(
        KEYS.teardownTimer(watchdogAt, createTeardownTimerId(token)),
      );

      clock.now = claimedAt + 10_000;
      await engine.scheduler.tick(watchdogAt);
      expect(destroyed).toHaveLength(0);
      expect(await timerKeys(storage)).toEqual([
        KEYS.teardownTimer(watchdogAt + SELF_HEAL_INTERVAL_MS, createTeardownTimerId(token)),
      ]);

      // The clock catches up: the claim is stale and the finalizer runs exactly once.
      clock.now = watchdogAt + SELF_HEAL_INTERVAL_MS;
      await engine.scheduler.tick(clock.now);
      expect(destroyed).toHaveLength(1);
      expect(await storage.get(KEYS.teardownOwed(id))).toBeNull();
      expect(await timerCount(storage)).toBe(0);
    });

    it('a self-heal re-arm waits the full interval even just before a slot boundary', async () => {
      const storage = new MemoryStorage();
      const clock: Clock = { now: 59_999 };
      await using engine = await createEngine(mode, storage, clock);

      await rearmTeardownTimer(
        getInternals(engine),
        `boundary-${mode}-1`,
        'boundary-token',
        30_000,
        OUTSIDE_FIRED_TIMER,
      );

      expect(await timerKeys(storage)).toEqual([
        KEYS.teardownTimer(90_000, createTeardownTimerId('boundary-token')),
      ]);
    });

    it('a reclaim whose watchdog would land on the fired key keeps a watchdog past it', async () => {
      // The previous claim armed its watchdog at claimedAt + 5m30s (no finalizer timeout). The
      // registered finalizer now has a 10s timeout (40s horizon), so a peer ticking at that
      // watchdog with a clock 40s behind it reclaims and arms its own watchdog at
      // `claimedAt + 40s`, which is exactly the fired key. The scheduler deletes the fired key
      // after the callback, so the watchdog must land strictly later or a reclaimer that dies
      // leaves a running marker with no timer.
      const storage = new MemoryStorage();
      const start = 9_000_000;
      const clock: Clock = { now: start };
      const id = `reclaim-collide-${mode}-1`;
      let token = '';
      const finalizer = activity({
        name: `destroy-reclaim-collide-${mode}`,
        timeout: '10s',
        execute: async () => {
          // A peer takes the marker mid-run (same token, its own claim time) so this attempt's
          // settle CAS loses and the claim watchdog is the only liveness left to inspect.
          await storage.put(KEYS.teardownOwed(id), encodeRunningClaim(1, token, clock.now + 5_000));
        },
      });
      await using engine = await createEngine(mode, storage, clock);
      registerTeardownType(engine, `reclaim-collide-${mode}`, finalizer);
      await startAndTerminate(engine, storage, `reclaim-collide-${mode}`, id);
      token = (await readClaim(storage, id))!.token;
      const owedBytes = (await storage.get(KEYS.teardownOwed(id)))!;
      await storage.delete(KEYS.teardownTimer(start, createTeardownTimerId(token)));
      expect(
        await claimTeardownMarker(
          getInternals(engine),
          id,
          owedBytes,
          0,
          token,
          noopFinalizer(`destroy-reclaim-collide-claimer-${mode}`),
          OUTSIDE_FIRED_TIMER,
        ),
      ).not.toBeNull();
      const firedAt = start + DEFAULT_STALE_HORIZON_MS;
      expect(await timerKeys(storage)).toEqual([
        KEYS.teardownTimer(firedAt, createTeardownTimerId(token)),
      ]);

      clock.now = firedAt - 40_000; // claimedAt + 40s === firedAt, and the claim is stale.
      await engine.scheduler.tick(firedAt);

      expect(await timerKeys(storage)).toEqual([
        KEYS.teardownTimer(firedAt + SELF_HEAL_INTERVAL_MS, createTeardownTimerId(token)),
      ]);
    });

    it('a failed attempt backs off past the fired key when that key is ahead of the engine clock', async () => {
      const storage = new MemoryStorage();
      const clock: Clock = { now: 9_500_000 };
      const failing = activity({
        name: `destroy-ahead-failure-${mode}`,
        execute: async () => {
          throw new Error('teardown failed');
        },
      });
      await using engine = await createEngine(mode, storage, clock);
      registerTeardownType(engine, `ahead-failure-${mode}`, failing);
      const id = `ahead-failure-${mode}-1`;
      await startAndTerminate(engine, storage, `ahead-failure-${mode}`, id);

      // The fired timer sits ten minutes ahead of the engine clock (a horizon armed by a peer
      // whose clock ran ahead), so `now + backoff` would precede the key that just fired.
      const token = (await readClaim(storage, id))!.token;
      const firedAt = clock.now + 10 * 60_000;
      await storage.delete(KEYS.teardownTimer(clock.now, createTeardownTimerId(token)));
      await storage.batch(teardownTimerOperations(token, id, firedAt, OUTSIDE_FIRED_TIMER));
      await engine.scheduler.tick(firedAt);

      expect(await readClaim(storage, id)).toMatchObject({ status: 'owed', attempts: 1 });
      const keys = await timerKeys(storage);
      expect(keys).toHaveLength(1);
      expect(keys.every((key) => key >= KEYS.teardownTimer(firedAt + 1, ''))).toBe(true);
    });

    it('every timer write a fired teardown callback can make lands strictly after the fired key', async () => {
      // The clock reads well behind the fired key, so each write's natural target collides with
      // or precedes it. Whatever the path, the scheduler deletes the fired key afterwards, so
      // every key left for the token must sort strictly after it.
      const firedAt = 20_000_000;
      const pastFired = KEYS.teardownTimer(firedAt + 1, '');
      const cases: {
        name: string;
        write: (context: {
          engine: Engine;
          id: string;
          token: string;
          owedBytes: Uint8Array;
        }) => Promise<void>;
      }[] = [
        {
          name: 'self-heal re-arm',
          write: ({ engine, id, token }) =>
            rearmTeardownTimer(getInternals(engine), id, token, SELF_HEAL_INTERVAL_MS, firedAt),
        },
        {
          name: 'live-claim watchdog re-arm at the fired key',
          write: ({ engine, id, token }) =>
            rearmLiveClaimWatchdog(getInternals(engine), id, token, firedAt, firedAt),
        },
        {
          name: 'live-claim watchdog re-arm before the fired key',
          write: ({ engine, id, token }) =>
            rearmLiveClaimWatchdog(getInternals(engine), id, token, firedAt - 1, firedAt),
        },
        {
          name: 'claim watchdog',
          write: async ({ engine, id, token, owedBytes }) => {
            await claimTeardownMarker(
              getInternals(engine),
              id,
              owedBytes,
              0,
              token,
              noopFinalizer(`destroy-table-claim-${mode}`),
              firedAt,
            );
          },
        },
        {
          name: 'shutdown re-assertion',
          write: async ({ engine, id, token, owedBytes }) => {
            const hold = await claimTeardownMarker(
              getInternals(engine),
              id,
              owedBytes,
              0,
              token,
              noopFinalizer(`destroy-table-shutdown-${mode}`),
              OUTSIDE_FIRED_TIMER,
            );
            await reassertOwedAfterShutdown(getInternals(engine), id, hold!, 0, firedAt);
          },
        },
        {
          name: 'raw teardown timer operations',
          write: async ({ engine, id, token }) => {
            await getInternals(engine).storage.batch(
              teardownTimerOperations(token, id, firedAt - 5, firedAt),
            );
          },
        },
      ];

      for (const { name, write } of cases) {
        const storage = new MemoryStorage();
        const clock: Clock = { now: 1_000_000 };
        await using engine = await createEngine(mode, storage, clock);
        registerTeardownType(
          engine,
          `table-${mode}`,
          countingFinalizer(`destroy-table-${mode}`).destroy,
        );
        const id = `table-${mode}-${name.replaceAll(' ', '-')}`;
        await startAndTerminate(engine, storage, `table-${mode}`, id);
        const token = (await readClaim(storage, id))!.token;
        const owedBytes = (await storage.get(KEYS.teardownOwed(id)))!;
        // Drop the terminal commit's own timer: only the write under test may remain.
        for (const key of await timerKeys(storage)) await storage.delete(key);

        await write({ engine, id, token, owedBytes });

        const keys = await timerKeys(storage);
        expect(keys.length, name).toBeGreaterThan(0);
        for (const key of keys) {
          expect(key >= pastFired, `${name}: ${key}`).toBe(true);
        }
      }
    });

    it('fireAtAfterFired keeps a strictly later target and bumps any other one', () => {
      expect(fireAtAfterFired(101, 100)).toBe(101);
      expect(fireAtAfterFired(100, 100)).toBe(100 + SELF_HEAL_INTERVAL_MS);
      expect(fireAtAfterFired(99, 100)).toBe(100 + SELF_HEAL_INTERVAL_MS);
      expect(fireAtAfterFired(5, OUTSIDE_FIRED_TIMER)).toBe(5);
    });

    it('self-heal re-arms from engines with different clocks collapse onto one timer', async () => {
      const storage = new MemoryStorage();
      const clockA: Clock = { now: 8_500_001 };
      const clockB: Clock = { now: 8_500_017 };
      await using engineA = await createEngine(mode, storage, clockA);
      await using engineB = await createEngine(mode, storage, clockB);
      const id = `slot-${mode}-1`;

      await rearmTeardownTimer(
        getInternals(engineA),
        id,
        'slot-token',
        SELF_HEAL_INTERVAL_MS,
        OUTSIDE_FIRED_TIMER,
      );
      await rearmTeardownTimer(
        getInternals(engineB),
        id,
        'slot-token',
        SELF_HEAL_INTERVAL_MS,
        OUTSIDE_FIRED_TIMER,
      );

      // Both land on the same quantized slot, so the key is shared rather than doubled.
      expect(await timerKeys(storage)).toEqual([
        KEYS.teardownTimer(8_550_000, createTeardownTimerId('slot-token')),
      ]);
    });

    it('a stale engine cannot corrupt the marker: its CAS fails on changed bytes', async () => {
      const storage = new MemoryStorage();
      const clock: Clock = { now: 9_000_000 };
      await using stale = await createEngine(mode, storage, clock);
      await using live = await createEngine(mode, storage, clock);
      const finalizer = noopFinalizer(`destroy-stale-cas-${mode}`);
      const id = `stale-cas-${mode}-1`;
      const token = 'stale-cas-token';
      const owedBytes = encodeOwedClaim(0, token);
      await storage.batch([{ type: 'put', key: KEYS.teardownOwed(id), value: owedBytes }]);

      // The live engine claims the marker; the stale engine still holds the owed bytes.
      const liveHold = await claimTeardownMarker(
        getInternals(live),
        id,
        owedBytes,
        0,
        token,
        finalizer,
        OUTSIDE_FIRED_TIMER,
      );
      expect(liveHold).not.toBeNull();
      const runningBytes = await storage.get(KEYS.teardownOwed(id));
      expect(runningBytes).toEqual(liveHold!.bytes);
      expect(await timerCount(storage)).toBe(1);

      const staleClaim = await claimTeardownMarker(
        getInternals(stale),
        id,
        owedBytes,
        0,
        token,
        finalizer,
        OUTSIDE_FIRED_TIMER,
      );
      expect(staleClaim).toBeNull();
      expect(
        await settleOnRunningClaim(getInternals(stale), id, observedMarkerHold(owedBytes), [
          { type: 'delete', key: KEYS.teardownOwed(id) },
        ]),
      ).toBe(false);
      // The lost CAS changed nothing: same marker bytes, still exactly one (the winner's) timer.
      expect(await storage.get(KEYS.teardownOwed(id))).toEqual(runningBytes);
      expect(await timerCount(storage)).toBe(1);
    });

    it('leaves the marker owed at the unchanged attempt count, under a new token, when disposal aborts the finalizer', async () => {
      const storage = new MemoryStorage();
      const clock: Clock = { now: 10_000_000 };
      let signalStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const destroy = activity({
        name: `destroy-abort-${mode}`,
        execute: async (_input: unknown, context?: { signal: AbortSignal }) => {
          signalStarted();
          await new Promise<void>((_resolve, reject) => {
            context?.signal.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          });
        },
      });
      const warnings: string[] = [];
      const onWarning = (warning: Error): void => {
        warnings.push(warning.name);
      };
      process.on('warning', onWarning);
      const id = `abort-${mode}-1`;
      let originalToken: string;
      try {
        const engine1 = await createEngine(mode, storage, clock);
        registerTeardownType(engine1, `abort-${mode}`, destroy);
        await startAndTerminate(engine1, storage, `abort-${mode}`, id);
        originalToken = (await readClaim(storage, id))!.token;
        const drive = engine1.scheduler.tick(clock.now);
        await started;
        await engine1[Symbol.asyncDispose]();
        await drive;
        // Let any queued process warning flush before asserting there was none.
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(warnings).not.toContain('WeftWorkflowClaimLostWarning');
        const marker = (await readClaim(storage, id))!;
        expect(marker).toMatchObject({ status: 'owed', attempts: 0 });
        expect(marker.token).not.toBe(originalToken);
        expect(await timerCount(storage)).toBe(1);
      } finally {
        process.off('warning', onWarning);
      }

      // The next owner retries from the same attempt count within the self-heal delay,
      // rather than charging the aborted attempt or waiting out the stale horizon.
      const second = countingFinalizer(`destroy-abort-${mode}`);
      await using engine2 = await createEngine(mode, storage, clock);
      registerTeardownType(engine2, `abort-${mode}`, second.destroy);
      const events = collectTeardownEvents(engine2);
      await engine2.recoverAll();
      clock.now += SELF_HEAL_INTERVAL_MS;
      await engine2.scheduler.tick(clock.now);
      expect(second.destroyed).toEqual([{ sandboxId: `sandbox-${id}` }]);
      expect(events).toEqual([{ workflowId: id, status: 'completed', attempts: 1 }]);
    });
  });
}

describe('finalizer teardown under ownership: workflow-lease only (COR-1415)', () => {
  it('a reclaim-scan pass during a long-running finalizer neither double-runs it nor fences its settle', async () => {
    const storage = new MemoryStorage();
    const clockA: Clock = { now: 11_000_000 };
    const clockB: Clock = { now: 11_000_001 };
    const parked = parkedFinalizer('destroy-reclaim-scan');
    await using engineA = await createEngine('workflow-lease', storage, clockA);
    await using engineB = await createEngine('workflow-lease', storage, clockB);
    registerTeardownType(engineA, 'reclaim-scan', parked.destroy);
    registerTeardownType(engineB, 'reclaim-scan', parked.destroy);
    const events = collectTeardownEvents(engineA);
    const id = 'reclaim-scan-1';
    await startAndTerminate(engineA, storage, 'reclaim-scan', id);

    const driveA = engineA.scheduler.tick(clockA.now);
    await parked.started;
    // The drive holds no workflow claim at all: nothing for the reclaim scan to take over.
    expect(getInternals(engineA).workflowClaimRegistry?.currentEpoch(id)).toBeNull();
    expect(await storage.get(KEYS.workflowOwnerHolder(id))).toBeNull();

    // Well past any claim TTL, a peer's maintenance runs the renewal task's reclaim pass and
    // the scheduler, while the finalizer is still inside its stale-running horizon.
    clockB.now += PAST_CLAIM_TTL_MS;
    await engineB.runMaintenance(clockB.now);
    clockB.now += 1_000;
    await engineB.runMaintenance(clockB.now);
    expect(parked.starts()).toBe(1);
    expect(await storage.get(KEYS.workflowOwnerHolder(id))).toBeNull();

    parked.release();
    await driveA;
    expect(parked.starts()).toBe(1);
    expect(events).toEqual([{ workflowId: id, status: 'completed', attempts: 1 }]);
    expect(await engineA.getFinalizerStatus(id)).toMatchObject({ status: 'succeeded' });
    expect(await storage.get(KEYS.teardownOwed(id))).toBeNull();
    expect(await timerCount(storage)).toBe(0);
  });

  it('a drive with no workflow claim of its own can claim the marker, and only the bytes arbitrate', async () => {
    const storage = new MemoryStorage();
    const clock: Clock = { now: 12_000_000 };
    await using engine = await createEngine('workflow-lease', storage, clock);
    await using peer = await createEngine('workflow-lease', storage, clock);
    const finalizer = noopFinalizer('destroy-no-claim');
    const id = 'no-claim-1';
    const token = 'no-claim-token';
    const owedBytes = encodeOwedClaim(0, token);
    await storage.batch([{ type: 'put', key: KEYS.teardownOwed(id), value: owedBytes }]);

    // A workflow claim this engine held was taken over at a newer epoch: the marker is not
    // fenced on it, so the claim CAS still commits.
    const registry = getInternals(engine).workflowClaimRegistry!;
    const acquired = await registry.acquire(id);
    expect(acquired.status).toBe('acquired');
    clock.now += PAST_CLAIM_TTL_MS;
    const takeover = await getInternals(peer).workflowClaimRegistry!.takeover(id);
    expect(takeover.status).toBe('acquired');

    const hold = await claimTeardownMarker(
      getInternals(engine),
      id,
      owedBytes,
      0,
      token,
      finalizer,
      OUTSIDE_FIRED_TIMER,
    );
    expect(hold).not.toBeNull();
    expect(await storage.get(KEYS.teardownOwed(id))).toEqual(hold!.bytes);
    expect(
      await claimTeardownMarker(
        getInternals(peer),
        id,
        owedBytes,
        0,
        token,
        finalizer,
        OUTSIDE_FIRED_TIMER,
      ),
    ).toBeNull();
  });
});
