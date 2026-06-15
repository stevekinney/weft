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
import { Engine, ENGINE_LEASE_LOST_WARNING_NAME } from './index.ts';
import { getInternals } from './internals.ts';

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

  it('blocks the second engine until the first releases (zero-overlap handoff)', async () => {
    const base = new BunSQLiteStorage(':memory:');
    // Instrument get() so the test learns, deterministically, when the challenger
    // has actually reached the lease-wait poll (it reads lease:holder there). After
    // two such reads the challenger is provably parked — no fixed sleep needed.
    let holderReads = 0;
    let signalParked!: () => void;
    const parked = new Promise<void>((resolve) => {
      signalParked = resolve;
    });
    const storage: Storage = {
      capabilities: () => base.capabilities(),
      get: (key) => {
        if (key === KEYS.leaseHolder()) {
          holderReads += 1;
          if (holderReads >= 2) signalParked();
        }
        return base.get(key);
      },
      put: (key, value) => base.put(key, value),
      delete: (key) => base.delete(key),
      scan: (prefix, options) => base.scan(prefix, options),
      batch: (operations) => base.batch(operations),
      conditionalBatch: (conditions, operations) => base.conditionalBatch(conditions, operations),
      [Symbol.dispose]: () => base[Symbol.dispose](),
    };

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
    engine[Symbol.dispose]();
    expect(getInternals(engine).leaseManager).toBeNull();
    storage[Symbol.dispose]?.();
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
});
