/**
 * Best-effort, warn-only detection of a SECOND engine instance writing to the
 * same durable store — a smoke alarm for singleton-deployment misconfiguration
 * (an autoscaler accidentally set above one replica, or overlapping rolling
 * deploys), NOT a correctness mechanism.
 *
 * **This is liveness, not fencing.** Weft's supported model is one engine process
 * per durable store (see the recovery-and-deploys guide); fenced ownership is a
 * future `MultiEngine` capability that does not exist yet. This detector never
 * blocks boot, gates recovery, refuses a write, or claims ownership. It only
 * observes whether another instance's heartbeat is *advancing while this instance
 * is also running* and emits a warning if so. It does not prevent duplicate
 * execution — infrastructure-level enforcement (`replicas: 1` + a `Recreate`
 * deploy strategy, or a single systemd unit) is the real control.
 *
 * **Why liveness, not a boot check.** A boot-time check cannot distinguish a
 * rolling-deploy handoff from a genuine second instance: both leave a recent
 * heartbeat record in the store. Only observing a *foreign* heartbeat advance
 * across several of our own ticks separates a live peer (autoscaling=2 → both
 * heartbeats advance forever → both warn) from a dead-but-recent predecessor (a
 * clean `Recreate` deploy → old heartbeat never advances after handoff → quiet).
 *
 * **Advance is measured by sequence, not wall clock.** Each heartbeat carries a
 * per-instance monotonic `sequence`; a peer counts as advancing only when its
 * `sequence` grows between two of *our* ticks. A peer's sequence cannot increase
 * unless it is alive and ticking in our own time frame, so detection never
 * compares clocks across hosts — it stays correct even if a peer's clock is
 * frozen, skewed, or stepped backward. `heartbeatAt` exists only for the boot
 * staleness sweep that garbage-collects long-dead instances' keys.
 *
 * Each engine writes its own heartbeat under `liveness:<instanceId>` and scans
 * the `liveness:` prefix to observe peers. Per-instance keys (not one shared,
 * clobbered key) keep every heartbeat independently observable and the sequence
 * monotonic per writer.
 *
 * @module core/engine/second-instance-detector
 */

import { KEYS, type Storage } from '../../storage/interface.ts';

/** A single engine's liveness heartbeat, JSON-encoded as the stored value. */
type LivenessHeartbeat = {
  instanceId: string;
  /** Wall-clock ms (from the engine's `getNow`) of the most recent heartbeat write. */
  heartbeatAt: number;
  /** Monotonic per-instance counter; advances every tick. */
  sequence: number;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function encodeHeartbeat(heartbeat: LivenessHeartbeat): Uint8Array {
  return textEncoder.encode(JSON.stringify(heartbeat));
}

/**
 * True only when every field is the right type AND a *usable* value:
 * `heartbeatAt` must be finite (a `NaN`/`Infinity` timestamp would defeat both
 * the staleness sweep — `NaN < staleBefore` is always false — and recency), and
 * `sequence` must be a non-negative integer (the advance check compares
 * sequences, so a `NaN`/fractional/negative value must never enter `observed`).
 */
function isUsableHeartbeat(candidate: {
  instanceId: unknown;
  heartbeatAt: unknown;
  sequence: unknown;
}): candidate is LivenessHeartbeat {
  const { instanceId, heartbeatAt, sequence } = candidate;
  return (
    typeof instanceId === 'string' &&
    instanceId.length > 0 &&
    typeof heartbeatAt === 'number' &&
    Number.isFinite(heartbeatAt) &&
    typeof sequence === 'number' &&
    Number.isInteger(sequence) &&
    sequence >= 0
  );
}

/**
 * Decode a stored heartbeat value, tolerating anything that is not a
 * well-formed heartbeat (returns `null`). The detector is best-effort and runs
 * over a shared, reserved storage prefix, so a malformed, hostile, or foreign
 * value is simply ignored rather than thrown on or fed into the algorithm. The
 * numeric-validity guard lives in {@link isUsableHeartbeat}.
 */
function decodeHeartbeat(raw: Uint8Array): LivenessHeartbeat | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(raw));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const candidate = parsed as { instanceId: unknown; heartbeatAt: unknown; sequence: unknown };
  return isUsableHeartbeat(candidate) ? candidate : null;
}

/** Options for {@link createSecondInstanceDetector}. */
export type SecondInstanceDetectorOptions = {
  storage: Storage;
  /** This engine's unique instance id. */
  instanceId: string;
  /** Wall-clock source (ms), injected so tests can advance time deterministically. */
  getNow: () => number;
  /**
   * Heartbeat interval in ms. The staleness window is derived from this, so the
   * interval also sets how long a deploy overlap must last before it warns.
   */
  intervalMs: number;
  /** Emit a warning (defaults to `process.emitWarning`); injected for tests. */
  warn?: (message: string) => void;
};

/**
 * A running detector. `tick()` runs one heartbeat round (exposed for tests and
 * driven by an interval in production); `stop()` clears the interval and
 * best-effort removes this instance's heartbeat so the next boot starts quiet.
 */
export type SecondInstanceDetector = {
  /** Run one heartbeat round: observe peers, then write our own heartbeat. */
  tick(): Promise<void>;
  /** Stop the interval and best-effort delete this instance's heartbeat key. */
  stop(): Promise<void>;
};

/**
 * A foreign heartbeat counts as STALE — and so is swept on boot — once it is
 * older than this multiple of the staleness window. A multiple this large means
 * only the heartbeats of long-dead instances (crashed without a clean stop) are
 * garbage-collected, never a live or recently-handed-off peer.
 */
const STALE_SWEEP_WINDOW_MULTIPLE = 10;

/**
 * A foreign heartbeat must advance across at least this many of our own ticks
 * before we warn. Two ticks of hysteresis is what makes a clean rolling deploy
 * (zero or sub-two-tick overlap) quiet while sustained overlap (autoscaling=2)
 * still warns.
 */
const ADVANCE_TICKS_BEFORE_WARN = 2;

/**
 * Create a best-effort second-instance detector. Does not start an interval
 * itself — the engine owns timer lifecycle so disposal can clear it through the
 * same path as its other intervals. Call {@link SecondInstanceDetector.tick} on
 * an interval and {@link SecondInstanceDetector.stop} on dispose.
 */
export function createSecondInstanceDetector(
  options: SecondInstanceDetectorOptions,
): SecondInstanceDetector {
  const { storage, instanceId, getNow, intervalMs } = options;
  const warn = options.warn ?? ((message: string) => process.emitWarning(message));
  const stalenessWindowMs = intervalMs * (ADVANCE_TICKS_BEFORE_WARN + 1);

  let sequence = 0;
  let swept = false;
  let stopped = false;
  // Per foreign instanceId: the sequence last observed, and how many of our
  // ticks in a row we have seen that sequence advance. Reset to 0 when it stops
  // advancing (so a peer that goes quiet mid-run cannot keep its advance streak).
  const observed = new Map<string, { sequence: number; advances: number }>();
  // Foreign instances we have already warned about; one warning per peer.
  const warnedInstanceIds = new Set<string>();

  // A peer carries the storage key it was scanned under, so sweeps and deletes
  // target the *actual* key — never a key reconstructed from the (untrusted,
  // possibly spoofed) decoded instanceId.
  type ObservedPeer = { key: string; heartbeat: LivenessHeartbeat };

  async function readPeers(): Promise<ObservedPeer[]> {
    const peers: ObservedPeer[] = [];
    for await (const [key, value] of storage.scan(KEYS.livenessPrefix())) {
      const heartbeat = decodeHeartbeat(value);
      // Keep every decodable foreign record (with its scanned key) so the
      // staleness sweep can garbage-collect ancient cruft regardless of whether
      // its stored instanceId matches the key. The anti-spoof identity check
      // lives in evaluatePeers, gating advance/warn only — not the sweep.
      if (heartbeat !== null && heartbeat.instanceId !== instanceId) {
        peers.push({ key, heartbeat });
      }
    }
    return peers;
  }

  async function sweepStaleHeartbeats(peers: ObservedPeer[], now: number): Promise<void> {
    const staleBefore = now - stalenessWindowMs * STALE_SWEEP_WINDOW_MULTIPLE;
    for (const peer of peers) {
      if (peer.heartbeat.heartbeatAt < staleBefore) {
        // Deleting a provably-dead marker is garbage collection, not coordination.
        // Delete the scanned key, never a key rebuilt from the decoded value.
        await storage.delete(peer.key).catch(() => {
          // Best-effort: a delete race or transient error must not break the tick.
        });
      }
    }
  }

  function evaluatePeers(peers: ObservedPeer[]): void {
    const seenThisTick = new Set<string>();
    for (const { key, heartbeat } of peers) {
      // Anti-spoof: only let a record drive advance/warn for the instance whose
      // key it actually occupies. A value parked under liveness:other that claims
      // instanceId "live-peer" must not impersonate live-peer's advance streak.
      if (KEYS.liveness(heartbeat.instanceId) !== key) continue;
      seenThisTick.add(heartbeat.instanceId);
      const previous = observed.get(heartbeat.instanceId);
      // Advance is measured by the peer's MONOTONIC sequence, not its wall-clock
      // timestamp. A peer's sequence cannot increase between two of OUR ticks
      // unless that peer is alive and running in our own time frame — so this
      // needs no cross-host clock comparison and survives a peer whose clock is
      // frozen, skewed, or stepped backward (`heartbeatAt` would not advance, but
      // `sequence` still does). `heartbeatAt` serves only the boot staleness sweep.
      const advanced = previous !== undefined && heartbeat.sequence > previous.sequence;
      const advances = advanced ? previous.advances + 1 : 0;
      observed.set(heartbeat.instanceId, { sequence: heartbeat.sequence, advances });

      if (advances >= ADVANCE_TICKS_BEFORE_WARN && !warnedInstanceIds.has(heartbeat.instanceId)) {
        warnedInstanceIds.add(heartbeat.instanceId);
        warn(
          `WeftSecondInstanceWarning: another engine instance (${heartbeat.instanceId}) is writing to this durable store. ` +
            'Weft supports one engine process per store; running two can cause duplicate workflow execution. ' +
            'Enforce a single instance at the infrastructure layer (for example, one replica with a Recreate deploy strategy).',
        );
      }
    }
    // Forget instances absent this tick so a returning id starts a fresh streak.
    // Snapshot the keys (Array.from) since we delete from the map while iterating.
    for (const knownInstanceId of Array.from(observed.keys())) {
      if (!seenThisTick.has(knownInstanceId)) {
        observed.delete(knownInstanceId);
      }
    }
  }

  // Guards against overlapping ticks: `setInterval` fires regardless of whether
  // the previous async tick finished, and on a slow remote store a tick can
  // outlast the interval. Concurrent ticks would race the shared `sequence`,
  // `observed`, and `swept` state, so a tick that arrives while one is in flight
  // is dropped — a smoke alarm can skip a beat, it must not mutate concurrently.
  let tickInFlight = false;

  async function tick(): Promise<void> {
    if (stopped || tickInFlight) return;
    tickInFlight = true;
    try {
      const now = getNow();
      const peers = await readPeers();

      if (!swept) {
        swept = true;
        await sweepStaleHeartbeats(peers, now);
      }

      evaluatePeers(peers);

      // Re-check after the awaits above: `stop()` may have run (and deleted our
      // key) while this tick was reading peers. Writing now would resurrect a
      // stale, live-looking heartbeat that outlives disposal until the next
      // sweep window. A stopped detector must never write.
      if (stopped) return;
      sequence += 1;
      const heartbeat: LivenessHeartbeat = { instanceId, heartbeatAt: now, sequence };
      await storage.put(KEYS.liveness(instanceId), encodeHeartbeat(heartbeat)).catch(() => {
        // Best-effort: a failed heartbeat write must not break the engine.
      });
    } finally {
      tickInFlight = false;
    }
  }

  async function stop(): Promise<void> {
    stopped = true;
    await storage.delete(KEYS.liveness(instanceId)).catch(() => {
      // Best-effort cleanup so the next boot starts without our stale heartbeat.
    });
  }

  return { tick, stop };
}

/**
 * Build the `setInterval` callback that drives a detector tick. `resolveDetector`
 * returns the live detector, or `null` when the engine has been garbage-collected
 * or disposed — in which case the tick is skipped. Extracted (rather than inlined
 * in the engine) so the skip-when-gone guard is directly testable without a timer.
 * A tick failure is swallowed: the detector is a smoke alarm, never a correctness
 * path, so it must not surface as an unhandled rejection.
 */
export function createSecondInstanceDetectionTick(
  resolveDetector: () => SecondInstanceDetector | null,
): () => void {
  return function secondInstanceDetectionTick() {
    const detector = resolveDetector();
    if (detector === null) return;
    void detector.tick().catch(() => {
      // Swallow — best-effort liveness, not a correctness path.
    });
  };
}
