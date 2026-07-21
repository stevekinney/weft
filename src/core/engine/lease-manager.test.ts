import { describe, expect, it } from 'bun:test';

import { KEYS, type Storage } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { EngineLeaseAcquisitionTimeoutError, EngineLeaseCorruptedError } from './lease-errors.ts';
import {
  createLeaseManager,
  type LeaseLostReason,
  type LeaseManagerOptions,
} from './lease-manager.ts';
import { createGatedLeaseHolderWriteStorage } from './lease.test-support.ts';

const TTL_MS = 30_000;
const RENEW_MS = 5_000;
const WAIT_MS = 60_000;

/** A controllable clock whose value the test advances explicitly. */
function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

function managerOptions(
  overrides: Partial<LeaseManagerOptions> & Pick<LeaseManagerOptions, 'storage' | 'getNow'>,
): LeaseManagerOptions {
  return {
    holderId: 'engine-a',
    ttlMs: TTL_MS,
    renewIntervalMs: RENEW_MS,
    waitTimeoutMs: WAIT_MS,
    // Small poll cadence so the wait-loop tests resolve quickly while still
    // exercising the real polling path.
    acquirePollIntervalMs: 5,
    ...overrides,
  };
}

const textDecoder = new TextDecoder();

function readEpoch(storage: Storage): Promise<number | null> {
  return storage.get(KEYS.leaseEpoch()).then((raw) => {
    if (raw === null) return null;
    return Number(new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getBigUint64(0, false));
  });
}

async function readHolder(
  storage: Storage,
): Promise<{ holderId: string; expiresAt: number; epoch: number } | null> {
  const raw = await storage.get(KEYS.leaseHolder());
  if (raw === null) return null;
  return JSON.parse(textDecoder.decode(raw));
}

/** Field accessors that read the holder first, then access the field (avoids the
 * no-await-expression-member lint and keeps assertions terse). */
async function holderId(storage: Storage): Promise<string | undefined> {
  const holder = await readHolder(storage);
  return holder?.holderId;
}
async function holderExpiry(storage: Storage): Promise<number | undefined> {
  const holder = await readHolder(storage);
  return holder?.expiresAt;
}

describe('createLeaseManager', () => {
  it('acquires a cold store at epoch 1 and writes both keys', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const manager = createLeaseManager(managerOptions({ storage, getNow: clock.now }));

    await manager.acquire();

    expect(await readEpoch(storage)).toBe(1);
    const holder = await readHolder(storage);
    expect(holder).not.toBeNull();
    expect(holder?.holderId).toBe('engine-a');
    expect(holder?.epoch).toBe(1);
    expect(holder?.expiresAt).toBe(clock.now() + TTL_MS);
  });

  it('exposes the held epoch as 8 big-endian bytes after acquire, null before', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const manager = createLeaseManager(managerOptions({ storage, getNow: clock.now }));

    expect(manager.currentEpochBytes()).toBeNull();

    await manager.acquire();

    const bytes = manager.currentEpochBytes();
    expect(bytes).not.toBeNull();
    expect(bytes?.byteLength).toBe(8);
    expect(new DataView(bytes!.buffer).getBigUint64(0, false)).toBe(1n);
  });

  it('reports no lease before acquisition and a timestamped healthy snapshot after acquisition', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const manager = createLeaseManager(managerOptions({ storage, getNow: clock.now }));

    expect(manager.health()).toEqual({ status: 'no-lease', holdsLease: false });

    await manager.acquire();

    expect(manager.health()).toEqual({
      status: 'healthy',
      holdsLease: true,
      holderId: 'engine-a',
      heldSince: 1_000_000,
      expiresAt: 1_030_000,
      lastRenewedAt: 1_000_000,
      fencingEpoch: 1,
    });
  });

  it('renews with the same epoch and an advanced expiry; epoch bytes stay stable', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const manager = createLeaseManager(managerOptions({ storage, getNow: clock.now }));

    await manager.acquire();
    const epochBytesBefore = manager.currentEpochBytes();
    const expiryBefore = await holderExpiry(storage);

    clock.advance(RENEW_MS);
    await manager.renewOnce();

    expect(await readEpoch(storage)).toBe(1);
    const holder = await readHolder(storage);
    expect(holder?.epoch).toBe(1);
    expect(holder?.expiresAt).toBe(clock.now() + TTL_MS);
    expect(holder?.expiresAt).toBeGreaterThan(expiryBefore!);
    // currentEpochBytes is stable across renewals — the contract Step-2 fencing relies on.
    expect(manager.currentEpochBytes()).toEqual(epochBytesBefore);
    expect(manager.health()).toMatchObject({
      status: 'healthy',
      heldSince: 1_000_000,
      expiresAt: 1_035_000,
      lastRenewedAt: 1_005_000,
      fencingEpoch: 1,
    });
  });

  it('reports an expired last-known holder as contested without inventing a loss reason', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const manager = createLeaseManager(managerOptions({ storage, getNow: clock.now }));
    await manager.acquire();

    clock.advance(TTL_MS);
    expect(manager.health()).toMatchObject({
      status: 'contested',
      holdsLease: false,
      expiresAt: 1_030_000,
    });
    expect(manager.health()).not.toHaveProperty('lossReason');

    await manager.renewOnce();

    expect(manager.health()).toMatchObject({
      status: 'healthy',
      holdsLease: true,
      expiresAt: 1_060_000,
      lastRenewedAt: 1_030_000,
    });
  });

  it('release deletes only the holder key; the epoch survives as a high-water mark', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const manager = createLeaseManager(managerOptions({ storage, getNow: clock.now }));

    await manager.acquire();
    await manager.release();

    expect(await readHolder(storage)).toBeNull();
    // The epoch is NOT deleted — a future boot must re-acquire above it.
    expect(await readEpoch(storage)).toBe(1);
    expect(manager.health()).toEqual({ status: 'no-lease', holdsLease: false });
  });

  it('re-acquires after a clean release at epoch+1, conditioning on the surviving epoch', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const first = createLeaseManager(managerOptions({ storage, getNow: clock.now }));
    await first.acquire();
    await first.release();

    const second = createLeaseManager(
      managerOptions({ storage, getNow: clock.now, holderId: 'engine-b' }),
    );
    await second.acquire();

    expect(await readEpoch(storage)).toBe(2);
    const holder = await readHolder(storage);
    expect(holder?.holderId).toBe('engine-b');
    expect(holder?.epoch).toBe(2);
  });

  it('waits while the lease is held, then acquires once it is released', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const incumbent = createLeaseManager(managerOptions({ storage, getNow: clock.now }));
    await incumbent.acquire();

    // The injected delay releases the incumbent on the first poll, then advances
    // the clock — deterministic, no real waiting, no timing luck.
    let polls = 0;
    const delay = async (): Promise<void> => {
      polls += 1;
      if (polls === 1) await incumbent.release();
    };
    const challenger = createLeaseManager(
      managerOptions({ storage, getNow: clock.now, holderId: 'engine-b', delay }),
    );
    await challenger.acquire();

    const holder = await readHolder(storage);
    expect(holder?.holderId).toBe('engine-b');
    expect(holder?.epoch).toBe(2);
    expect(polls).toBe(1);
  });

  it('throws EngineLeaseAcquisitionTimeoutError when the lease stays held past the wait window', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    // The incumbent keeps a live lease. A zero wait window means the deadline equals
    // boot time, so the FIRST attempt fails (lease live) and the bottom-of-loop
    // deadline check fires before any sleep — the immediate-timeout path. (The
    // first iteration always tries once even with a zero window; it then throws
    // rather than acquiring.)
    const incumbent = createLeaseManager(managerOptions({ storage, getNow: clock.now }));
    await incumbent.acquire();

    const challenger = createLeaseManager(
      managerOptions({ storage, getNow: clock.now, holderId: 'engine-b', waitTimeoutMs: 0 }),
    );

    let caught: unknown;
    try {
      await challenger.acquire();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EngineLeaseAcquisitionTimeoutError);
    expect((caught as EngineLeaseAcquisitionTimeoutError).heldBy).toBe('engine-a');
    expect((caught as EngineLeaseAcquisitionTimeoutError).waitedMs).toBe(0);
  });

  it('times out at the top of the loop when a sleep overshoots the wait window', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const incumbent = createLeaseManager(managerOptions({ storage, getNow: clock.now }));
    await incumbent.acquire();

    // The delay overshoots the wait window AFTER the bottom-of-loop deadline check
    // has already passed (the clock is still < deadline when that check runs). The
    // next iteration's TOP-of-loop check then catches the elapsed window — the path
    // that prevents a poll-and-acquire after an overshooting sleep.
    let firstDelay = true;
    const delay = async (): Promise<void> => {
      if (firstDelay) {
        firstDelay = false;
        clock.advance(WAIT_MS + 1); // jump past the deadline during the sleep
        await incumbent.renewOnce(); // keep the incumbent's lease live
      }
    };
    const challenger = createLeaseManager(
      managerOptions({ storage, getNow: clock.now, holderId: 'engine-b', delay }),
    );

    let caught: unknown;
    try {
      await challenger.acquire();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EngineLeaseAcquisitionTimeoutError);
    // waitedMs reports the ACTUAL elapsed wait (getNow - startedAt), not the
    // configured window: the overshooting sleep advanced the clock by WAIT_MS + 1,
    // so an accurate reading is WAIT_MS + 1 — the old code reported WAIT_MS flat.
    expect((caught as EngineLeaseAcquisitionTimeoutError).waitedMs).toBe(WAIT_MS + 1);
  });

  it('uses the real setTimeout poll when no delay is injected', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const incumbent = createLeaseManager(managerOptions({ storage, getNow: clock.now }));
    await incumbent.acquire();

    // No injected delay → the default real setTimeout poll runs. The challenger
    // sees the live incumbent on its first poll and enters the real delay; we
    // release shortly after so a later real-timer iteration acquires. A 1ms poll
    // keeps this fast and the small real delay before release guarantees the
    // first iteration genuinely hits the default setTimeout path.
    const challenger = createLeaseManager(
      managerOptions({
        storage,
        getNow: clock.now,
        holderId: 'engine-b',
        acquirePollIntervalMs: 1,
      }),
    );
    const acquired = challenger.acquire();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await incumbent.release();
    await acquired;

    expect(await holderId(storage)).toBe('engine-b');
  });

  it('steals an expired lease at epoch+1', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const incumbent = createLeaseManager(managerOptions({ storage, getNow: clock.now }));
    await incumbent.acquire();
    // Stop the incumbent renewing, then let its lease lapse.
    incumbent.stop();
    clock.advance(TTL_MS + 1);

    const challenger = createLeaseManager(
      managerOptions({ storage, getNow: clock.now, holderId: 'engine-b' }),
    );
    await challenger.acquire();

    expect(await readEpoch(storage)).toBe(2);
    const holder = await readHolder(storage);
    expect(holder?.holderId).toBe('engine-b');
    expect(holder?.epoch).toBe(2);
  });

  it('reports deposed on a CAS-false renewal (a successor stole the lease)', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const lost: LeaseLostReason[] = [];
    const incumbent = createLeaseManager(
      managerOptions({ storage, getNow: clock.now, onLeaseLost: (r) => lost.push(r) }),
    );
    await incumbent.acquire();

    // Successor steals after expiry, bumping the holder bytes + epoch.
    clock.advance(TTL_MS + 1);
    const successor = createLeaseManager(
      managerOptions({ storage, getNow: clock.now, holderId: 'engine-b' }),
    );
    await successor.acquire();

    // The incumbent tries to renew against its now-stale holder bytes.
    await incumbent.renewOnce();

    expect(lost).toEqual(['deposed']);
    expect(incumbent.health()).toEqual({
      status: 'contested',
      holdsLease: false,
      lossReason: 'deposed',
      holderId: 'engine-a',
      heldSince: 1_000_000,
      expiresAt: 1_030_000,
      lastRenewedAt: 1_000_000,
      fencingEpoch: 1,
    });
    // The successor's record is intact — a deposed renewal does not clobber it.
    expect(await holderId(storage)).toBe('engine-b');
    expect(await readEpoch(storage)).toBe(2);
  });

  it('reports renewal-unconfirmable when storage fails after the lease expired', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const lost: LeaseLostReason[] = [];
    const manager = createLeaseManager(
      managerOptions({ storage, getNow: clock.now, onLeaseLost: (r) => lost.push(r) }),
    );
    await manager.acquire();

    // Make conditionalBatch throw, and advance the clock past expiry so the
    // engine can no longer prove ownership.
    storage.conditionalBatch = (): Promise<boolean> => {
      throw new Error('storage offline');
    };
    clock.advance(TTL_MS + 1);
    await manager.renewOnce();

    expect(lost).toEqual(['renewal-unconfirmable']);
    expect(manager.health()).toEqual({
      status: 'contested',
      holdsLease: false,
      lossReason: 'renewal-unconfirmable',
      holderId: 'engine-a',
      heldSince: 1_000_000,
      expiresAt: 1_030_000,
      lastRenewedAt: 1_000_000,
      fencingEpoch: 1,
    });
  });

  it('does not report loss on a transient storage failure before expiry', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const lost: LeaseLostReason[] = [];
    const manager = createLeaseManager(
      managerOptions({ storage, getNow: clock.now, onLeaseLost: (r) => lost.push(r) }),
    );
    await manager.acquire();

    storage.conditionalBatch = (): Promise<boolean> => {
      throw new Error('storage offline');
    };
    clock.advance(TTL_MS - 1);
    await manager.renewOnce();

    expect(lost).toEqual([]);
  });

  it('does not report loss on a transient storage failure with ample slack before expiry', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const lost: LeaseLostReason[] = [];
    const manager = createLeaseManager(
      managerOptions({ storage, getNow: clock.now, onLeaseLost: (r) => lost.push(r) }),
    );
    await manager.acquire();

    storage.conditionalBatch = (): Promise<boolean> => {
      throw new Error('storage blip');
    };
    // Only one renewal interval elapsed — still well inside the lease.
    clock.advance(RENEW_MS);
    await manager.renewOnce();

    expect(lost).toEqual([]);
  });

  it('release on a deposed instance does not clobber the successor (CAS guard)', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const incumbent = createLeaseManager(managerOptions({ storage, getNow: clock.now }));
    await incumbent.acquire();

    clock.advance(TTL_MS + 1);
    const successor = createLeaseManager(
      managerOptions({ storage, getNow: clock.now, holderId: 'engine-b' }),
    );
    await successor.acquire();

    // The deposed incumbent disposes; its conditional release must be a no-op.
    await incumbent.release();

    const holder = await readHolder(storage);
    expect(holder?.holderId).toBe('engine-b');
    expect(holder?.epoch).toBe(2);
  });

  it('renewOnce after stop is a no-op', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const lost: LeaseLostReason[] = [];
    const manager = createLeaseManager(
      managerOptions({ storage, getNow: clock.now, onLeaseLost: (r) => lost.push(r) }),
    );
    await manager.acquire();
    manager.stop();

    const epochBefore = await readEpoch(storage);
    const holderBefore = await readHolder(storage);
    clock.advance(RENEW_MS);
    await manager.renewOnce();

    expect(await readEpoch(storage)).toBe(epochBefore);
    expect(await holderExpiry(storage)).toBe(holderBefore?.expiresAt);
    expect(lost).toEqual([]);
    expect(manager.health()).toEqual({ status: 'no-lease', holdsLease: false });
  });

  it('acquire returns without owning when the manager is already stopped', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const manager = createLeaseManager(managerOptions({ storage, getNow: clock.now }));
    manager.stop();

    await manager.acquire();

    expect(await readEpoch(storage)).toBeNull();
    expect(manager.currentEpochBytes()).toBeNull();
  });

  it('startRenewal drives a real renewal interval and is idempotent', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const manager = createLeaseManager(
      managerOptions({ storage, getNow: clock.now, renewIntervalMs: 5 }),
    );
    await manager.acquire();
    const expiryBefore = await holderExpiry(storage);

    clock.advance(5);
    manager.startRenewal();
    manager.startRenewal(); // second call is a no-op (no second interval)
    // Wait for at least one interval tick to fire.
    await new Promise((resolve) => setTimeout(resolve, 30));
    manager.stop();

    expect(await holderExpiry(storage)).toBeGreaterThan(expiryBefore!);
  });

  it('startRenewal after stop does not start an interval', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const manager = createLeaseManager(
      managerOptions({ storage, getNow: clock.now, renewIntervalMs: 5 }),
    );
    await manager.acquire();
    manager.stop();
    const expiryBefore = await holderExpiry(storage);

    clock.advance(5);
    manager.startRenewal();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(await holderExpiry(storage)).toBe(expiryBefore);
  });

  it('throws EngineLeaseCorruptedError on a non-8-byte epoch (fails closed, never lowers the watermark)', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    // A present-but-undecodable epoch must NOT re-mint below the true high-water
    // mark (the prior bug fell back to holder.epoch). Fail closed instead.
    await storage.put(KEYS.leaseEpoch(), new Uint8Array([1, 2, 3]));
    await storage.put(
      KEYS.leaseHolder(),
      new TextEncoder().encode(
        JSON.stringify({ holderId: 'ghost', expiresAt: clock.now() - 1, epoch: 7 }),
      ),
    );

    const manager = createLeaseManager(
      managerOptions({ storage, getNow: clock.now, holderId: 'engine-b' }),
    );
    await expect(manager.acquire()).rejects.toBeInstanceOf(EngineLeaseCorruptedError);
    // Corrupt state untouched — no acquisition happened.
    expect(await holderId(storage)).toBe('ghost');
  });

  it('throws EngineLeaseCorruptedError on an epoch beyond the safe-integer range', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    // 2^64 - 1 decodes to an unsafe integer → decodeEpoch returns null → corruption.
    const unsafeEpoch = new Uint8Array(8);
    new DataView(unsafeEpoch.buffer).setBigUint64(0, 0xffffffffffffffffn, false);
    await storage.put(KEYS.leaseEpoch(), unsafeEpoch);

    const manager = createLeaseManager(
      managerOptions({ storage, getNow: clock.now, holderId: 'engine-b' }),
    );
    await expect(manager.acquire()).rejects.toBeInstanceOf(EngineLeaseCorruptedError);
  });

  it('throws EngineLeaseCorruptedError on an epoch at exactly MAX_SAFE_INTEGER (no room to increment)', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    // MAX_SAFE_INTEGER is itself a safe integer, but acquisition mints `epoch + 1`
    // — and 2^53 is NOT a safe integer, so the next boot would brick the lease.
    // decodeEpoch rejects the ceiling value up front (distinct branch from the
    // 2^64-1 case, which fails isSafeInteger on the decoded value itself).
    const ceilingEpoch = new Uint8Array(8);
    new DataView(ceilingEpoch.buffer).setBigUint64(0, BigInt(Number.MAX_SAFE_INTEGER), false);
    await storage.put(KEYS.leaseEpoch(), ceilingEpoch);

    const manager = createLeaseManager(
      managerOptions({ storage, getNow: clock.now, holderId: 'engine-b' }),
    );
    await expect(manager.acquire()).rejects.toBeInstanceOf(EngineLeaseCorruptedError);
  });

  it('throws EngineLeaseCorruptedError when a holder exists with no epoch key', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    // The protocol never deletes the epoch (release deletes only the holder), so a
    // holder with no epoch key means the epoch was externally removed — corruption.
    await storage.put(
      KEYS.leaseHolder(),
      new TextEncoder().encode(
        JSON.stringify({ holderId: 'ghost', expiresAt: clock.now() + 1000, epoch: 3 }),
      ),
    );

    const manager = createLeaseManager(
      managerOptions({ storage, getNow: clock.now, holderId: 'engine-b' }),
    );
    await expect(manager.acquire()).rejects.toBeInstanceOf(EngineLeaseCorruptedError);
  });

  it('ignores a structurally-invalid holder object (valid JSON, wrong field types)', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    await storage.put(
      KEYS.leaseEpoch(),
      (() => {
        const b = new Uint8Array(8);
        new DataView(b.buffer).setBigUint64(0, 2n, false);
        return b;
      })(),
    );
    // Parses to an object but every field is the wrong type → decodeHolder → null,
    // exercising the structured-validity guard (not the JSON.parse catch).
    await storage.put(
      KEYS.leaseHolder(),
      new TextEncoder().encode(JSON.stringify({ holderId: 123, expiresAt: 'soon', epoch: 0 })),
    );

    const manager = createLeaseManager(
      managerOptions({ storage, getNow: clock.now, holderId: 'engine-b' }),
    );
    await manager.acquire();

    expect(await readEpoch(storage)).toBe(3);
    expect(await holderId(storage)).toBe('engine-b');
  });

  it('ignores a malformed holder record when deciding ownership', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    // Epoch present, holder garbage: treated as "holder absent, epoch present" →
    // re-acquire at epoch+1 conditioning on the epoch.
    await storage.put(
      KEYS.leaseEpoch(),
      (() => {
        const b = new Uint8Array(8);
        new DataView(b.buffer).setBigUint64(0, 4n, false);
        return b;
      })(),
    );
    await storage.put(KEYS.leaseHolder(), new TextEncoder().encode('not json'));

    const manager = createLeaseManager(
      managerOptions({ storage, getNow: clock.now, holderId: 'engine-b' }),
    );
    await manager.acquire();

    expect(await readEpoch(storage)).toBe(5);
    expect(await holderId(storage)).toBe('engine-b');
  });

  it('reads the holder before the epoch so a concurrent cold acquire is not seen as corruption', async () => {
    // readState() reads the two keys non-atomically. A concurrent cold acquire that
    // commits BOTH keys between our reads must not be observed as "epoch absent,
    // holder present" (which tryAcquireOnce treats as corruption). Reading holder
    // FIRST means the only torn view is "holder old/absent, epoch present" — the
    // ordinary steal path. We inject a cold acquire on the holder read to force the
    // interleaving, then assert the challenger does NOT fail closed.
    const base = new MemoryStorage();
    const clock = makeClock();
    let injected = false;
    const concurrent = createLeaseManager(
      managerOptions({ storage: base, getNow: clock.now, holderId: 'engine-x' }),
    );
    const storage: Storage = {
      capabilities: () => base.capabilities(),
      get: async (key) => {
        const value = await base.get(key);
        // After the challenger reads the (empty) holder, a concurrent cold acquire
        // commits epoch+holder before the challenger reads the epoch.
        if (key === KEYS.leaseHolder() && !injected) {
          injected = true;
          await concurrent.acquire();
        }
        return value;
      },
      put: (key, value) => base.put(key, value),
      delete: (key) => base.delete(key),
      scan: (prefix, options) => base.scan(prefix, options),
      batch: (operations) => base.batch(operations),
      conditionalBatch: (conditions, operations) => base.conditionalBatch(conditions, operations),
      [Symbol.dispose]: () => base[Symbol.dispose](),
    };

    const challenger = createLeaseManager(
      managerOptions({ storage, getNow: clock.now, holderId: 'engine-b', waitTimeoutMs: 0 }),
    );
    // Must NOT throw EngineLeaseCorruptedError: the concurrent holder it now sees is
    // live, so it cleanly times out (lease held) rather than fail-closing.
    await expect(challenger.acquire()).rejects.toBeInstanceOf(EngineLeaseAcquisitionTimeoutError);

    await concurrent.release();
  });

  it('contains a rejecting renewal so the interval and a later release never reject', async () => {
    // renewUnderGuard swallows a renewal rejection so the fire-and-forget interval
    // cannot leak an unhandled rejection, and release()'s await of the in-flight
    // renewal stays safe (best-effort, never-reject). Force renewOnce to throw via a
    // getNow that throws only once the renewal computes expiresAt (after acquire and
    // the renewal's stopped/leaseLost guards have read the clock).
    const storage = new MemoryStorage();
    let throwOnNow = false;
    let value = 1_000_000;
    const getNow = (): number => {
      if (throwOnNow) throw new Error('clock blew up mid-renewal');
      value += 1;
      return value;
    };
    const manager = createLeaseManager(managerOptions({ storage, getNow, renewIntervalMs: 5 }));
    await manager.acquire();

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      throwOnNow = true; // the next renewal's expiresAt computation throws
      manager.startRenewal();
      // Let the interval fire at least once; the guard must contain the rejection.
      await new Promise((resolve) => setTimeout(resolve, 25));
      throwOnNow = false; // let release() compute its own clock value normally
      // release() awaits the (contained) in-flight renewal and must still resolve.
      await expect(manager.release()).resolves.toBeUndefined();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      manager.stop();
    }
  });

  it('fails closed before minting an epoch at the safe-integer ceiling', async () => {
    // The stored epoch is MAX_SAFE_INTEGER - 1 (still decodable) with no live holder,
    // so a steal would mint MAX_SAFE_INTEGER — which decodeEpoch rejects on the next
    // boot (no room to increment), bricking the lease. tryAcquireOnce must fail closed
    // here (operator repair) rather than write the unrecoverable epoch. Symmetric to
    // the decode-side ceiling guard.
    const storage = new MemoryStorage();
    const clock = makeClock();
    const ceilingMinusOne = new Uint8Array(8);
    new DataView(ceilingMinusOne.buffer).setBigUint64(
      0,
      BigInt(Number.MAX_SAFE_INTEGER - 1),
      false,
    );
    await storage.put(KEYS.leaseEpoch(), ceilingMinusOne);

    const manager = createLeaseManager(
      managerOptions({ storage, getNow: clock.now, holderId: 'engine-b' }),
    );
    await expect(manager.acquire()).rejects.toBeInstanceOf(EngineLeaseCorruptedError);
    // The epoch is untouched — no unrecoverable value was written.
    expect(await readEpoch(storage)).toBe(Number.MAX_SAFE_INTEGER - 1);
  });

  it('treats a holder with a non-safe-integer expiresAt as malformed (stealable, not live)', async () => {
    // A corrupt/foreign holder with a huge finite expiresAt (1e20) must NOT read as
    // "live" and wedge acquisition until timeout — decodeHolder rejects it (expiresAt
    // is validated as a safe integer like epoch), so it is stealable.
    const storage = new MemoryStorage();
    const clock = makeClock();
    // A valid epoch must accompany it (epoch-absent + holder-present is corruption);
    // the steal re-acquires at epoch+1 conditioning on the epoch.
    const epochBytes = new Uint8Array(8);
    new DataView(epochBytes.buffer).setBigUint64(0, 3n, false);
    await storage.put(KEYS.leaseEpoch(), epochBytes);
    await storage.put(
      KEYS.leaseHolder(),
      new TextEncoder().encode(JSON.stringify({ holderId: 'ghost', expiresAt: 1e20, epoch: 3 })),
    );

    const manager = createLeaseManager(
      managerOptions({ storage, getNow: clock.now, holderId: 'engine-b', waitTimeoutMs: 0 }),
    );
    // Acquires immediately (the malformed holder is not live), does not time out.
    await manager.acquire();

    expect(await holderId(storage)).toBe('engine-b');
    expect(await readEpoch(storage)).toBe(4);
  });

  it('release awaits an in-flight renewal so the holder is deleted, not stranded', async () => {
    // Regression for the renew×release race: during dispose, teardown stops
    // renewals then releases — but a renewal that began just before stop() can
    // still commit a NEWER holder afterward. If release CASes on the bytes it
    // captured before that commit, the delete misses and the holder survives until
    // TTL. release() must await the in-flight (guarded) renewal first so its
    // CAS-delete conditions on the freshest holder. We drive the renewal through
    // the real interval (so it populates inFlightRenewal), gate its conditionalBatch
    // open, fire release concurrently, then let the renewal finish.
    const base = new MemoryStorage();
    const clock = makeClock();
    const renewalGate = createGatedLeaseHolderWriteStorage(base, {
      // Gate ONLY the first RENEWAL write (holder put #2 — acquire is put #1),
      // not acquire's initial take or release's delete. Commit first, THEN park,
      // so the newer holder is durably in storage while release waits — exactly
      // the ordering that would strand the holder if release did not await us.
      gateOnHolderPut: 2,
      phase: 'afterCommit',
    });
    const storage = renewalGate.storage;

    const manager = createLeaseManager(
      managerOptions({ storage, getNow: clock.now, renewIntervalMs: 5 }),
    );
    await manager.acquire(); // holder put #1
    const holderAfterAcquire = await readHolder(storage);

    // Drive a guarded renewal via the interval; it commits a newer holder then
    // parks inside the gated conditionalBatch, leaving inFlightRenewal set.
    clock.advance(RENEW_MS);
    manager.startRenewal();
    await renewalGate.reached;
    // The renewal already wrote a newer expiresAt before parking.
    expect(await holderExpiry(storage)).toBeGreaterThan(holderAfterAcquire!.expiresAt);

    // Release concurrently — it must await the parked renewal before its CAS-delete.
    const released = manager.release();
    renewalGate.release(); // let the parked renewal resolve
    await released;

    // The holder key is gone: release awaited the renewal and deleted the freshest
    // bytes. Without the await, release's CAS (on pre-renewal bytes) would have
    // missed and left the holder behind.
    expect(await readHolder(storage)).toBeNull();
    // The epoch high-water mark survives release.
    expect(await readEpoch(storage)).toBe(1);
  });

  it('serializes renewals: an overlapping tick is skipped and does not falsely report deposed', async () => {
    // Regression for overlapping renewal ticks: a second interval tick that fires
    // while the first renewal is still in flight would CAS against stale
    // lastHolderBytes and spuriously report 'deposed'. The single-flight guard
    // skips the overlapping tick. We gate the first renewal's conditionalBatch so
    // the interval fires repeatedly while it is parked, then assert no loss.
    const base = new MemoryStorage();
    const clock = makeClock();
    const lost: LeaseLostReason[] = [];
    const renewalGate = createGatedLeaseHolderWriteStorage(base, {
      gateOnHolderPut: 2,
      phase: 'beforeCommit',
    });
    const storage = renewalGate.storage;

    const manager = createLeaseManager(
      managerOptions({
        storage,
        getNow: clock.now,
        renewIntervalMs: 5,
        onLeaseLost: (reason) => lost.push(reason),
      }),
    );
    await manager.acquire(); // holder put #1 (not gated)

    clock.advance(RENEW_MS);
    manager.startRenewal();
    // Let several interval ticks fire while the first renewal is parked. The guard
    // must skip every overlapping tick — only the parked one is in flight.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(renewalGate.holderPutCount()).toBe(2); // exactly one renewal write reached storage (the parked one)

    renewalGate.release(); // unblock the parked renewal
    await new Promise((resolve) => setTimeout(resolve, 10));
    manager.stop();

    // No overlapping renewal CASed against stale bytes → no false deposition.
    expect(lost).toEqual([]);
  });
});
