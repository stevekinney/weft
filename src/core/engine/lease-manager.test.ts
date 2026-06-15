import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { EngineLeaseAcquisitionTimeoutError } from './errors.ts';
import {
  createLeaseManager,
  type LeaseLostReason,
  type LeaseManagerOptions,
} from './lease-manager.ts';

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

function readEpoch(storage: MemoryStorage): Promise<number | null> {
  return storage.get(KEYS.leaseEpoch()).then((raw) => {
    if (raw === null) return null;
    return Number(new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getBigUint64(0, false));
  });
}

async function readHolder(
  storage: MemoryStorage,
): Promise<{ holderId: string; expiresAt: number; epoch: number } | null> {
  const raw = await storage.get(KEYS.leaseHolder());
  if (raw === null) return null;
  return JSON.parse(textDecoder.decode(raw));
}

/** Field accessors that read the holder first, then access the field (avoids the
 * no-await-expression-member lint and keeps assertions terse). */
async function holderId(storage: MemoryStorage): Promise<string | undefined> {
  const holder = await readHolder(storage);
  return holder?.holderId;
}
async function holderExpiry(storage: MemoryStorage): Promise<number | undefined> {
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
    // The incumbent keeps a live lease the whole time. The injected delay advances
    // the shared clock by one poll interval each iteration, so the wait deadline
    // (read from getNow) trips deterministically — while the incumbent's
    // expiresAt = T + 30000 stays far ahead of deadline = T + 60000... so the lease
    // also lapses by then. To keep the lease live across the whole wait, the
    // incumbent renews on each poll, modeling a healthy holder that refuses to
    // hand off. The point under test is purely the timeout firing.
    const incumbent = createLeaseManager(managerOptions({ storage, getNow: clock.now }));
    await incumbent.acquire();

    const delay = async (ms: number): Promise<void> => {
      clock.advance(ms);
      await incumbent.renewOnce(); // healthy incumbent keeps its lease alive
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
    expect((caught as EngineLeaseAcquisitionTimeoutError).heldBy).toBe('engine-a');
    expect((caught as EngineLeaseAcquisitionTimeoutError).waitedMs).toBe(WAIT_MS);
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
    // The successor's record is intact — a deposed renewal does not clobber it.
    expect(await holderId(storage)).toBe('engine-b');
    expect(await readEpoch(storage)).toBe(2);
  });

  it('reports renewal-unconfirmable when storage fails and the lease is past its safety margin', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const lost: LeaseLostReason[] = [];
    const manager = createLeaseManager(
      managerOptions({ storage, getNow: clock.now, onLeaseLost: (r) => lost.push(r) }),
    );
    await manager.acquire();

    // Make conditionalBatch throw, and advance the clock so we are within one
    // renewal interval of expiry (past the unconfirmable margin).
    storage.conditionalBatch = (): Promise<boolean> => {
      throw new Error('storage offline');
    };
    clock.advance(TTL_MS - RENEW_MS + 1);
    await manager.renewOnce();

    expect(lost).toEqual(['renewal-unconfirmable']);
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

  it('tolerates a corrupt epoch value by treating the store as needing a fresh transfer', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    // Seed a non-8-byte epoch and a valid live holder so the challenger must wait,
    // then steal once expired — proving decodeEpoch's null path is reachable.
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
    await manager.acquire();

    // baseEpoch falls back to the holder's epoch (7) when the epoch key is corrupt.
    expect(await readEpoch(storage)).toBe(8);
    expect(await holderId(storage)).toBe('engine-b');
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
});
