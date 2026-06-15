/**
 * Lease-fenced single-writer ownership over a shared durable store. This is the
 * opt-in `Engine.create({ ownership: 'lease' })` mechanism — a CORRECTNESS-PATH
 * coordinator, NOT a best-effort smoke alarm like the second-instance detector.
 * Lease outcomes are acted on, never silently dropped, but the channel differs by
 * phase: a failed acquire THROWS and blocks recovery (corruption fails closed, a
 * timed-out handoff raises a typed error); a renewal reports loss through
 * `onLeaseLost` rather than throwing — a CAS-failed renewal means a successor took
 * the lease ('deposed'), and a transient renewal storage error is tolerated until
 * the lease is too close to lapsing to prove ownership ('renewal-unconfirmable').
 * In Step 1 that loss is observability only (the engine warns); Step 2 will make it
 * enforceable by fencing every durable write on the lease epoch.
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
import { EngineLeaseAcquisitionTimeoutError, EngineLeaseCorruptedError } from './errors.ts';
import {
  decodeEpoch,
  decodeHolder,
  encodeEpoch,
  encodeHolder,
  type LeaseHolderRecord,
} from './lease-codec.ts';

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
 * - `acquire()` blocks until this instance owns the lease, then resolves; throws
 *   {@link EngineLeaseAcquisitionTimeoutError} on timeout. Call before recovery.
 *   One exception to "resolved ⇒ owned": if the manager was `stop()`ped (disposal)
 *   while acquire was waiting, it resolves WITHOUT owning — the engine gates
 *   recovery on `disposed` so a stopped-then-resolved acquire never proceeds.
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
  // The single in-flight renewal, or null when none is running. Serializes
  // renewals (an overlapping tick would CAS against stale `lastHolderBytes` and
  // spuriously report 'deposed') and lets `release()` await a renewal that began
  // just before disposal, so its CAS-delete conditions on the freshest holder
  // bytes rather than a value the in-flight renewal is about to overwrite.
  let inFlightRenewal: Promise<void> | null = null;

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
    // Read the HOLDER first, then the epoch (the two keys are not read atomically).
    // A concurrent cold acquire commits both keys together, so reading holder-first
    // makes the only torn view "holder old/absent, epoch present" — the ordinary
    // steal path. Epoch-first could instead show "epoch absent, holder present",
    // which tryAcquireOnce treats as corruption (a false fail-close under normal
    // contention); holder-first cannot manufacture that from a benign race.
    const holderRaw = await storage.get(KEYS.leaseHolder());
    const epochRaw = await storage.get(KEYS.leaseEpoch());
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

  /**
   * One acquisition attempt against freshly-read state. Returns true on success,
   * false when the lease is still live (keep waiting), and THROWS
   * {@link EngineLeaseCorruptedError} on corrupt lease state.
   *
   * `lease:epoch` is the SOLE source of truth for the monotonic high-water mark —
   * the next epoch is ALWAYS `epoch + 1`, never derived from the holder's
   * self-reported `epoch` (which a stale or hostile record could understate,
   * letting us re-mint at or below the true watermark). So:
   * - epoch present but undecodable → corruption (fail closed; waiting can't heal it).
   * - epoch absent but holder present → corruption: the protocol never deletes the
   *   epoch (release deletes only the holder), so this state is impossible unless
   *   the epoch key was externally removed/damaged.
   * - epoch absent and holder absent → cold store, mint epoch 1.
   * - epoch present and decodable → re-acquire/steal at epoch+1 once not live.
   */
  async function tryAcquireOnce(): Promise<boolean> {
    const { epochRaw, holderRaw, epoch, holder } = await readState();

    if (epochRaw !== null && epoch === null) {
      throw new EngineLeaseCorruptedError(
        'the "lease:epoch" high-water mark is present but does not decode to a valid epoch',
      );
    }
    if (epochRaw === null && holderRaw !== null) {
      throw new EngineLeaseCorruptedError(
        'a "lease:holder" record exists with no "lease:epoch" key (the lease protocol never deletes the epoch)',
      );
    }

    // A holder present but undecodable (`holder === null` while `holderRaw !== null`)
    // is garbage in a Weft-owned key — no valid engine writes a malformed holder. It
    // is NOT a live owner, so it can be stolen; the steal conditions on its exact raw
    // bytes so a concurrent VALID writer (whose write changes those bytes) makes our
    // CAS lose and we re-loop. The epoch key, validated above, is intact.
    const holderLive = holder !== null && getNow() < holder.expiresAt;
    if (holderLive) return false;

    // Cold store (epoch + holder both absent) mints epoch 1; otherwise the surviving
    // epoch advances to epoch+1. Condition on the EXACT bytes observed (null =
    // require-absent when genuinely empty, the raw bytes otherwise).
    const nextEpoch = (epoch ?? 0) + 1;
    // Fail closed before writing an epoch `decodeEpoch` would later reject. It rejects
    // `>= Number.MAX_SAFE_INTEGER` (no room to increment), so minting at that ceiling
    // would brick the next boot — operator repair, not an unrecoverable write. The
    // symmetric guard to the decode-side ceiling; 2^53 transfers away, never reached
    // in practice.
    if (nextEpoch >= Number.MAX_SAFE_INTEGER) {
      throw new EngineLeaseCorruptedError(
        `the next ownership epoch (${nextEpoch}) is at or above the safe-integer ceiling and cannot be minted without bricking future boots`,
      );
    }
    return takeOwnership(epochRaw, holderRaw, nextEpoch);
  }

  async function acquire(): Promise<void> {
    const startedAt = getNow();
    const deadline = startedAt + waitTimeoutMs;
    let lastHolderId: string | null = null;
    let firstAttempt = true;
    // Bounded wait-for-handoff loop: NOT a retry of a failing operation, so the
    // "cap retries at 5" rule does not apply — it polls until another instance
    // releases (or its lease expires), then throws a typed error on timeout. The
    // iteration count is waitTimeoutMs / acquirePollIntervalMs (e.g. 60 at the
    // defaults); the bound is the timeout, not an attempt count. A corrupt lease
    // throws out of tryAcquireOnce immediately — waiting cannot heal corruption.
    for (;;) {
      if (stopped) return;
      // Check the deadline at the TOP of every iteration after the first: if a
      // prior sleep overshot the window, do not poll-and-acquire after it elapsed.
      // (The first iteration always tries once, even with a zero wait window.)
      if (!firstAttempt && getNow() >= deadline) {
        throw new EngineLeaseAcquisitionTimeoutError(getNow() - startedAt, lastHolderId);
      }
      firstAttempt = false;
      if (await tryAcquireOnce()) return;
      // Record who we're waiting on for the timeout diagnostic.
      const holderRaw = await storage.get(KEYS.leaseHolder());
      lastHolderId = holderRaw === null ? null : (decodeHolder(holderRaw)?.holderId ?? null);
      // Also short-circuit before sleeping so we don't wait out a full poll
      // interval past an already-elapsed deadline.
      if (getNow() >= deadline) {
        throw new EngineLeaseAcquisitionTimeoutError(getNow() - startedAt, lastHolderId);
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

  /**
   * Run one renewal under the single-flight guard: if a prior renewal is still
   * in flight (slow storage, or an aggressively short interval), skip this tick
   * rather than letting two renewals race the same `lastHolderBytes` CAS — an
   * overlapping renewal would condition on bytes the in-flight one is about to
   * supersede and spuriously report `'deposed'`. The promise is tracked so
   * `release()` can await it.
   */
  function renewUnderGuard(): void {
    if (inFlightRenewal !== null) return;
    // Swallow a renewal rejection so the fire-and-forget interval can never leak an
    // unhandled rejection, and the stored `inFlightRenewal` (awaited by release) is
    // itself non-rejecting. renewOnce catches its own storage errors today; this
    // contains any future pre-try throw (e.g. the clock).
    inFlightRenewal = renewOnce()
      .catch(() => {})
      .finally(() => {
        inFlightRenewal = null;
      });
  }

  function startRenewal(): void {
    if (stopped || renewalInterval !== null) return;
    renewalInterval = setInterval(() => {
      renewUnderGuard();
    }, renewIntervalMs);
    // Don't let the renewal timer keep an otherwise-idle process alive.
    renewalInterval.unref?.();
  }

  function currentEpochBytes(): Uint8Array | null {
    // Return a defensive copy: the held epoch bytes are the Step-2 fencing token,
    // and a caller mutating the shared buffer would corrupt every future fence
    // condition. Cheap (8 bytes) relative to the integrity it protects.
    return heldEpochBytes === null ? null : heldEpochBytes.slice();
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
   *
   * `stopped`/`clearRenewal()` prevent any NEW renewal from starting, but a
   * renewal that began just before this call may still be mid-flight; we await it
   * first so the CAS-delete conditions on the holder bytes that renewal actually
   * left in storage, not a value it is about to overwrite (which would CAS-false
   * and strand the holder until TTL expiry, breaking the clean handoff). We keep
   * the CAS conditioned on `lastHolderBytes` — NOT a re-read-and-delete-whatever —
   * so a genuine successor's holder is never deleted out from under it.
   */
  async function release(): Promise<void> {
    stopped = true;
    clearRenewal();
    // Await any in-flight renewal so the CAS-delete conditions on the freshest holder
    // bytes. Safe for release's best-effort, never-reject contract: renewUnderGuard
    // already swallows renewal rejections, so `inFlightRenewal` never rejects.
    if (inFlightRenewal !== null) await inFlightRenewal;
    if (lastHolderBytes === null) return;
    try {
      const deleted = await storageConditionalBatch(
        storage,
        [{ key: KEYS.leaseHolder(), expectedValue: lastHolderBytes }],
        [{ type: 'delete', key: KEYS.leaseHolder() }],
      );
      // Null our cached bytes after a confirmed delete so a second release() is a
      // clean no-op instead of re-issuing a now-doomed CAS. (If the delete missed
      // because a successor took over, keep the bytes — we did not own the holder.)
      if (deleted) lastHolderBytes = null;
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
