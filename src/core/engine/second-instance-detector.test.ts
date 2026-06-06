import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import {
  createSecondInstanceDetectionTick,
  createSecondInstanceDetector,
  type SecondInstanceDetector,
  type SecondInstanceDetectorOptions,
} from './second-instance-detector.ts';

const INTERVAL_MS = 15_000;
// Staleness window = interval * (ADVANCE_TICKS_BEFORE_WARN + 1) = 15_000 * 3 = 45_000.
const STALENESS_WINDOW_MS = INTERVAL_MS * 3;

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

/** Write a foreign instance's heartbeat record directly into the store. */
async function seedHeartbeat(
  storage: MemoryStorage,
  instanceId: string,
  heartbeatAt: number,
  sequence = 1,
): Promise<void> {
  await storage.put(
    KEYS.liveness(instanceId),
    new TextEncoder().encode(JSON.stringify({ instanceId, heartbeatAt, sequence })),
  );
}

function detectorOptions(
  overrides: Partial<SecondInstanceDetectorOptions> &
    Pick<SecondInstanceDetectorOptions, 'storage' | 'getNow'>,
): SecondInstanceDetectorOptions {
  return {
    instanceId: 'self',
    intervalMs: INTERVAL_MS,
    ...overrides,
  };
}

describe('createSecondInstanceDetector', () => {
  it('stays quiet when no other instance is present', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const warnings: string[] = [];
    const detector = createSecondInstanceDetector(
      detectorOptions({ storage, getNow: clock.now, warn: (m) => warnings.push(m) }),
    );

    for (let i = 0; i < 5; i += 1) {
      await detector.tick();
      clock.advance(INTERVAL_MS);
    }

    expect(warnings).toEqual([]);
    // Our own heartbeat is written and readable.
    expect(await storage.get(KEYS.liveness('self'))).not.toBeNull();
  });

  it('does NOT warn on a recent-but-stale foreign heartbeat that never advances (rolling-deploy handoff)', async () => {
    // A predecessor that handed off cleanly leaves a heartbeat that is recent at
    // our boot but never advances afterward. This is the rolling-deploy case and
    // must be quiet.
    const storage = new MemoryStorage();
    const clock = makeClock();
    const warnings: string[] = [];
    await seedHeartbeat(storage, 'predecessor', clock.now()); // recent, frozen

    const detector = createSecondInstanceDetector(
      detectorOptions({ storage, getNow: clock.now, warn: (m) => warnings.push(m) }),
    );

    // Several ticks; the predecessor's heartbeat never changes.
    for (let i = 0; i < 4; i += 1) {
      await detector.tick();
      clock.advance(INTERVAL_MS);
    }

    expect(warnings).toEqual([]);
  });

  it('warns when a foreign heartbeat advances across two ticks (autoscaling=2)', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const warnings: string[] = [];
    const detector = createSecondInstanceDetector(
      detectorOptions({ storage, getNow: clock.now, warn: (m) => warnings.push(m) }),
    );

    // Tick 1: observe the peer's first heartbeat (no prior sample yet).
    await seedHeartbeat(storage, 'peer', clock.now(), 1);
    await detector.tick();
    expect(warnings).toEqual([]);

    // Tick 2: peer heartbeat advanced once — one advance, still below threshold.
    clock.advance(INTERVAL_MS);
    await seedHeartbeat(storage, 'peer', clock.now(), 2);
    await detector.tick();
    expect(warnings).toEqual([]);

    // Tick 3: peer heartbeat advanced again — two advances → warn.
    clock.advance(INTERVAL_MS);
    await seedHeartbeat(storage, 'peer', clock.now(), 3);
    await detector.tick();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('WeftSecondInstanceWarning');
    expect(warnings[0]).toContain('peer');
  });

  it('warns at most once per peer instance', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const warnings: string[] = [];
    const detector = createSecondInstanceDetector(
      detectorOptions({ storage, getNow: clock.now, warn: (m) => warnings.push(m) }),
    );

    for (let i = 1; i <= 6; i += 1) {
      await seedHeartbeat(storage, 'peer', clock.now(), i);
      await detector.tick();
      clock.advance(INTERVAL_MS);
    }

    // Many advancing ticks, exactly one warning.
    expect(warnings.length).toBe(1);
  });

  it('resets a peer advance streak if its heartbeat stops advancing before the threshold', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const warnings: string[] = [];
    const detector = createSecondInstanceDetector(
      detectorOptions({ storage, getNow: clock.now, warn: (m) => warnings.push(m) }),
    );

    // Tick 1: first sample.
    await seedHeartbeat(storage, 'peer', clock.now(), 1);
    await detector.tick();
    // Tick 2: advanced once.
    clock.advance(INTERVAL_MS);
    await seedHeartbeat(storage, 'peer', clock.now(), 2);
    await detector.tick();
    // Tick 3: peer FROZEN (did not advance) — streak resets to 0, still recent.
    clock.advance(INTERVAL_MS);
    await detector.tick();
    expect(warnings).toEqual([]);
    // Tick 4: advances again — only one advance since the reset, no warning yet.
    clock.advance(INTERVAL_MS);
    await seedHeartbeat(storage, 'peer', clock.now(), 3);
    await detector.tick();
    expect(warnings).toEqual([]);
  });

  it('sweeps a provably-stale foreign heartbeat on the first tick', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    // A long-dead instance: heartbeat older than 10x the staleness window.
    const ancient = clock.now() - STALENESS_WINDOW_MS * 11;
    await seedHeartbeat(storage, 'crashed', ancient);

    const detector = createSecondInstanceDetector(detectorOptions({ storage, getNow: clock.now }));
    await detector.tick();

    expect(await storage.get(KEYS.liveness('crashed'))).toBeNull();
  });

  it('does NOT sweep a recent foreign heartbeat', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    await seedHeartbeat(storage, 'live-peer', clock.now());

    const detector = createSecondInstanceDetector(detectorOptions({ storage, getNow: clock.now }));
    await detector.tick();

    expect(await storage.get(KEYS.liveness('live-peer'))).not.toBeNull();
  });

  it('sweeps only once (on the first tick), not every tick', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    let deleteCount = 0;
    const baseDelete = storage.delete.bind(storage);
    storage.delete = async (key: string) => {
      deleteCount += 1;
      return baseDelete(key);
    };
    // Seed a stale heartbeat so the first tick performs a sweep delete.
    await seedHeartbeat(storage, 'crashed', clock.now() - STALENESS_WINDOW_MS * 11);

    const detector = createSecondInstanceDetector(detectorOptions({ storage, getNow: clock.now }));
    await detector.tick();
    const afterFirst = deleteCount;
    // A second tick must not sweep again (nothing stale remains, and the sweep is
    // first-tick-only regardless).
    clock.advance(INTERVAL_MS);
    await detector.tick();

    expect(afterFirst).toBe(1);
    expect(deleteCount).toBe(1);
  });

  it('ignores malformed liveness values without throwing', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const warnings: string[] = [];
    await storage.put(KEYS.liveness('garbage'), new TextEncoder().encode('not json{'));
    await storage.put(
      KEYS.liveness('wrong-shape'),
      new TextEncoder().encode(JSON.stringify({ instanceId: 'x' })), // missing fields
    );

    const detector = createSecondInstanceDetector(
      detectorOptions({ storage, getNow: clock.now, warn: (m) => warnings.push(m) }),
    );

    await detector.tick();
    clock.advance(INTERVAL_MS);
    await detector.tick();

    expect(warnings).toEqual([]);
  });

  it('stop() deletes this instance heartbeat and halts further ticks', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const detector = createSecondInstanceDetector(detectorOptions({ storage, getNow: clock.now }));

    await detector.tick();
    expect(await storage.get(KEYS.liveness('self'))).not.toBeNull();

    await detector.stop();
    expect(await storage.get(KEYS.liveness('self'))).toBeNull();

    // A tick after stop is a no-op: it must not rewrite our heartbeat.
    await detector.tick();
    expect(await storage.get(KEYS.liveness('self'))).toBeNull();
  });

  it('swallows a heartbeat write failure without throwing', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    storage.put = async () => {
      throw new Error('store unavailable');
    };
    const detector = createSecondInstanceDetector(detectorOptions({ storage, getNow: clock.now }));

    // Best-effort: a failed heartbeat write must not surface to the engine.
    await expect(detector.tick()).resolves.toBeUndefined();
  });

  it('swallows a delete failure during stop and during sweep', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    await seedHeartbeat(storage, 'crashed', clock.now() - STALENESS_WINDOW_MS * 11);
    storage.delete = async () => {
      throw new Error('store unavailable');
    };
    const detector = createSecondInstanceDetector(detectorOptions({ storage, getNow: clock.now }));

    // Sweep delete throws internally; tick still resolves.
    await expect(detector.tick()).resolves.toBeUndefined();
    // stop() delete throws internally; stop still resolves.
    await expect(detector.stop()).resolves.toBeUndefined();
  });

  it('two real detectors over one shared store each warn about the other (autoscaling=2)', async () => {
    // The end-to-end proof: detector A's put() must feed detector B's scan(), and
    // vice versa, through a single shared store — not a puppet-seeded key. Tick the
    // two alternately so each observes the other's heartbeat advance across ticks.
    const storage = new MemoryStorage();
    const clock = makeClock();
    const warningsA: string[] = [];
    const warningsB: string[] = [];
    const detectorA = createSecondInstanceDetector(
      detectorOptions({
        storage,
        getNow: clock.now,
        instanceId: 'instance-a',
        warn: (m) => warningsA.push(m),
      }),
    );
    const detectorB = createSecondInstanceDetector(
      detectorOptions({
        storage,
        getNow: clock.now,
        instanceId: 'instance-b',
        warn: (m) => warningsB.push(m),
      }),
    );

    // Several rounds; each round both write, then time advances.
    for (let round = 0; round < 4; round += 1) {
      await detectorA.tick();
      await detectorB.tick();
      clock.advance(INTERVAL_MS);
    }

    expect(warningsA.length).toBe(1);
    expect(warningsA[0]).toContain('instance-b');
    expect(warningsB.length).toBe(1);
    expect(warningsB[0]).toContain('instance-a');
  });

  it('createSecondInstanceDetectionTick skips when the detector resolver returns null', () => {
    // Simulates a garbage-collected or disposed engine: no detector to tick.
    let ticked = false;
    const stubDetector: SecondInstanceDetector = {
      tick: async () => {
        ticked = true;
      },
      stop: async () => {},
    };
    void stubDetector;
    const tick = createSecondInstanceDetectionTick(() => null);
    expect(() => tick()).not.toThrow();
    expect(ticked).toBe(false);
  });

  it('createSecondInstanceDetectionTick drives a live detector and swallows tick failures', async () => {
    let ticks = 0;
    const failingDetector: SecondInstanceDetector = {
      tick: async () => {
        ticks += 1;
        throw new Error('tick blew up');
      },
      stop: async () => {},
    };
    const tick = createSecondInstanceDetectionTick(() => failingDetector);
    // The synchronous call must not throw even though tick() rejects.
    expect(() => tick()).not.toThrow();
    // Let the swallowed rejection settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(ticks).toBe(1);
  });

  it('uses process.emitWarning by default when no warn sink is injected', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const emitted: string[] = [];
    const originalEmitWarning = process.emitWarning;
    process.emitWarning = ((message: string | Error) => {
      emitted.push(typeof message === 'string' ? message : message.message);
    }) as typeof process.emitWarning;
    try {
      const detector = createSecondInstanceDetector(
        // No `warn` → falls back to process.emitWarning.
        detectorOptions({ storage, getNow: clock.now }),
      );
      for (let i = 1; i <= 3; i += 1) {
        await seedHeartbeat(storage, 'peer', clock.now(), i);
        await detector.tick();
        clock.advance(INTERVAL_MS);
      }
    } finally {
      process.emitWarning = originalEmitWarning;
    }

    expect(emitted.some((m) => m.includes('WeftSecondInstanceWarning'))).toBe(true);
  });
});
