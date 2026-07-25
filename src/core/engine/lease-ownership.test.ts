/**
 * #470 Step 1: `Engine.create({ ownership: 'lease' })` acquires a storage lease
 * before recovery and releases it on dispose — turning a rolling deploy into a
 * clean handoff. These tests pin the engine-level wiring (boot gate, disposal
 * release, capability gate, lease-lost warning) and the genuine two-engine
 * handoff against an in-process durable store with atomic conditionalBatch.
 *
 * BunSQLiteStorage(':memory:') is used for the contended cases because its
 * conditionalBatch is transactionally atomic — MemoryStorage's in-process Map
 * serializes operations and cannot model two engines racing for the same lease.
 */
import { describe, expect, it } from 'bun:test';

import { BunSQLiteStorage } from '../../storage/bun-sql.ts';
import type { Storage, StorageCapabilities } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { workflow } from '../types.ts';
import {
  Engine,
  ENGINE_LEASE_LOST_WARNING_NAME,
  ENGINE_LEASE_SYNCHRONOUS_DISPOSE_WARNING_NAME,
} from './index.ts';
import { getInternals } from './internals.ts';
import { createLeaseHolderReadProbeStorage } from './lease.test-support.ts';
import { decodeWorkflowState } from './validation.ts';

const pingWorkflow = workflow({ name: 'ping' }).execute(async function* () {
  return 'pong';
});

const textDecoder = new TextDecoder();

async function readHolder(
  storage: Storage,
): Promise<{ holderId: string; expiresAt: number; epoch: number } | null> {
  const raw = await storage.get(KEYS.leaseHolder());
  return raw === null ? null : JSON.parse(textDecoder.decode(raw));
}

/** Read the holder, then return its epoch (avoids the no-await-expression-member lint). */
async function holderEpoch(storage: Storage): Promise<number | undefined> {
  const holder = await readHolder(storage);
  return holder?.epoch;
}

async function readEpoch(storage: Storage): Promise<number | null> {
  const raw = await storage.get(KEYS.leaseEpoch());
  if (raw === null) return null;
  return Number(new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getBigUint64(0, false));
}

function failNextQueuedStartDrain<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
  drainError: Error,
): void {
  const internals = getInternals(engine);
  let firstRead = true;
  let queuedStarts = internals.queuedInlineWorkflowStarts;
  Object.defineProperty(internals, 'queuedInlineWorkflowStarts', {
    configurable: true,
    get: () => {
      if (firstRead) {
        firstRead = false;
        throw drainError;
      }
      return queuedStarts;
    },
    set: (value: typeof queuedStarts) => {
      queuedStarts = value;
    },
  });
}

type CapturedWarning = { name: string; message: string };

function createLeasedPingEngine(storage: MemoryStorage, getNow: () => number) {
  return Engine.create({
    storage,
    workflows: { ping: pingWorkflow },
    ownership: 'lease',
    getNow,
    leaseRenewInterval: '1s',
    leaseTtl: '2s',
  });
}

type LeasedPingEngine = Awaited<ReturnType<typeof createLeasedPingEngine>>;

async function withUnconfirmableLeaseRenewal(
  renewalTime: number,
  runAssertions: (fixture: {
    engine: LeasedPingEngine;
    storage: MemoryStorage;
    warnings: CapturedWarning[];
  }) => Promise<void> | void,
): Promise<void> {
  let now = 0;
  const storage = new MemoryStorage();
  const engine = await createLeasedPingEngine(storage, () => now);

  const warnings: CapturedWarning[] = [];
  const listener = (warning: Error): void => {
    warnings.push({ name: warning.name, message: warning.message });
  };

  const originalConditionalBatch = storage.conditionalBatch.bind(storage);
  storage.conditionalBatch = async () => {
    throw new Error('storage offline');
  };

  process.on('warning', listener);
  try {
    now = renewalTime;
    const manager = getInternals(engine).leaseManager;
    expect(manager).not.toBeNull();
    await manager!.renewOnce();
    await new Promise((resolve) => setImmediate(resolve));
    await runAssertions({ engine, storage, warnings });
  } finally {
    storage.conditionalBatch = originalConditionalBatch;
    process.off('warning', listener);
    await engine[Symbol.asyncDispose]();
    storage[Symbol.dispose]?.();
  }
}

describe("Engine.create({ ownership: 'lease' })", () => {
  it('acquires the lease before recovery and renews it while running', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    const engine = await Engine.create({
      storage,
      workflows: { ping: pingWorkflow },
      ownership: 'lease',
    });

    // The lease manager is live and the holder/epoch keys are written.
    expect(getInternals(engine).leaseManager).not.toBeNull();
    const holder = await readHolder(storage);
    expect(holder).not.toBeNull();
    expect(holder?.epoch).toBe(1);
    expect(await readEpoch(storage)).toBe(1);

    await engine[Symbol.asyncDispose]();
    storage[Symbol.dispose]?.();
  });

  it('acquires the lease via `new Engine()` + `recoverAll()` (not only Engine.create)', async () => {
    // The Cursor-flagged boot path: a caller that constructs directly and then
    // recovers must still hold the lease before recovery runs. recoverAll calls
    // #acquireLeaseIfConfigured (idempotently) so the lease is acquired here too.
    const storage = new BunSQLiteStorage(':memory:');
    // The direct constructor does not take a `workflows` registry (that is a
    // create-time concept); register after construction. No running workflows
    // exist here anyway — the assertion is purely that recoverAll acquires.
    const engine = new Engine({ storage, ownership: 'lease' });
    engine.register(pingWorkflow);

    // No lease before recovery — the constructor does not acquire (it cannot await).
    expect(getInternals(engine).leaseManager).toBeNull();
    expect(await readHolder(storage)).toBeNull();

    await engine.recoverAll();

    // recoverAll acquired the lease before doing any recovery work.
    expect(getInternals(engine).leaseManager).not.toBeNull();
    expect(await holderEpoch(storage)).toBe(1);
    expect(await readEpoch(storage)).toBe(1);

    // Second recoverAll is a no-op for the lease (idempotent guard) — no self-steal.
    await engine.recoverAll();
    expect(await holderEpoch(storage)).toBe(1);
    expect(await readEpoch(storage)).toBe(1);

    await engine[Symbol.asyncDispose]();
    storage[Symbol.dispose]?.();
  });

  it('re-attempts acquisition after a failed acquire (does not get stuck on the idempotency guard)', async () => {
    // Regression for the assign-after-acquire fix: #acquireLeaseIfConfigured must
    // assign internals.leaseManager only AFTER a successful acquire. If it assigned
    // before awaiting acquire(), a thrown acquire would leave the field set, and the
    // idempotency guard would make the NEXT recoverAll() skip acquisition entirely —
    // recovering without the lease. So we force the first acquire to throw, then
    // prove a later recoverAll() actually acquires rather than no-opping.
    const storage = new BunSQLiteStorage(':memory:');
    // Seed a corrupt epoch (present but not 8 bytes) so the first acquire fails
    // closed with EngineLeaseCorruptedError before taking anything durable.
    await storage.put(KEYS.leaseEpoch(), new Uint8Array([9, 9, 9]));

    const engine = new Engine({ storage, ownership: 'lease' });
    engine.register(pingWorkflow);

    await expect(engine.recoverAll()).rejects.toBeInstanceOf(Error);
    // The failed acquire left no manager — the field is null, so a retry re-acquires.
    expect(getInternals(engine).leaseManager).toBeNull();

    // Repair the corruption (operator action) and recover again. The idempotency
    // guard must NOT short-circuit — acquisition runs and takes the lease.
    await storage.delete(KEYS.leaseEpoch());
    await engine.recoverAll();
    expect(getInternals(engine).leaseManager).not.toBeNull();
    expect(await holderEpoch(storage)).toBe(1);
    expect(await readEpoch(storage)).toBe(1);

    await engine[Symbol.asyncDispose]();
    storage[Symbol.dispose]?.();
  });

  it('does not touch lease keys for the default ownership posture', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    const engine = await Engine.create({ storage, workflows: { ping: pingWorkflow } });

    expect(getInternals(engine).leaseManager).toBeNull();
    expect(await readHolder(storage)).toBeNull();
    expect(await readEpoch(storage)).toBeNull();

    await engine[Symbol.asyncDispose]();
    storage[Symbol.dispose]?.();
  });

  it('releases the lease on async dispose, leaving the epoch high-water mark', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    const engine = await Engine.create({
      storage,
      workflows: { ping: pingWorkflow },
      ownership: 'lease',
    });
    await engine[Symbol.asyncDispose]();

    // Holder gone (clean release), epoch preserved for the next boot to climb above.
    expect(await readHolder(storage)).toBeNull();
    expect(await readEpoch(storage)).toBe(1);
    storage[Symbol.dispose]?.();
  });

  it('hands off cleanly between two engines over a shared durable store', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    const first = await Engine.create({
      storage,
      workflows: { ping: pingWorkflow },
      ownership: 'lease',
    });
    expect(await holderEpoch(storage)).toBe(1);

    // Outgoing instance drains + releases; incoming instance then acquires at epoch 2.
    await first[Symbol.asyncDispose]();

    const second = await Engine.create({
      storage,
      workflows: { ping: pingWorkflow },
      ownership: 'lease',
      // A second store engine needs its own storage handle in production; here the
      // single in-memory DB is shared so the lease keys are genuinely contended.
    });
    expect(await holderEpoch(storage)).toBe(2);

    await second[Symbol.asyncDispose]();
    storage[Symbol.dispose]?.();
  });

  it('disposing while a lease acquire is parked leaks no holder and starts no renewal', async () => {
    // State-machine cell: acquiring → disposed. A second engine's recoverAll()
    // parks waiting for the lease while the first holds it. If we asyncDispose the
    // second engine while it is parked, it must (a) leave the first engine's holder
    // untouched, (b) not start a renewal on the now-disposed engine, and (c) detach
    // its own lease manager — no durable holder/heartbeat leaking until TTL.
    const base = new BunSQLiteStorage(':memory:');
    const { parked, storage } = createLeaseHolderReadProbeStorage(base);

    const first = await Engine.create({
      storage,
      workflows: { ping: pingWorkflow },
      ownership: 'lease',
    });
    const firstHolder = await readHolder(storage);
    expect(firstHolder?.epoch).toBe(1);

    // Second engine: construct directly, then recoverAll() parks on the live lease.
    const second = new Engine({ storage, ownership: 'lease', leaseRenewInterval: '1s' });
    second.register(pingWorkflow);
    const secondRecover = second.recoverAll();

    await parked; // the second engine is provably waiting on the lease

    // Dispose the parked second engine. Its parked acquire observes `stopped` and
    // exits without taking the holder. The contract: recoverAll() must REJECT, not
    // resolve — otherwise recovery would proceed on a disposed engine that never
    // held the lease (the bug this asserts against).
    await second[Symbol.asyncDispose]();
    await expect(secondRecover).rejects.toBeInstanceOf(Error);

    // The first engine's holder is intact at epoch 1 — the second never stole it.
    const holderAfter = await readHolder(storage);
    expect(holderAfter?.holderId).toBe(firstHolder?.holderId);
    expect(holderAfter?.epoch).toBe(1);
    // The second engine detached its lease manager (no renewal running on it).
    expect(getInternals(second).leaseManager).toBeNull();

    await first[Symbol.asyncDispose]();
    base[Symbol.dispose]();
  });

  it('serializes concurrent recoverAll() calls on one engine behind a single acquire', async () => {
    // The idempotency contract: a second recoverAll() racing the first must await
    // the in-flight acquire, not observe a half-set leaseManager and proceed into
    // recovery before the lease is genuinely held. Both calls resolve; the lease is
    // acquired exactly once (epoch 1 — no self-steal to epoch 2).
    const storage = new BunSQLiteStorage(':memory:');
    const engine = new Engine({ storage, ownership: 'lease' });
    engine.register(pingWorkflow);

    // Fire two recoverAll() concurrently before either has resolved.
    const [a, b] = await Promise.all([engine.recoverAll(), engine.recoverAll()]);
    expect(Array.isArray(a)).toBe(true);
    expect(Array.isArray(b)).toBe(true);

    // Exactly one acquisition happened: epoch 1, a single live manager.
    expect(getInternals(engine).leaseManager).not.toBeNull();
    expect(await holderEpoch(storage)).toBe(1);
    expect(await readEpoch(storage)).toBe(1);

    await engine[Symbol.asyncDispose]();
    storage[Symbol.dispose]?.();
  });

  it('synchronous dispose during a parked acquire surfaces no unhandled rejection', async () => {
    // The acquire-cancelled-by-dispose path now REJECTS (EngineDisposedError). Sync
    // dispose cannot await the in-flight acquire, so the rejection must still be
    // consumed by the internal `await acquisition` chain (propagated to the
    // recoverAll() caller) — never left dangling as an unhandledRejection.
    const base = new BunSQLiteStorage(':memory:');
    const { parked, storage } = createLeaseHolderReadProbeStorage(base);

    const first = await Engine.create({ storage, ownership: 'lease' });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const second = new Engine({ storage, ownership: 'lease' });
      second.register(pingWorkflow);
      // Fire-and-forget recoverAll(), but attach a catch so the *caller* promise is
      // handled; the point of the test is that the engine's internal in-flight
      // acquire promise has its own synchronous handler and never leaks.
      const recover = second.recoverAll();
      recover.catch(() => {});
      await parked;

      // Synchronous dispose while the acquire is parked.
      second[Symbol.dispose]();

      // Deterministic barrier: await the observable completion (recover settling)
      // instead of a fixed sleep. Sync dispose stops the manager; the parked acquire
      // exits on its next `stopped` check and the in-flight promise rejects, settling
      // recover. Then flush one macrotask so any unhandledRejection notification has
      // fired before we assert. (No wall-clock sleep — the acquire poll interval is
      // 1s by default, which a 30ms sleep could never reliably outwait.)
      await recover.catch(() => {});
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    await first[Symbol.asyncDispose]();
    base[Symbol.dispose]();
  });

  it('refuses recoverAll() on an already-disposed engine (recovery entry guard)', async () => {
    // The single closing invariant for the disposal interleavings: recovery never
    // runs on a torn-down engine. A recoverAll() after dispose throws at the entry,
    // before any storage recovery work — covering the direct path and (with the
    // in-flight-acquire await) the concurrent-waiter path uniformly.
    const storage = new BunSQLiteStorage(':memory:');
    const engine = await Engine.create({
      storage,
      workflows: { ping: pingWorkflow },
      ownership: 'lease',
    });
    await engine[Symbol.asyncDispose]();

    await expect(engine.recoverAll()).rejects.toBeInstanceOf(Error);
    storage[Symbol.dispose]?.();
  });

  it('blocks the second engine until the first releases (zero-overlap handoff)', async () => {
    const base = new BunSQLiteStorage(':memory:');
    // Instrument get() so the test learns, deterministically, when the challenger
    // has actually reached the lease-wait poll (it reads lease:holder there). After
    // two such reads the challenger is provably parked — no fixed sleep needed.
    const { parked, storage } = createLeaseHolderReadProbeStorage(base);

    const first = await Engine.create({
      storage,
      workflows: { ping: pingWorkflow },
      ownership: 'lease',
    });

    let secondReady = false;
    const secondBoot = Engine.create({
      storage,
      workflows: { ping: pingWorkflow },
      ownership: 'lease',
      leaseWaitTimeout: '10s',
      leaseRenewInterval: '1s',
    }).then((engine) => {
      secondReady = true;
      return engine;
    });

    // Wait until the challenger has genuinely polled the lease (deterministic
    // barrier, not a timer), then assert it is still parked behind the live lease.
    await parked;
    expect(secondReady).toBe(false);

    await first[Symbol.asyncDispose]();
    const second = await secondBoot;
    expect(secondReady).toBe(true);
    expect(await holderEpoch(storage)).toBe(2);

    await second[Symbol.asyncDispose]();
    base[Symbol.dispose]();
  });

  it('fails fast when the storage backend lacks conditionalBatch', async () => {
    // A storage that honestly reports no conditionalBatch must be rejected at boot
    // for lease ownership, with a clear diagnostic — not silently degrade. A thin
    // delegating wrapper (not a Proxy — MemoryStorage uses private fields that a
    // Proxy breaks) overrides only capabilities().
    const base = new MemoryStorage();
    const noCasStorage: Storage = {
      capabilities: (): StorageCapabilities => ({
        ...base.capabilities(),
        conditionalBatch: false,
      }),
      get: (key) => base.get(key),
      put: (key, value) => base.put(key, value),
      delete: (key) => base.delete(key),
      scan: (prefix, options) => base.scan(prefix, options),
      batch: (operations) => base.batch(operations),
      [Symbol.dispose]: () => base[Symbol.dispose](),
    };

    let caught: unknown;
    try {
      await Engine.create({
        storage: noCasStorage,
        workflows: { ping: pingWorkflow },
        ownership: 'lease',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('conditionalBatch');
    expect((caught as Error).message).toContain("ownership: 'lease'");
  });

  it('emits a WeftEngineLeaseLostWarning when the lease is stolen out from under it', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    const engine = await Engine.create({
      storage,
      workflows: { ping: pingWorkflow },
      ownership: 'lease',
    });

    const warnings: { name: string; message: string }[] = [];
    const listener = (warning: Error): void => {
      warnings.push({ name: warning.name, message: warning.message });
    };
    process.on('warning', listener);
    try {
      // Forcibly overwrite the holder + epoch (a successor stealing the lease).
      const stolenHolder = new TextEncoder().encode(
        JSON.stringify({ holderId: 'successor', expiresAt: 1e15, epoch: 2 }),
      );
      const stolenEpoch = new Uint8Array(8);
      new DataView(stolenEpoch.buffer).setBigUint64(0, 2n, false);
      await storage.batch([
        { type: 'put', key: KEYS.leaseEpoch(), value: stolenEpoch },
        { type: 'put', key: KEYS.leaseHolder(), value: stolenHolder },
      ]);

      // Drive the renewal deterministically through internals rather than waiting on
      // the real renewal interval — the CAS fails against the stolen holder bytes and
      // the loss is reported synchronously. `process.emitWarning` is asynchronous, so
      // flush one macrotask before asserting.
      const manager = getInternals(engine).leaseManager;
      expect(manager).not.toBeNull();
      await manager!.renewOnce();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('warning', listener);
    }

    expect(warnings.some((w) => w.name === ENGINE_LEASE_LOST_WARNING_NAME)).toBe(true);

    await engine[Symbol.asyncDispose]();
    storage[Symbol.dispose]?.();
  });

  it('tolerates an unconfirmed lease renewal before expiry without warning or halt', async () => {
    await withUnconfirmableLeaseRenewal(1_001, ({ engine, warnings }) => {
      expect(warnings).toEqual([]);
      expect(getInternals(engine).deposed).toBe(false);
      expect(getInternals(engine).leaseManager).not.toBeNull();
    });
  });

  it('warns without deposing the engine when renewal becomes unconfirmable after expiry', async () => {
    await withUnconfirmableLeaseRenewal(2_001, ({ engine, warnings }) => {
      expect(warnings.some((warning) => warning.name === ENGINE_LEASE_LOST_WARNING_NAME)).toBe(
        true,
      );
      expect(getInternals(engine).deposed).toBe(false);
      expect(getInternals(engine).leaseManager).not.toBeNull();
    });
  });

  it('synchronous dispose clears the lease manager and stops renewals', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    const engine = await Engine.create({
      storage,
      workflows: { ping: pingWorkflow },
      ownership: 'lease',
    });

    // The synchronous contract: the manager reference is cleared (renewals stopped).
    // The durable holder-key delete is fire-and-forget on the sync path, so the
    // "holder is gone" guarantee is asserted on the async-dispose path (below),
    // where the await makes it deterministic — not via a fixed sleep here.
    const listener = (): void => {};
    process.on('warning', listener);
    try {
      engine[Symbol.dispose]();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('warning', listener);
    }
    expect(getInternals(engine).leaseManager).toBeNull();
    storage[Symbol.dispose]?.();
  });

  it('warns when synchronous dispose runs while holding a lease', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    const engine = await Engine.create({
      storage,
      workflows: { ping: pingWorkflow },
      ownership: 'lease',
    });

    const warnings: { name: string; message: string }[] = [];
    const listener = (warning: Error): void => {
      warnings.push({ name: warning.name, message: warning.message });
    };
    process.on('warning', listener);
    try {
      engine[Symbol.dispose]();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('warning', listener);
    }

    expect(
      warnings.some((warning) => warning.name === ENGINE_LEASE_SYNCHRONOUS_DISPOSE_WARNING_NAME),
    ).toBe(true);
    storage[Symbol.dispose]?.();
  });

  it('does not warn for synchronous dispose while lease acquisition is only parked', async () => {
    const base = new BunSQLiteStorage(':memory:');
    const { parked, storage } = createLeaseHolderReadProbeStorage(base);

    const first = await Engine.create({ storage, ownership: 'lease' });
    const second = new Engine({ storage, ownership: 'lease' });
    second.register(pingWorkflow);
    const recover = second.recoverAll();
    recover.catch(() => {});
    await parked;

    const warnings: { name: string; message: string }[] = [];
    const listener = (warning: Error): void => {
      warnings.push({ name: warning.name, message: warning.message });
    };
    process.on('warning', listener);
    try {
      second[Symbol.dispose]();
      await recover.catch(() => {});
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('warning', listener);
    }

    expect(
      warnings.some((warning) => warning.name === ENGINE_LEASE_SYNCHRONOUS_DISPOSE_WARNING_NAME),
    ).toBe(false);

    await first[Symbol.asyncDispose]();
    base[Symbol.dispose]();
  });

  it('async dispose durably releases the holder key', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    const engine = await Engine.create({
      storage,
      workflows: { ping: pingWorkflow },
      ownership: 'lease',
    });

    // asyncDispose awaits the lease release, so the holder key is deterministically
    // gone once it resolves — no polling needed.
    await engine[Symbol.asyncDispose]();
    expect(await readHolder(storage)).toBeNull();
    expect(await readEpoch(storage)).toBe(1);
    storage[Symbol.dispose]?.();
  });

  it('reports a failed lease release from shutdown without rejecting', async () => {
    const storage = new MemoryStorage();
    const engine = await Engine.create({
      storage,
      workflows: { ping: pingWorkflow },
      ownership: 'lease',
    });

    const originalConditionalBatch = storage.conditionalBatch.bind(storage);
    storage.conditionalBatch = async () => {
      throw new Error('storage offline');
    };
    try {
      await expect(engine.shutdown()).resolves.toBe(false);
    } finally {
      storage.conditionalBatch = originalConditionalBatch;
      storage[Symbol.dispose]?.();
    }
  });

  it('reports lease release outcome when shutdown drain fails', async () => {
    const storage = new MemoryStorage();
    const engine = await Engine.create({
      storage,
      workflows: { ping: pingWorkflow },
      ownership: 'lease',
    });
    const internals = getInternals(engine);
    const drainError = new Error('drain failed');
    failNextQueuedStartDrain(engine, drainError);

    await expect(engine.shutdown()).rejects.toMatchObject({
      name: 'EngineDisposalError',
      cause: drainError,
      leaseReleased: true,
    });
    expect(internals.disposed).toBe(true);
    storage[Symbol.dispose]?.();
  });

  it('reports a failed lease release when shutdown drain fails', async () => {
    const storage = new MemoryStorage();
    const engine = await Engine.create({
      storage,
      workflows: { ping: pingWorkflow },
      ownership: 'lease',
    });
    const originalConditionalBatch = storage.conditionalBatch.bind(storage);
    storage.conditionalBatch = async () => {
      throw new Error('storage offline');
    };
    const drainError = new Error('drain failed');
    failNextQueuedStartDrain(engine, drainError);

    try {
      await expect(engine.shutdown()).rejects.toMatchObject({
        name: 'EngineDisposalError',
        cause: drainError,
        leaseReleased: false,
      });
    } finally {
      storage.conditionalBatch = originalConditionalBatch;
      storage[Symbol.dispose]?.();
    }
  });

  it('shutdown durably releases the holder key', async () => {
    const storage = new BunSQLiteStorage(':memory:');
    const engine = await Engine.create({
      storage,
      workflows: { ping: pingWorkflow },
      ownership: 'lease',
    });

    await expect(engine.shutdown()).resolves.toBe(true);
    expect(await readHolder(storage)).toBeNull();
    expect(await readEpoch(storage)).toBe(1);
    storage[Symbol.dispose]?.();
  });

  it('shares one shutdown release result across concurrent callers', async () => {
    const storage = new MemoryStorage();
    const engine = await Engine.create({
      storage,
      workflows: { ping: pingWorkflow },
      ownership: 'lease',
    });
    const originalConditionalBatch = storage.conditionalBatch.bind(storage);
    let releaseCalls = 0;
    storage.conditionalBatch = async (conditions, operations) => {
      if (operations.some((operation) => operation.type === 'delete')) releaseCalls += 1;
      return originalConditionalBatch(conditions, operations);
    };

    const results = await Promise.all([engine.shutdown(), engine.shutdown()]);

    expect(results).toEqual([true, true]);
    expect(releaseCalls).toBe(1);
    storage[Symbol.dispose]?.();
  });

  it('shares an in-flight synchronous release result with shutdown', async () => {
    const storage = new MemoryStorage();
    const engine = await Engine.create({
      storage,
      workflows: { ping: pingWorkflow },
      ownership: 'lease',
    });
    const releaseStarted = Promise.withResolvers<void>();
    const releaseStorage = Promise.withResolvers<void>();
    const originalConditionalBatch = storage.conditionalBatch.bind(storage);
    storage.conditionalBatch = async (conditions, operations) => {
      if (operations.some((operation) => operation.type === 'delete')) {
        releaseStarted.resolve();
        await releaseStorage.promise;
      }
      if (operations.some((operation) => operation.type === 'delete')) return false;
      return originalConditionalBatch(conditions, operations);
    };

    engine[Symbol.dispose]();
    await releaseStarted.promise;
    const shutdown = engine.shutdown();
    releaseStorage.resolve();

    await expect(shutdown).resolves.toBe(false);
    expect(await readHolder(storage)).not.toBeNull();
    storage[Symbol.dispose]?.();
  });

  it('awaits acquisition cleanup after synchronous disposal before reporting shutdown', async () => {
    const storage = new MemoryStorage();
    const acquisitionCommitted = Promise.withResolvers<void>();
    const finishAcquisition = Promise.withResolvers<void>();
    const originalConditionalBatch = storage.conditionalBatch.bind(storage);
    storage.conditionalBatch = async (conditions, operations) => {
      const writesHolder = operations.some(
        (operation) => operation.type === 'put' && operation.key === KEYS.leaseHolder(),
      );
      if (writesHolder) {
        const committed = await originalConditionalBatch(conditions, operations);
        acquisitionCommitted.resolve();
        await finishAcquisition.promise;
        return committed;
      }
      if (operations.some((operation) => operation.type === 'delete')) return false;
      return originalConditionalBatch(conditions, operations);
    };

    const engine = new Engine({ storage, ownership: 'lease' });
    engine.register(pingWorkflow);
    const recovery = engine.recoverAll();
    await acquisitionCommitted.promise;

    engine[Symbol.dispose]();
    const shutdown = engine.shutdown();
    let shutdownSettled = false;
    void shutdown.finally(() => {
      shutdownSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(shutdownSettled).toBe(false);

    finishAcquisition.resolve();
    await expect(recovery).rejects.toThrow('disposed');
    await expect(shutdown).resolves.toBe(false);
    expect(await readHolder(storage)).not.toBeNull();
    storage[Symbol.dispose]?.();
  });

  it('defers synchronous disposal release while shutdown drains queued work', async () => {
    const storage = new MemoryStorage();
    const drainStarted = Promise.withResolvers<void>();
    let signalObserved = false;
    const drainingWorkflow = workflow({ name: 'draining' }).execute(async function* (ctx) {
      drainStarted.resolve();
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) {
          resolve();
          return;
        }
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      signalObserved = true;
      return 'done';
    });
    const engine = await Engine.create({
      storage,
      workflows: { draining: drainingWorkflow },
      ownership: 'lease',
    });
    const originalConditionalBatch = storage.conditionalBatch.bind(storage);
    let releaseCalls = 0;
    let signalObservedBeforeRelease = false;
    storage.conditionalBatch = async (conditions, operations) => {
      if (
        operations.some(
          (operation) => operation.type === 'delete' && operation.key === KEYS.leaseHolder(),
        )
      ) {
        releaseCalls += 1;
        signalObservedBeforeRelease = signalObserved;
      }
      return originalConditionalBatch(conditions, operations);
    };

    await engine.start('draining', null, { id: 'queued-for-shutdown' });
    const shutdown = engine.shutdown();
    await drainStarted.promise;
    engine[Symbol.dispose]();

    await expect(shutdown).resolves.toBe(true);
    expect(signalObserved).toBe(true);
    expect(signalObservedBeforeRelease).toBe(true);
    expect(releaseCalls).toBe(1);
    expect(await readHolder(storage)).toBeNull();
    storage[Symbol.dispose]?.();
  });

  it('bounds shutdown when a queued first turn ignores its abort signal', async () => {
    const storage = new MemoryStorage();
    const bodyEntered = Promise.withResolvers<void>();
    const releaseBody = Promise.withResolvers<void>();
    const nonCooperativeWorkflow = workflow({ name: 'non-cooperative' }).execute(
      async function* () {
        bodyEntered.resolve();
        await releaseBody.promise;
        return 'stopped';
      },
    );
    const engine = await Engine.create({
      storage,
      workflows: { 'non-cooperative': nonCooperativeWorkflow },
      ownership: 'lease',
    });

    await engine.start('non-cooperative', null, { id: 'queued-non-cooperative-shutdown' });
    const shutdown = engine.shutdown();

    await bodyEntered.promise;
    await expect(shutdown).resolves.toBe(true);
    expect(await readHolder(storage)).toBeNull();

    // Settle the deliberately non-cooperative body after disposal so the test
    // leaves no retained pending generator promise.
    releaseBody.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    storage[Symbol.dispose]?.();
  });

  it('aborts a cooperative queued first turn before releasing the lease', async () => {
    const storage = new MemoryStorage();
    let signalObserved = false;
    const cooperativeWorkflow = workflow({ name: 'cooperative' }).execute(async function* (ctx) {
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) {
          resolve();
          return;
        }
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      signalObserved = true;
      return 'stopped';
    });
    const engine = await Engine.create({
      storage,
      workflows: { cooperative: cooperativeWorkflow },
      ownership: 'lease',
    });

    await engine.start('cooperative', null, { id: 'queued-cooperative-shutdown' });
    await expect(engine.shutdown()).resolves.toBe(true);
    expect(signalObserved).toBe(true);
    expect(await readHolder(storage)).toBeNull();
    storage[Symbol.dispose]?.();
  });

  it('awaits a cooperative queued durable turn before releasing the lease', async () => {
    const storage = new MemoryStorage();
    const terminalWriteEntered = Promise.withResolvers<void>();
    const releaseTerminalWrite = Promise.withResolvers<void>();
    const cooperativeWorkflow = workflow({ name: 'slow-terminal-write' }).execute(
      async function* (ctx) {
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) {
            resolve();
            return;
          }
          ctx.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return 'stopped';
      },
    );
    const engine = await Engine.create({
      storage,
      workflows: { 'slow-terminal-write': cooperativeWorkflow },
      ownership: 'lease',
    });
    const originalConditionalBatch = storage.conditionalBatch.bind(storage);
    storage.conditionalBatch = async (conditions, operations) => {
      const terminalWrite = operations.find(
        (operation) =>
          operation.type === 'put' && operation.key === KEYS.workflow('slow-terminal-write-run'),
      );
      if (
        terminalWrite?.type === 'put' &&
        decodeWorkflowState(terminalWrite.value).status === 'completed'
      ) {
        terminalWriteEntered.resolve();
        await releaseTerminalWrite.promise;
      }
      return originalConditionalBatch(conditions, operations);
    };

    await engine.start('slow-terminal-write', null, { id: 'slow-terminal-write-run' });
    const shutdown = engine.shutdown();
    await terminalWriteEntered.promise;

    expect(await readHolder(storage)).not.toBeNull();
    releaseTerminalWrite.resolve();
    await expect(shutdown).resolves.toBe(true);
    expect(await readHolder(storage)).toBeNull();
    storage[Symbol.dispose]?.();
  });

  it('waits for each cooperative queued turn when a sibling ignores abort', async () => {
    const storage = new MemoryStorage();
    const releaseNonCooperativeBody = Promise.withResolvers<void>();
    const nonCooperativeWorkflow = workflow({ name: 'non-cooperative-sibling' }).execute(
      async function* () {
        await releaseNonCooperativeBody.promise;
        return 'stopped';
      },
    );
    const cooperativeWorkflow = workflow({ name: 'cooperative-sibling' }).execute(
      async function* (ctx) {
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) {
            resolve();
            return;
          }
          ctx.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return 'stopped';
      },
    );
    const engine = await Engine.create({
      storage,
      workflows: {
        'non-cooperative-sibling': nonCooperativeWorkflow,
        'cooperative-sibling': cooperativeWorkflow,
      },
      ownership: 'lease',
    });
    const originalConditionalBatch = storage.conditionalBatch.bind(storage);
    let cooperativeStatusBeforeRelease: string | undefined;
    storage.conditionalBatch = async (conditions, operations) => {
      if (
        operations.some(
          (operation) => operation.type === 'delete' && operation.key === KEYS.leaseHolder(),
        )
      ) {
        const stateBytes = await storage.get(KEYS.workflow('queued-cooperative-sibling'));
        cooperativeStatusBeforeRelease =
          stateBytes === null ? undefined : decodeWorkflowState(stateBytes).status;
      }
      return originalConditionalBatch(conditions, operations);
    };

    await engine.start('non-cooperative-sibling', null, {
      id: 'queued-non-cooperative-sibling',
    });
    await engine.start('cooperative-sibling', null, { id: 'queued-cooperative-sibling' });

    await expect(engine.shutdown()).resolves.toBe(true);
    expect(cooperativeStatusBeforeRelease).toBe('completed');
    expect(await readHolder(storage)).toBeNull();

    releaseNonCooperativeBody.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    storage[Symbol.dispose]?.();
  });

  it('suppresses nested starts yielded after a queued shutdown abort', async () => {
    const storage = new MemoryStorage();
    let parentSignalObserved = false;
    let childSignalObserved = false;
    const childWorkflow = workflow({ name: 'shutdown-child' }).execute(async function* (ctx) {
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) {
          resolve();
          return;
        }
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      childSignalObserved = true;
      return 'stopped';
    });
    const parentWorkflow = workflow({ name: 'shutdown-parent' }).execute(async function* (ctx) {
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) {
          resolve();
          return;
        }
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      parentSignalObserved = true;
      yield* ctx.startChild('shutdown-child', null, {
        id: 'nested-shutdown-child',
        parentClosePolicy: 'abandon',
      });
      return 'stopped';
    });
    const engine = await Engine.create({
      storage,
      workflows: {
        'shutdown-child': childWorkflow,
        'shutdown-parent': parentWorkflow,
      },
      ownership: 'lease',
    });

    await engine.start('shutdown-parent', null, { id: 'queued-shutdown-parent' });
    await expect(engine.shutdown()).resolves.toBe(true);

    expect(parentSignalObserved).toBe(true);
    expect(childSignalObserved).toBe(false);
    expect(await storage.get(KEYS.workflow('nested-shutdown-child'))).toBeNull();
    expect(await readHolder(storage)).toBeNull();
    storage[Symbol.dispose]?.();
  });

  it('retains a deposition release result for later shutdown', async () => {
    const storage = new MemoryStorage();
    const engine = await Engine.create({
      storage,
      workflows: { ping: pingWorkflow },
      ownership: 'lease',
    });
    const originalConditionalBatch = storage.conditionalBatch.bind(storage);
    let releaseCalls = 0;
    storage.conditionalBatch = async (conditions, operations) => {
      if (operations.some((operation) => operation.type === 'delete')) {
        releaseCalls += 1;
        return false;
      }
      return originalConditionalBatch(conditions, operations);
    };

    getInternals(engine).tearDownAfterDeposition?.();

    await expect(engine.shutdown()).resolves.toBe(false);
    expect(releaseCalls).toBe(1);
    expect(await readHolder(storage)).not.toBeNull();
    storage[Symbol.dispose]?.();
  });

  it('preserves an asyncDispose override when shutdown is called concurrently', async () => {
    let overrideCalls = 0;
    class OverrideEngine extends Engine {
      override async [Symbol.asyncDispose](): Promise<void> {
        overrideCalls += 1;
        await super[Symbol.asyncDispose]();
      }
    }

    const engine = new OverrideEngine();
    const results = await Promise.all([engine.shutdown(), engine.shutdown()]);

    expect(results).toEqual([true, true]);
    expect(overrideCalls).toBe(1);
  });

  it('retains a synchronous release result started by an asyncDispose override', async () => {
    class SynchronousDelegatingOverrideEngine extends Engine {
      override async [Symbol.asyncDispose](): Promise<void> {
        super[Symbol.dispose]();
      }
    }

    const storage = new MemoryStorage();
    const engine = new SynchronousDelegatingOverrideEngine({ storage, ownership: 'lease' });
    engine.register(pingWorkflow);
    await engine.recoverAll();
    const releaseStarted = Promise.withResolvers<void>();
    const finishRelease = Promise.withResolvers<void>();
    const originalConditionalBatch = storage.conditionalBatch.bind(storage);
    storage.conditionalBatch = async (conditions, operations) => {
      if (operations.some((operation) => operation.type === 'delete')) {
        releaseStarted.resolve();
        await finishRelease.promise;
        return false;
      }
      return originalConditionalBatch(conditions, operations);
    };

    const shutdown = engine.shutdown();
    await releaseStarted.promise;
    let shutdownSettled = false;
    void shutdown.finally(() => {
      shutdownSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(shutdownSettled).toBe(false);

    finishRelease.resolve();
    await expect(shutdown).resolves.toBe(false);
    expect(await readHolder(storage)).not.toBeNull();
    storage[Symbol.dispose]?.();
  });

  it('respects an asyncDispose override that handles a base disposal failure', async () => {
    let overrideCalls = 0;
    class HandlingOverrideEngine extends Engine {
      override async [Symbol.asyncDispose](): Promise<void> {
        overrideCalls += 1;
        try {
          await super[Symbol.asyncDispose]();
        } catch {
          // This override deliberately owns and handles base disposal failures.
        }
      }
    }

    const engine = new HandlingOverrideEngine();
    failNextQueuedStartDrain(engine, new Error('handled drain failure'));

    await expect(engine.shutdown()).resolves.toBe(true);
    expect(overrideCalls).toBe(1);
  });
});
