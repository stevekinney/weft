/**
 * Lease-fenced single-writer ownership over a shared durable store. This is the
 * opt-in `Engine.create({ ownership: 'lease' })` mechanism — a CORRECTNESS-PATH
 * coordinator, NOT a best-effort smoke alarm like the second-instance detector.
 * Its errors are real: a failed acquire throws and blocks recovery; a failed
 * renewal means this instance has been deposed and must stop writing.
 *
 * **Why a lease.** Weft's supported model is one engine process per durable
 * store. Without a lease, a rolling deploy briefly runs two engines (old draining
 * + new booting), both recovering and both issuing at-least-once activities. The
 * lease turns that into a clean handoff: the booting instance ACQUIRES the lease
 * before recovering, the draining instance RELEASES it on dispose, and the new
 * instance only recovers once it owns the lease.
 *
 * **Two-key schema (this is load-bearing, not an optimization).** Ownership is
 * tracked by two keys, never one:
 *
 * - `lease:epoch` — an 8-byte big-endian uint64 fencing token. It changes ONLY on
 *   ownership transfer (cold acquire, or a steal/re-acquire after the prior
 *   holder's lease lapsed), NEVER on a renewal. It is a monotonic high-water mark
 *   that SURVIVES release.
 * - `lease:holder` — a JSON `{ holderId, expiresAt, epoch }` record renewed on
 *   every heartbeat (its `expiresAt` advances), so its bytes churn constantly.
 *
 * They are split because `conditionalBatch` compares the WHOLE stored value as
 * bytes. If the epoch lived inside the churning holder record, the fencing token
 * (Step 2) would change on every renewal, spuriously failing the fence and
 * self-terminating healthy holders. Keeping the epoch in its own stable key lets
 * a holder cache its epoch once ({@link LeaseManager.currentEpochBytes}) and use
 * it unchanged as a fencing condition across many renewals.
 *
 * **Epoch monotonicity is the anti-split-brain invariant.** Every transfer
 * conditions on BOTH the holder AND the current epoch and bumps the epoch by one;
 * `release()` deletes ONLY the holder and never the epoch. This guarantees a
 * deposed zombie from generation N can never see its epoch re-minted under it —
 * so once Step 2 fences durable writes on the epoch, the zombie always loses.
 *
 * @module core/engine/lease-manager
 */

import { KEYS, storageConditionalBatch, type Storage } from '../../storage/interface.ts';
import { EngineLeaseAcquisitionTimeoutError } from './errors.ts';

/** The decoded {@link KEYS.leaseHolder} record. */
type LeaseHolderRecord = {
  holderId: string;
  /** Wall-clock ms (from the engine's `getNow`) after which the lease may be stolen. */
  expiresAt: number;
  /** The ownership epoch this holder acquired. Mirrors {@link KEYS.leaseEpoch}. */
  epoch: number;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Encode an 8-byte big-endian uint64 epoch. `DataView.setBigUint64` is the
 * standard, overflow-safe encoder — preferred over a hand-rolled byte loop.
 */
function encodeEpoch(epoch: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(epoch), false);
  return bytes;
}

/**
 * Decode an 8-byte big-endian uint64 epoch, or `null` when the stored value is
 * not exactly 8 bytes (a foreign or corrupt value). Epochs always fit in a JS
 * safe integer in practice (one increment per deploy), so the `Number()` cast is
 * safe; a pathologically huge persisted value decodes to a finite number and is
 * still strictly comparable.
 */
function decodeEpoch(raw: Uint8Array): number | null {
  if (raw.byteLength !== 8) return null;
  const value = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getBigUint64(0, false);
  return Number(value);
}

function encodeHolder(record: LeaseHolderRecord): Uint8Array {
  return textEncoder.encode(JSON.stringify(record));
}

/** Decode a stored holder record, tolerating any malformed/foreign value as `null`. */
function decodeHolder(raw: Uint8Array): LeaseHolderRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(raw));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as { holderId: unknown; expiresAt: unknown; epoch: unknown };
  if (
    typeof candidate.holderId !== 'string' ||
    typeof candidate.expiresAt !== 'number' ||
    !Number.isFinite(candidate.expiresAt) ||
    typeof candidate.epoch !== 'number' ||
    !Number.isInteger(candidate.epoch) ||
    candidate.epoch < 1
  ) {
    return null;
  }
  return { holderId: candidate.holderId, expiresAt: candidate.expiresAt, epoch: candidate.epoch };
}

/** Why a holder lost its lease — surfaced to {@link LeaseManagerOptions.onLeaseLost}. */
export type LeaseLostReason = 'deposed' | 'renewal-unconfirmable';

/** Options for {@link createLeaseManager}. */
export type LeaseManagerOptions = {
  storage: Storage;
  /** This engine's unique instance id (the lease holder id). */
  holderId: string;
  /** Wall-clock source (ms), injected so tests can advance time deterministically. */
  getNow: () => number;
  /** Lease time-to-live (ms). A stolen lease becomes available `ttlMs` after its last renewal. */
  ttlMs: number;
  /** Renewal interval (ms). The holder re-asserts the lease this often; must be `< ttlMs`. */
  renewIntervalMs: number;
  /** Boot-time wait window (ms) before {@link LeaseManager.acquire} throws. */
  waitTimeoutMs: number;
  /** Poll interval (ms) for the acquire wait loop. */
  acquirePollIntervalMs?: number;
  /**
   * Delay primitive for the acquire poll loop. Defaults to a real `setTimeout`.
   * Injected so tests drive the loop deterministically: a test `delay` advances
   * the same injected clock by the poll interval and resolves immediately, so the
   * wait deadline (read from `getNow`) trips without real waiting. Mirrors the
   * `getNow` injection — not test-only scaffolding.
   */
  delay?: (ms: number) => Promise<void>;
  /**
   * Called once when this holder loses the lease while running — either CAS-false
   * on renewal (`'deposed'`: a successor stole it) or storage failures that make
   * the holder unable to prove it still holds before the lease lapses
   * (`'renewal-unconfirmable'`). In Step 1 the engine reacts by warning; Step 2
   * uses this to halt fenced writes. The lease manager never throws into the
   * renewal timer — it reports through this seam instead.
   */
  onLeaseLost?: (reason: LeaseLostReason) => void;
};

/**
 * A running lease manager.
 *
 * - `acquire()` blocks until this instance owns the lease (throws
 *   {@link EngineLeaseAcquisitionTimeoutError} on timeout). Call before recovery.
 * - `startRenewal()` begins the heartbeat that keeps the lease held (drives
 *   {@link LeaseManager.renewOnce} on an interval).
 * - `renewOnce()` runs a single renewal round; exposed for tests so renewal can be
 *   driven deterministically with an injected clock, mirroring the detector's
 *   `tick()`.
 * - `currentEpochBytes()` returns the held epoch as bytes for Step-2 fencing
 *   conditions; `null` before a successful acquire. Synchronous and stable across
 *   renewals.
 * - `release()` best-effort relinquishes the lease (holder key only) on dispose.
 */
export type LeaseManager = {
  acquire(): Promise<void>;
  startRenewal(): void;
  renewOnce(): Promise<void>;
  currentEpochBytes(): Uint8Array | null;
  release(): Promise<void>;
  stop(): void;
};

/** Default poll cadence for the acquire wait loop when not overridden. */
const DEFAULT_ACQUIRE_POLL_INTERVAL_MS = 1_000;

/**
 * Create a lease manager. Does not start any timer or acquire anything itself —
 * the engine drives `acquire()` at the boot gate (before recovery) and
 * `startRenewal()` afterward, and clears the renewal timer through its own
 * disposal path (mirroring how it owns the second-instance detector's interval).
 */
export function createLeaseManager(options: LeaseManagerOptions): LeaseManager {
  const { storage, holderId, getNow, ttlMs, renewIntervalMs, waitTimeoutMs } = options;
  const acquirePollIntervalMs = options.acquirePollIntervalMs ?? DEFAULT_ACQUIRE_POLL_INTERVAL_MS;
  // Margin before `expiresAt` past which a holder can no longer prove it holds:
  // one renewal interval, so a single failed renewal still leaves a full interval
  // of slack before the holder must self-terminate.
  const unconfirmableMarginMs = renewIntervalMs;

  let stopped = false;
  let heldEpoch: number | null = null;
  let heldEpochBytes: Uint8Array | null = null;
  // The exact holder bytes this instance last wrote — renewal and release CAS on
  // these, so a churned `expiresAt` always matches the prior write byte-for-byte.
  let lastHolderBytes: Uint8Array | null = null;
  let renewalInterval: ReturnType<typeof setInterval> | null = null;
  let leaseLost = false;

  const delay =
    options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  function reportLeaseLost(reason: LeaseLostReason): void {
    if (leaseLost) return;
    leaseLost = true;
    options.onLeaseLost?.(reason);
  }

  /**
   * Read the current epoch and holder in one pass (each is its own key). Returns
   * BOTH the decoded values (for decisions) AND the exact raw bytes (for the CAS
   * conditions). A compare-and-swap must swap against the bytes it actually
   * observed — never against `encode(decode(raw))`, which only round-trips by
   * luck. A NeonStorage `BYTEA` round-trip or an older engine's holder JSON with a
   * different key order is logically equal but byte-different, so conditioning on
   * reconstructed bytes would spuriously fail the CAS and wedge a healthy lease.
   */
  async function readState(): Promise<{
    epochRaw: Uint8Array | null;
    holderRaw: Uint8Array | null;
    epoch: number | null;
    holder: LeaseHolderRecord | null;
  }> {
    const epochRaw = await storage.get(KEYS.leaseEpoch());
    const holderRaw = await storage.get(KEYS.leaseHolder());
    return {
      epochRaw,
      holderRaw,
      epoch: epochRaw === null ? null : decodeEpoch(epochRaw),
      holder: holderRaw === null ? null : decodeHolder(holderRaw),
    };
  }

  /**
   * Attempt to take ownership for `nextEpoch`, conditioning on BOTH keys against
   * the exact bytes we observed (`expectedEpochBytes`/`expectedHolderBytes`) so
   * the transfer is atomic against that precise state. Conditioning on the epoch
   * even when the holder is absent is REQUIRED: a prior owner can
   * acquire-then-cleanly-release under us (holder returns to absent while the
   * epoch advances), and without the epoch condition we would re-mint a stale,
   * non-monotonic epoch — which a generation-N zombie could later match. Returns
   * true when ownership was taken.
   */
  async function takeOwnership(
    expectedEpochBytes: Uint8Array | null,
    expectedHolderBytes: Uint8Array | null,
    nextEpoch: number,
  ): Promise<boolean> {
    const expiresAt = getNow() + ttlMs;
    const holderRecord: LeaseHolderRecord = { holderId, expiresAt, epoch: nextEpoch };
    const holderBytes = encodeHolder(holderRecord);
    const committed = await storageConditionalBatch(
      storage,
      [
        { key: KEYS.leaseEpoch(), expectedValue: expectedEpochBytes },
        { key: KEYS.leaseHolder(), expectedValue: expectedHolderBytes },
      ],
      [
        { type: 'put', key: KEYS.leaseEpoch(), value: encodeEpoch(nextEpoch) },
        { type: 'put', key: KEYS.leaseHolder(), value: holderBytes },
      ],
    );
    if (committed) {
      heldEpoch = nextEpoch;
      heldEpochBytes = encodeEpoch(nextEpoch);
      lastHolderBytes = holderBytes;
    }
    return committed;
  }

  /** One acquisition attempt against freshly-read state. Returns true on success. */
  async function tryAcquireOnce(): Promise<boolean> {
    const { epochRaw, holderRaw, epoch, holder } = await readState();
    // A holder value that is present but does not decode (`holder === null` while
    // `holderRaw !== null`) is garbage in a Weft-owned key — no valid engine ever
    // writes a malformed holder. It is NOT a live owner, so it can be stolen; we
    // condition the steal on its exact raw bytes so a concurrent VALID writer
    // (whose write would change those bytes) makes our CAS lose and we re-loop.
    const holderLive = holder !== null && getNow() < holder.expiresAt;

    // Holder present and still live: cannot take it; keep waiting.
    if (holderLive) return false;

    // Holder absent (or undecodable): re-acquire. Condition on the EXACT epoch and
    // holder bytes we read — null require-absent when the key is genuinely empty,
    // the raw bytes otherwise. Cold store (both absent) mints epoch 1; a surviving
    // epoch (clean release, or a stolen/garbage holder) advances to baseEpoch+1.
    const decodedEpoch = epoch ?? holder?.epoch ?? 0;
    const nextEpoch = decodedEpoch + 1;
    return takeOwnership(epochRaw, holderRaw, nextEpoch);
  }

  async function acquire(): Promise<void> {
    const deadline = getNow() + waitTimeoutMs;
    let lastHolderId: string | null = null;
    // Bounded wait-for-handoff loop: NOT a retry of a failing operation, so the
    // "cap retries at 5" rule does not apply — it polls until another instance
    // releases (or its lease expires), then throws a typed error on timeout. The
    // iteration count is waitTimeoutMs / acquirePollIntervalMs (e.g. 60 at the
    // defaults); the bound is the timeout, not an attempt count.
    for (;;) {
      if (stopped) return;
      if (await tryAcquireOnce()) return;
      // Record who we're waiting on for the timeout diagnostic.
      const holderRaw = await storage.get(KEYS.leaseHolder());
      lastHolderId = holderRaw === null ? null : (decodeHolder(holderRaw)?.holderId ?? null);
      if (getNow() >= deadline) {
        throw new EngineLeaseAcquisitionTimeoutError(waitTimeoutMs, lastHolderId);
      }
      await delay(acquirePollIntervalMs);
    }
  }

  /**
   * One renewal: re-assert the holder record with an advanced `expiresAt` and the
   * SAME epoch, conditioning on our exact last-written holder bytes. CAS-false
   * means a successor took the lease — we are deposed. The epoch key is never
   * touched on renewal.
   */
  async function renewOnce(): Promise<void> {
    if (stopped || leaseLost || heldEpoch === null || lastHolderBytes === null) return;
    const expiresAt = getNow() + ttlMs;
    const holderRecord: LeaseHolderRecord = { holderId, expiresAt, epoch: heldEpoch };
    const holderBytes = encodeHolder(holderRecord);
    let committed: boolean;
    try {
      committed = await storageConditionalBatch(
        storage,
        [{ key: KEYS.leaseHolder(), expectedValue: lastHolderBytes }],
        [{ type: 'put', key: KEYS.leaseHolder(), value: holderBytes }],
      );
    } catch {
      // Transient storage failure: we could not confirm renewal. If the lease is
      // about to lapse beyond the safety margin we can no longer prove ownership
      // and must self-terminate; otherwise a later tick may still succeed.
      const priorExpiry = decodeHolder(lastHolderBytes)?.expiresAt ?? 0;
      if (getNow() >= priorExpiry - unconfirmableMarginMs) {
        reportLeaseLost('renewal-unconfirmable');
      }
      return;
    }
    if (committed) {
      lastHolderBytes = holderBytes;
      return;
    }
    reportLeaseLost('deposed');
  }

  function startRenewal(): void {
    if (stopped || renewalInterval !== null) return;
    renewalInterval = setInterval(() => {
      void renewOnce();
    }, renewIntervalMs);
    // Don't let the renewal timer keep an otherwise-idle process alive.
    renewalInterval.unref?.();
  }

  function currentEpochBytes(): Uint8Array | null {
    return heldEpochBytes;
  }

  function clearRenewal(): void {
    if (renewalInterval !== null) {
      clearInterval(renewalInterval);
      renewalInterval = null;
    }
  }

  /**
   * Best-effort relinquish on dispose: delete ONLY the holder key, conditioned on
   * our exact bytes. The epoch key is NEVER deleted — it is a monotonic
   * high-water mark that a future boot re-acquires above (deleting it would let a
   * prior-generation zombie's cached epoch match a freshly re-minted `epoch=1`).
   * The CAS guard means a deposed instance (a successor already owns the holder)
   * does not clobber the successor's record. A storage failure is swallowed:
   * release must never reject during disposal.
   */
  async function release(): Promise<void> {
    stopped = true;
    clearRenewal();
    if (lastHolderBytes === null) return;
    try {
      await storageConditionalBatch(
        storage,
        [{ key: KEYS.leaseHolder(), expectedValue: lastHolderBytes }],
        [{ type: 'delete', key: KEYS.leaseHolder() }],
      );
    } catch {
      // Best-effort: a failed release just leaves the lease to expire via TTL.
    }
  }

  function stop(): void {
    stopped = true;
    clearRenewal();
  }

  return { acquire, startRenewal, renewOnce, currentEpochBytes, release, stop };
}
