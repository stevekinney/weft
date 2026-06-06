import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import {
  createSecondInstanceDetectionTick,
  createSecondInstanceDetector,
  SECOND_INSTANCE_WARNING_NAME,
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

/**
 * Wrap a store's `put` so the first call parks until `release()` is invoked, and
 * `entered` resolves the moment that first put is reached. Lets a test position
 * a tick *inside* its heartbeat write — past the post-await `stopped` re-check —
 * then race `stop()` against the still-pending put. The `entered` promise (not a
 * spin on a boolean) is how the test awaits that position deterministically.
 */
function gatedPut(storage: MemoryStorage): {
  put: MemoryStorage['put'];
  release: () => void;
  entered: Promise<void>;
} {
  let release!: () => void;
  let signalEntered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  let gated = false;
  const basePut = storage.put.bind(storage);
  const put = async (key: string, value: Uint8Array): Promise<void> => {
    if (!gated) {
      gated = true;
      signalEntered();
      await gate;
    }
    return basePut(key, value);
  };
  return { put, release, entered };
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
    // The injected sink sees only the message; the WeftSecondInstanceWarning
    // name rides on the Warning object via the default process.emitWarning sink
    // (asserted separately). Pin stable message content here.
    expect(warnings[0]).toContain('writing to this durable store');
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
    clock.advance(INTERVAL_MS);

    // Introduce FRESH stale material before the second tick. Without the
    // first-tick-only `swept` guard, this would be swept on tick 2 — so the
    // assertion below genuinely discriminates the guard rather than relying on
    // tick 1 having already emptied the store.
    await seedHeartbeat(storage, 'crashed-2', clock.now() - STALENESS_WINDOW_MS * 11);
    await detector.tick();

    expect(afterFirst).toBe(1);
    expect(deleteCount).toBe(1);
    // Behavioral proof: the guard left the newly-stale key in place.
    expect(await storage.get(KEYS.liveness('crashed-2'))).not.toBeNull();
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
    // A non-string instanceId (right keys, wrong type) — rejected by the
    // type half of isUsableHeartbeat, not just the numeric-validity half.
    await storage.put(
      KEYS.liveness('numeric-id'),
      new TextEncoder().encode(
        JSON.stringify({ instanceId: 42, heartbeatAt: clock.now(), sequence: 1 }),
      ),
    );
    // Valid JSON that decodes to a non-object (a bare number) — rejected before
    // the field checks even run.
    await storage.put(KEYS.liveness('bare-number'), new TextEncoder().encode('42'));
    // Valid JSON literal null — also a non-object.
    await storage.put(KEYS.liveness('json-null'), new TextEncoder().encode('null'));

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

  it('swallows a SYNCHRONOUS throw from storage (put, sweep delete, and stop delete)', async () => {
    // An external Storage may throw synchronously, BEFORE returning a promise.
    // `.catch()` only attaches to a returned promise, so it would miss a sync
    // throw — the bestEffort wrapper uses try/catch around the await to cover
    // both. These overrides are deliberately NON-async so they throw on the call
    // itself, not via a rejected promise.
    const storage = new MemoryStorage();
    const clock = makeClock();
    await seedHeartbeat(storage, 'crashed', clock.now() - STALENESS_WINDOW_MS * 11);
    const syncThrow = (): never => {
      throw new Error('synchronous store failure');
    };
    // Cast through unknown: these test doubles intentionally violate the async
    // signature to simulate a sync-throwing external Storage implementation.
    storage.put = syncThrow as unknown as MemoryStorage['put'];
    storage.delete = syncThrow as unknown as MemoryStorage['delete'];
    const detector = createSecondInstanceDetector(detectorOptions({ storage, getNow: clock.now }));

    // tick(): the first-tick sweep delete AND the heartbeat put both throw
    // synchronously; the tick must still resolve.
    await expect(detector.tick()).resolves.toBeUndefined();
    // stop(): the delete throws synchronously; stop() is fire-and-forget and must
    // never reject.
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

  it('createSecondInstanceDetectionTick self-clears its interval when the resolver returns null', () => {
    // Simulates a garbage-collected or disposed engine: no detector to tick. The
    // tick must clear its own interval (via the tracker handle) so a leaked engine
    // does not leave a no-op timer alive — not relying on the finalizer backstop.
    const interval = setInterval(() => {}, 1_000);
    const tracker = {
      disposed: false,
      cleanupInterval: null,
      secondInstanceDetectionInterval: interval,
      testToken: undefined,
    };
    const tick = createSecondInstanceDetectionTick(() => null, tracker);
    expect(() => tick()).not.toThrow();
    // The interval handle was cleared and nulled on the tracker.
    expect(tracker.secondInstanceDetectionInterval).toBeNull();
    // Idempotent: a second null-resolver tick with the handle already null is a
    // no-op (covers the `!== null` guard's false arm).
    expect(() => tick()).not.toThrow();
    expect(tracker.secondInstanceDetectionInterval).toBeNull();
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
    const interval = setInterval(() => {}, 1_000);
    const tracker = {
      disposed: false,
      cleanupInterval: null,
      secondInstanceDetectionInterval: interval,
      testToken: undefined,
    };
    const tick = createSecondInstanceDetectionTick(() => failingDetector, tracker);
    // The synchronous call must not throw even though tick() rejects.
    expect(() => tick()).not.toThrow();
    // Let the swallowed rejection settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(ticks).toBe(1);
    // A live detector tick leaves the interval untouched (it only self-clears
    // when the engine is gone).
    expect(tracker.secondInstanceDetectionInterval).toBe(interval);
    clearInterval(interval);
  });

  it('warns on a peer whose clock is FROZEN but whose sequence still advances', async () => {
    // The decisive case for sequence-based detection: a live second instance
    // whose wall clock never moves (stepped backward, frozen, or skewed) keeps
    // writing heartbeats with an advancing sequence at a FIXED heartbeatAt. A
    // timestamp-only advance check would treat this peer as never advancing and
    // never warn — a false negative for the exact "real second instance" case.
    const storage = new MemoryStorage();
    const clock = makeClock();
    const warnings: string[] = [];
    const frozenAt = clock.now();
    const detector = createSecondInstanceDetector(
      detectorOptions({ storage, getNow: clock.now, warn: (m) => warnings.push(m) }),
    );

    for (let seq = 1; seq <= 3; seq += 1) {
      // heartbeatAt is pinned to frozenAt every tick; only sequence advances.
      await seedHeartbeat(storage, 'frozen-clock-peer', frozenAt, seq);
      await detector.tick();
      clock.advance(INTERVAL_MS); // OUR clock moves; the peer's recorded one does not.
    }

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('frozen-clock-peer');
  });

  it('ignores heartbeats with non-finite or non-integer or negative sequence/timestamp', async () => {
    // A hostile or corrupt value under the reserved prefix must never enter the
    // algorithm: NaN/Infinity timestamps would defeat the staleness sweep, and
    // NaN/fractional/negative sequences would poison the advance comparison.
    const storage = new MemoryStorage();
    const clock = makeClock();
    const warnings: string[] = [];
    const put = (instanceId: string, record: Record<string, unknown>) =>
      storage.put(
        KEYS.liveness(instanceId),
        new TextEncoder().encode(JSON.stringify({ instanceId, ...record })),
      );
    // JSON.stringify turns NaN/Infinity into null, which fails the typeof check;
    // assert that path too. The fractional/negative cases are genuine numbers
    // that survive JSON and must be rejected by the integer/sign guards.
    await put('nan-seq', { heartbeatAt: clock.now(), sequence: Number.NaN });
    await put('inf-seq', { heartbeatAt: clock.now(), sequence: Number.POSITIVE_INFINITY });
    await put('frac-seq', { heartbeatAt: clock.now(), sequence: 1.5 });
    await put('neg-seq', { heartbeatAt: clock.now(), sequence: -1 });
    await put('nan-time', { heartbeatAt: Number.NaN, sequence: 1 });
    await put('empty-id', { instanceId: '', heartbeatAt: clock.now(), sequence: 1 });

    const detector = createSecondInstanceDetector(
      detectorOptions({ storage, getNow: clock.now, warn: (m) => warnings.push(m) }),
    );

    // Several ticks; every seeded record is invalid, so none can ever advance
    // or warn — and none of them throw the tick.
    for (let i = 0; i < 4; i += 1) {
      await detector.tick();
      clock.advance(INTERVAL_MS);
    }

    expect(warnings).toEqual([]);
    // A negative-sequence record is NOT ancient, so it is also not swept — proof
    // it was rejected at decode, not merely garbage-collected.
    expect(await storage.get(KEYS.liveness('neg-seq'))).not.toBeNull();
  });

  it('drops an overlapping tick instead of running two tick bodies concurrently', async () => {
    // setInterval fires regardless of whether the previous async tick finished.
    // On a slow store a tick can outlast the interval; a second tick that starts
    // while the first is still awaiting storage must be dropped, not run
    // concurrently against the shared sequence/observed/swept state.
    const storage = new MemoryStorage();
    const clock = makeClock();
    let scanStarts = 0;
    let releaseFirstScan!: () => void;
    const firstScanGate = new Promise<void>((resolve) => {
      releaseFirstScan = resolve;
    });
    const baseScan = storage.scan.bind(storage);
    storage.scan = async function* gatedScan(prefix: string) {
      scanStarts += 1;
      if (scanStarts === 1) {
        // Stall the first tick inside scan() so the second tick overlaps it.
        await firstScanGate;
      }
      yield* baseScan(prefix);
    };
    const detector = createSecondInstanceDetector(detectorOptions({ storage, getNow: clock.now }));

    const firstTick = detector.tick(); // enters scan(), stalls on the gate
    await Promise.resolve();
    const secondTick = detector.tick(); // arrives while the first is in flight → dropped
    await secondTick; // returns immediately without entering scan()

    // The overlapping tick never started a scan of its own.
    expect(scanStarts).toBe(1);

    releaseFirstScan();
    await firstTick;
    // After the in-flight tick drains, a later tick runs normally.
    await detector.tick();
    expect(scanStarts).toBe(2);
  });

  it('does NOT rewrite this instance heartbeat when stop() runs mid-tick', async () => {
    // Disposal starts stop() (which deletes our key) while a tick is between
    // reading peers and writing its own heartbeat. The post-await stopped re-check
    // must prevent the in-flight tick from resurrecting a stale, live-looking key.
    const storage = new MemoryStorage();
    const clock = makeClock();
    let releaseScan!: () => void;
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    let gated = false;
    const baseScan = storage.scan.bind(storage);
    storage.scan = async function* gatedScan(prefix: string) {
      if (!gated) {
        gated = true;
        await scanGate; // hold the tick open past stop()
      }
      yield* baseScan(prefix);
    };
    const detector = createSecondInstanceDetector(detectorOptions({ storage, getNow: clock.now }));

    const inFlight = detector.tick(); // stalls inside scan()
    await Promise.resolve();
    await detector.stop(); // sets stopped, deletes our key
    expect(await storage.get(KEYS.liveness('self'))).toBeNull();
    releaseScan();
    await inFlight; // resumes; must observe stopped and skip its put()

    // The stopped detector did not rewrite its heartbeat.
    expect(await storage.get(KEYS.liveness('self'))).toBeNull();
  });

  it('deletes the resurrected heartbeat when stop() races a put already past the re-check', async () => {
    // The narrow residual race: the tick passes the post-await `stopped` re-check
    // (stopped is still false), THEN stop() lands and deletes our key, THEN the
    // in-flight put() resolves and resurrects it. The tick's finally must delete
    // the key again so disposal wins. Gate on put() (not scan) so the tick gets
    // all the way past the re-check before stop() runs.
    const storage = new MemoryStorage();
    const clock = makeClock();
    const { put, release: releasePut, entered: putEntered } = gatedPut(storage);
    storage.put = put;
    const detector = createSecondInstanceDetector(detectorOptions({ storage, getNow: clock.now }));

    const inFlight = detector.tick(); // runs to the put() and stalls on the gate
    // Wait until the tick is parked INSIDE put() — i.e. it passed the post-await
    // `stopped` re-check with wroteHeartbeat=true. The entered promise resolves
    // only once the tick reaches the put, so this is past the re-check.
    await putEntered;
    await detector.stop(); // sets stopped, deletes our key — but the put is queued
    releasePut(); // the queued put now resolves and resurrects the key
    await inFlight; // finally runs: wroteHeartbeat && stopped → delete again

    // Disposal wins: the resurrected key was cleaned up by the tick's finally.
    expect(await storage.get(KEYS.liveness('self'))).toBeNull();
  });

  it('swallows a finally-delete failure when storage is closed during the put-after-stop race', async () => {
    // Same race as above, but the cleanup delete throws (e.g. the store was
    // already closed by disposal). The tick must still resolve — the residual
    // key then lingers until the next boot's staleness sweep, which is the
    // documented best-effort fallback.
    const storage = new MemoryStorage();
    const clock = makeClock();
    const { put, release: releasePut, entered: putEntered } = gatedPut(storage);
    storage.put = put;
    const detector = createSecondInstanceDetector(detectorOptions({ storage, getNow: clock.now }));

    const inFlight = detector.tick(); // runs to the put() and stalls on the gate
    // Park the tick INSIDE put(), past the re-check (wroteHeartbeat=true), before
    // disposing — otherwise it returns at the re-check and the finally-delete
    // branch never runs.
    await putEntered;
    // stop() deletes once (swallowed), then make every later delete throw so the
    // tick's finally-delete hits its catch arm.
    await detector.stop();
    storage.delete = async () => {
      throw new Error('store closed');
    };
    releasePut();

    // The tick resolves despite the finally-delete throwing.
    await expect(inFlight).resolves.toBeUndefined();
  });

  it('sweeps by the scanned key, never a key rebuilt from a spoofed instanceId', async () => {
    // A malformed value parked under liveness:other claims instanceId "live-peer".
    // Sweeping by the decoded instanceId would delete liveness:live-peer (a real,
    // live peer's key). The sweep targets only the scanned key it was read under.
    const storage = new MemoryStorage();
    const clock = makeClock();
    const ancient = clock.now() - STALENESS_WINDOW_MS * 11;
    // Spoof: stored under liveness:other, but claims to be live-peer, and ancient.
    await storage.put(
      KEYS.liveness('other'),
      new TextEncoder().encode(
        JSON.stringify({ instanceId: 'live-peer', heartbeatAt: ancient, sequence: 1 }),
      ),
    );
    // A genuinely live peer under its own correct key.
    await seedHeartbeat(storage, 'live-peer', clock.now(), 1);

    const detector = createSecondInstanceDetector(detectorOptions({ storage, getNow: clock.now }));
    await detector.tick();

    // The live peer's own key is untouched: the ancient spoof did not delete it.
    expect(await storage.get(KEYS.liveness('live-peer'))).not.toBeNull();
    // The spoof's own (scanned) key was swept, because it was provably stale.
    expect(await storage.get(KEYS.liveness('other'))).toBeNull();
  });

  it('does NOT let an identity-mismatched record drive a peer advance or warning', async () => {
    // The anti-spoof half: a record parked under liveness:imposter-key that claims
    // instanceId "victim" and advances its sequence every tick must never warn —
    // its stored instanceId does not match the key it occupies, so evaluatePeers
    // skips it. Recent (so the sweep never removes it), proving the skip is the
    // reason it is ignored, not garbage collection.
    const storage = new MemoryStorage();
    const clock = makeClock();
    const warnings: string[] = [];
    const detector = createSecondInstanceDetector(
      detectorOptions({ storage, getNow: clock.now, warn: (m) => warnings.push(m) }),
    );

    for (let seq = 1; seq <= 4; seq += 1) {
      // Stored under the imposter key, but claims to be "victim".
      await storage.put(
        KEYS.liveness('imposter-key'),
        new TextEncoder().encode(
          JSON.stringify({ instanceId: 'victim', heartbeatAt: clock.now(), sequence: seq }),
        ),
      );
      await detector.tick();
      clock.advance(INTERVAL_MS);
    }

    expect(warnings).toEqual([]);
    // Recent ⇒ never swept; it was ignored at evaluation, not GC'd.
    expect(await storage.get(KEYS.liveness('imposter-key'))).not.toBeNull();
  });

  it('uses process.emitWarning by default, emitting the WeftSecondInstanceWarning name', async () => {
    const storage = new MemoryStorage();
    const clock = makeClock();
    const emitted: Array<{ message: string; name: string | undefined }> = [];
    const originalEmitWarning = process.emitWarning;
    // Capture BOTH args: the name now rides on the second positional argument
    // (the warning type), not the message, so consumers can filter on
    // `warning.name === 'WeftSecondInstanceWarning'`.
    process.emitWarning = ((message: string | Error, name?: unknown) => {
      emitted.push({
        message: typeof message === 'string' ? message : message.message,
        name: typeof name === 'string' ? name : undefined,
      });
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

    const warning = emitted.find((entry) => entry.name === SECOND_INSTANCE_WARNING_NAME);
    expect(warning).toBeDefined();
    // The name is the filterable identifier; the message no longer repeats it.
    expect(warning!.name).toBe('WeftSecondInstanceWarning');
    expect(warning!.message).toContain('writing to this durable store');
    expect(warning!.message).not.toContain('WeftSecondInstanceWarning');
  });
});
