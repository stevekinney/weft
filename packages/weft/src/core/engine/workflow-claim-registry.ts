/**
 * The stateful per-workflow claim registry — the object that actually
 * performs durable IO for the `wf-owner-epoch:<id>` / `wf-owner-holder:<id>`
 * claim transitions specified in
 * [ADR 0002 § Ownership transitions](../../../documentation/contributing/architecture-decisions/0002-multiengine-per-workflow-ownership.md#ownership-transitions).
 *
 * `workflow-claim-transitions.ts` supplies pure `{ conditions, operations }`
 * fragments; this module is the thin, stateful layer around them that reads
 * storage, executes `storageConditionalBatch`, and tracks — for every claim
 * THIS engine currently holds — the exact epoch and holder bytes it last
 * wrote. Renewal and release condition on those exact bytes, extracted from
 * the fragment they were just written by rather than re-encoded from the
 * fields the registry happens to know, mirroring `lease-manager.ts`'s
 * "never round-trip encode(decode(raw))" discipline.
 *
 * **Scope.** The unit itself: acquire, renew, release, takeover, and
 * release-all — plus, additively, {@link WorkflowClaimRegistry.prepareAcquireFragment}
 * and {@link WorkflowClaimRegistry.recordFoldedAcquire}, the two-step seam a
 * caller uses to fold `acquire` into ITS OWN atomic enabling write (a create
 * batch, a delayed-start pending→running transition, a failed-workflow
 * reactivation) instead of committing the fragment through this registry's
 * own `acquire()`. Driving `renew` and the reclaim scan from a lifecycle
 * task, and turning a lost `acquire`/`takeover` into
 * `WorkflowClaimUnavailableError` for explicit single-workflow callers, are
 * still each call site's own responsibility — this registry never throws
 * that error itself. Per the ADR, background scanning never throws it either
 * — it skips the workflow and continues — so every method here returns a
 * discriminated result instead of throwing on a lost CAS, leaving that
 * decision to the caller — `takeover` also gates on a per-workflow-id
 * anti-thrash cooldown ({@link WorkflowClaimTakeoverCooldown}). Still out of
 * scope: `weft_workflow_claim_*` metrics, `wakeOwnershipCheck`, and external
 * terminal-transition rotation (any engine may commit those unconditioned).
 *
 * **Renewal-vs-release serialization.** A per-workflow in-flight-renewal
 * promise (mirroring `lease-manager.ts`'s single `inFlightRenewal`) lets
 * `release()` await a renewal already in progress before reading the cached
 * bytes it conditions on; otherwise both race the same holder bytes and
 * whichever commits second loses its CAS. A `releasing` set stops a NEW
 * renewal from starting once release has begun, so a `renew()` arriving
 * mid-release fails fast as `'not-held'`. A renewal that THROWS (a transient
 * storage error, not a CAS-false result) is not a lost claim: it propagates
 * to its caller leaving cached bytes untouched, and `release()`'s wait
 * swallows it — a storage hiccup must not fail a terminal or shutdown release.
 *
 * @module core/engine/workflow-claim-registry
 */

import { KEYS, storageConditionalBatch, type Storage } from '../../storage/interface.ts';
import { emitWorkflowClaimLostWarning, type EmitWorkflowLeaseWarning } from './lease-deposition.ts';
import { decodeEpoch, decodeWorkflowClaimHolder } from './workflow-claim-codec.ts';
import { WorkflowClaimTakeoverCooldown } from './workflow-claim-cooldown.ts';
import {
  buildWorkflowClaimAcquireTransition,
  buildWorkflowClaimReleaseTransition,
  buildWorkflowClaimRenewTransition,
  buildWorkflowClaimTakeoverTransition,
  extractPutOperationValue,
  isWorkflowClaimExpired,
  type WorkflowClaimTransitionFragment,
} from './workflow-claim-transitions.ts';

/** Options for {@link WorkflowClaimRegistry}. */
export type WorkflowClaimRegistryOptions = {
  storage: Storage;
  /** This engine's identity, minted once per process — the holder record's `engineId`. */
  engineId: string;
  /** Wall-clock source (ms), injected so tests can drive time deterministically. */
  getNow: () => number;
  /** `workflowClaimTtl` (ms), resolved by `ownership-options.ts`. */
  claimTtlMs: number;
  /**
   * `workflowClaimRenewInterval` (ms), resolved by `ownership-options.ts` —
   * feeds `isWorkflowClaimExpired`'s grace term.
   */
  claimRenewIntervalMs: number;
  /** Operator-warning seam; defaults to `process.emitWarning` via {@link emitWorkflowClaimLostWarning}. */
  warn?: EmitWorkflowLeaseWarning;
};

/** What this engine tracks locally for one workflow it currently holds a claim for. */
type ClaimTrackingEntry = {
  epoch: number;
  claimedAt: number;
  /** The exact bytes last written to `wf-owner-epoch:<id>` — the fencing token. */
  epochBytes: Uint8Array;
  /** The exact bytes last written to `wf-owner-holder:<id>` — renew/release CAS on these. */
  holderBytes: Uint8Array;
};

/** Result of {@link WorkflowClaimRegistry.acquire}. */
export type WorkflowClaimAcquireResult =
  | { status: 'acquired'; workflowId: string; epoch: number }
  | { status: 'lost-race'; workflowId: string; heldBy: string | null };

/** Result of {@link WorkflowClaimRegistry.renew}. */
export type WorkflowClaimRenewResult =
  | { status: 'renewed'; workflowId: string }
  | { status: 'lost'; workflowId: string }
  | { status: 'not-held'; workflowId: string };

/** Result of {@link WorkflowClaimRegistry.release}. */
export type WorkflowClaimReleaseResult =
  | { status: 'released'; workflowId: string }
  | { status: 'lost-race'; workflowId: string }
  | { status: 'not-held'; workflowId: string };

/**
 * A prepared, not-yet-committed `acquire` — the output of
 * {@link WorkflowClaimRegistry.prepareAcquireFragment}, meant to be merged
 * into a caller's own atomic enabling write and then handed back to
 * {@link WorkflowClaimRegistry.recordFoldedAcquire} once that write commits.
 */
export type WorkflowClaimAcquirePreparation = {
  fragment: WorkflowClaimTransitionFragment;
  epoch: number;
  claimedAt: number;
};

/** Result of {@link WorkflowClaimRegistry.takeover}. */
export type WorkflowClaimTakeoverResult =
  | { status: 'acquired'; workflowId: string; epoch: number }
  | { status: 'lost-race'; workflowId: string; heldBy: string | null }
  | { status: 'not-expired'; workflowId: string; heldBy: string | null; expiresAt: number }
  | { status: 'no-claim'; workflowId: string }
  | { status: 'backoff-skipped'; workflowId: string };

/** `(decode(bytes) ?? 0) + 1` — mirrors `workflow-claim-transitions.ts`'s private minting rule; never a literal. */
function mintNextEpoch(observedEpochBytes: Uint8Array | null): number {
  const observed = observedEpochBytes === null ? null : decodeEpoch(observedEpochBytes);
  return (observed ?? 0) + 1;
}

/**
 * Owns this engine's per-workflow ownership claims: reads storage, executes
 * the pure transition fragments, and tracks the exact bytes it last wrote for
 * every claim it currently holds. See the module doc for scope.
 */
export class WorkflowClaimRegistry {
  readonly #claimStorage: Storage;
  readonly #engineId: string;
  readonly #getNow: () => number;
  readonly #claimTtlMs: number;
  readonly #claimRenewIntervalMs: number;
  readonly #warn: EmitWorkflowLeaseWarning | undefined;

  readonly #claims = new Map<string, ClaimTrackingEntry>();
  readonly #inFlightRenewals = new Map<string, Promise<WorkflowClaimRenewResult>>();
  readonly #releasing = new Set<string>();
  readonly #takeoverCooldown: WorkflowClaimTakeoverCooldown;

  constructor(options: WorkflowClaimRegistryOptions) {
    this.#claimStorage = options.storage;
    this.#engineId = options.engineId;
    this.#getNow = options.getNow;
    this.#claimTtlMs = options.claimTtlMs;
    this.#claimRenewIntervalMs = options.claimRenewIntervalMs;
    this.#warn = options.warn;
    this.#takeoverCooldown = new WorkflowClaimTakeoverCooldown(options);
  }

  /** The epoch this engine currently believes it holds for `workflowId`, or `null` if untracked. */
  currentEpoch(workflowId: string): number | null {
    return this.#claims.get(workflowId)?.epoch ?? null;
  }

  /** This engine's identity; with {@link currentEpoch} it forms the generation a wake check compares. */
  get engineId(): string {
    return this.#engineId;
  }

  /**
   * Every workflow id this engine currently tracks a live claim for — active
   * or parked. A defensive-copy snapshot, mirroring `releaseAll`'s own
   * `[...this.#claims.keys()]` read: callers (the claim-renewal task, an
   * active-claims metrics gauge) must not observe mutations to this registry's
   * internal map while iterating a snapshot they already took.
   */
  listHeldWorkflowIds(): readonly string[] {
    return [...this.#claims.keys()];
  }

  /**
   * Defensive copy of the epoch bytes this engine last wrote for
   * `workflowId`, for fencing durable writes — `null` if untracked. A copy so
   * a caller mutating the returned buffer cannot corrupt this registry's
   * cached fencing token.
   */
  currentEpochBytes(workflowId: string): Uint8Array | null {
    const entry = this.#claims.get(workflowId);
    return entry === undefined ? null : entry.epochBytes.slice();
  }

  async #resolveHeldBy(workflowId: string): Promise<string | null> {
    const raw = await this.#claimStorage.get(KEYS.workflowOwnerHolder(workflowId));
    if (raw === null) return null;
    return decodeWorkflowClaimHolder(raw)?.engineId ?? null;
  }

  /**
   * `acquire`: always reads both keys fresh — never assumes absence — then
   * builds and attempts the fragment from what it read. On a lost CAS,
   * resolves `heldBy` from the holder bytes already read when they were
   * non-null; otherwise (a competitor raced in between the read and the
   * write) re-reads to report the true current holder.
   */
  async acquire(workflowId: string): Promise<WorkflowClaimAcquireResult> {
    const observedHolderBytes = await this.#claimStorage.get(KEYS.workflowOwnerHolder(workflowId));
    const observedEpochBytes = await this.#claimStorage.get(KEYS.workflowOwnerEpoch(workflowId));
    const now = this.#getNow();
    const fragment = buildWorkflowClaimAcquireTransition({
      workflowId,
      engineId: this.#engineId,
      now,
      claimTtlMs: this.#claimTtlMs,
      observedEpochBytes,
    });
    const committed = await storageConditionalBatch(
      this.#claimStorage,
      fragment.conditions,
      fragment.operations,
    );
    if (!committed) {
      const heldBy =
        observedHolderBytes !== null
          ? (decodeWorkflowClaimHolder(observedHolderBytes)?.engineId ?? null)
          : await this.#resolveHeldBy(workflowId);
      return { status: 'lost-race', workflowId, heldBy };
    }
    const epoch = mintNextEpoch(observedEpochBytes);
    const epochBytes = extractPutOperationValue(
      fragment.operations,
      KEYS.workflowOwnerEpoch(workflowId),
    );
    const holderBytes = extractPutOperationValue(
      fragment.operations,
      KEYS.workflowOwnerHolder(workflowId),
    );
    this.#claims.set(workflowId, { epoch, claimedAt: now, epochBytes, holderBytes });
    this.#takeoverCooldown.clear(workflowId);
    return { status: 'acquired', workflowId, epoch };
  }

  /**
   * Read fresh `wf-owner-epoch:<workflowId>` bytes and build the pure
   * `acquire` fragment WITHOUT committing it or updating this registry's
   * tracking — for a caller that folds the fragment into ITS OWN atomic
   * enabling write instead of letting {@link acquire} commit it alone. The
   * caller merges `fragment.conditions`/`fragment.operations` into its own
   * operation list, commits ONE atomic `storageConditionalBatch`, and —
   * ONLY on success — calls {@link recordFoldedAcquire} with this SAME
   * preparation. Safe to call again on every retry attempt: this always
   * re-reads fresh bytes, so a stale epoch from an earlier attempt never
   * dooms a later one.
   */
  async prepareAcquireFragment(workflowId: string): Promise<WorkflowClaimAcquirePreparation> {
    const observedEpochBytes = await this.#claimStorage.get(KEYS.workflowOwnerEpoch(workflowId));
    const now = this.#getNow();
    const fragment = buildWorkflowClaimAcquireTransition({
      workflowId,
      engineId: this.#engineId,
      now,
      claimTtlMs: this.#claimTtlMs,
      observedEpochBytes,
    });
    return { fragment, epoch: mintNextEpoch(observedEpochBytes), claimedAt: now };
  }

  /**
   * Install the tracking entry for a claim acquired via a FOLDED enabling
   * write (see {@link prepareAcquireFragment}) — call ONLY after the
   * caller's own atomic commit that included `preparation.fragment`'s
   * conditions and operations has actually succeeded. Extracts the exact
   * bytes the fragment wrote using the same "never round-trip
   * encode(decode(raw))" discipline every other grant path in this class
   * uses.
   */
  recordFoldedAcquire(workflowId: string, preparation: WorkflowClaimAcquirePreparation): void {
    const epochBytes = extractPutOperationValue(
      preparation.fragment.operations,
      KEYS.workflowOwnerEpoch(workflowId),
    );
    const holderBytes = extractPutOperationValue(
      preparation.fragment.operations,
      KEYS.workflowOwnerHolder(workflowId),
    );
    this.#claims.set(workflowId, {
      epoch: preparation.epoch,
      claimedAt: preparation.claimedAt,
      epochBytes,
      holderBytes,
    });
    this.#takeoverCooldown.clear(workflowId);
  }

  /**
   * `renew`: conditions on the exact holder bytes this engine last wrote.
   * Concurrent calls for the same id share the one in-flight promise. A
   * CAS-false result marks the claim lost locally and emits
   * `WeftWorkflowClaimLostWarning` — losing one workflow's claim never
   * touches any other tracked claim.
   */
  async renew(workflowId: string): Promise<WorkflowClaimRenewResult> {
    const existing = this.#inFlightRenewals.get(workflowId);
    if (existing !== undefined) return existing;
    const promise = this.#performRenew(workflowId).finally(() => {
      this.#inFlightRenewals.delete(workflowId);
    });
    this.#inFlightRenewals.set(workflowId, promise);
    return promise;
  }

  async #performRenew(workflowId: string): Promise<WorkflowClaimRenewResult> {
    if (this.#releasing.has(workflowId)) return { status: 'not-held', workflowId };
    const entry = this.#claims.get(workflowId);
    if (entry === undefined) return { status: 'not-held', workflowId };
    const fragment = buildWorkflowClaimRenewTransition({
      workflowId,
      now: this.#getNow(),
      claimTtlMs: this.#claimTtlMs,
      currentHolderBytes: entry.holderBytes,
    });
    // A thrown storage error propagates from here uncaught: it is a transient
    // failure, not a lost CAS, so it must not mark the claim lost or emit the
    // deposition warning. See the module doc's renewal-vs-release note.
    const committed = await storageConditionalBatch(
      this.#claimStorage,
      fragment.conditions,
      fragment.operations,
    );
    if (!committed) {
      // Only forget the claim — and start the anti-thrash cooldown — if the
      // tracked entry is still the one this renewal read. A concurrent
      // `takeover` can land mid-CAS and install a fresh entry; acting
      // unconditionally would drop or throttle a claim this engine still
      // owns under that newer generation, not one it actually lost.
      if (this.#claims.get(workflowId) === entry) {
        this.#claims.delete(workflowId);
        this.#takeoverCooldown.recordDeposition(workflowId, this.#getNow());
      }
      emitWorkflowClaimLostWarning(workflowId, this.#warn);
      return { status: 'lost', workflowId };
    }
    const holderBytes = extractPutOperationValue(
      fragment.operations,
      KEYS.workflowOwnerHolder(workflowId),
    );
    // Same identity guard on the success path: a concurrent takeover that
    // replaced the entry must not be overwritten by bytes derived from the
    // superseded one.
    if (this.#claims.get(workflowId) === entry) {
      this.#claims.set(workflowId, { ...entry, holderBytes });
    }
    return { status: 'renewed', workflowId };
  }

  /**
   * `release`: stops new renewals for `workflowId` and awaits any renewal
   * already in flight (swallowing a thrown rejection — best-effort, never
   * reject on a renewal's storage error) before building the expected bytes,
   * so the two can never race the same holder bytes. Deletes only the holder
   * key — the epoch key is never touched, so a successor's next `acquire`
   * reads the true prior epoch. A lost CAS means this engine was already
   * fenced out; the local entry is dropped either way, since there is
   * nothing left to protect.
   */
  async release(workflowId: string): Promise<WorkflowClaimReleaseResult> {
    this.#releasing.add(workflowId);
    try {
      const inFlight = this.#inFlightRenewals.get(workflowId);
      if (inFlight !== undefined) {
        await inFlight.catch(() => undefined);
      }
      const entry = this.#claims.get(workflowId);
      if (entry === undefined) return { status: 'not-held', workflowId };
      const fragment = buildWorkflowClaimReleaseTransition({
        workflowId,
        currentEpochBytes: entry.epochBytes,
        currentHolderBytes: entry.holderBytes,
      });
      const committed = await storageConditionalBatch(
        this.#claimStorage,
        fragment.conditions,
        fragment.operations,
      );
      // Identity-guarded, matching `#performRenew`'s success/failure guards: a
      // concurrent `takeover`/`acquire` can install a fresh entry for this
      // workflow id while the conditional batch above is in flight (e.g. a
      // replacement `start-new` run). Deleting unconditionally would drop that
      // REPLACEMENT's tracked entry, not the generation this call actually
      // captured and released.
      if (this.#claims.get(workflowId) === entry) {
        this.#claims.delete(workflowId);
      }
      return { status: committed ? 'released' : 'lost-race', workflowId };
    } finally {
      this.#releasing.delete(workflowId);
    }
  }

  /**
   * `takeover`: reads the holder and epoch keys fresh, and only attempts the
   * CAS once the holder is not live — either its grace-adjusted `expiresAt`
   * has passed ({@link isWorkflowClaimExpired}), or the holder bytes are
   * foreign/undecodable garbage no valid engine could have written (mirrors
   * `lease-manager.ts`'s "garbage is not a live owner" treatment: not live,
   * so it can be stolen via CAS on its exact observed bytes). A holder
   * present with no epoch key violates the write invariant — the two are
   * always written together, and the epoch key is never deleted — so it is
   * treated defensively as nothing safe to fence a takeover against.
   */
  async takeover(workflowId: string): Promise<WorkflowClaimTakeoverResult> {
    const now = this.#getNow();
    if (this.#takeoverCooldown.isActive(workflowId, now))
      return { status: 'backoff-skipped', workflowId };
    const observedHolderBytes = await this.#claimStorage.get(KEYS.workflowOwnerHolder(workflowId));
    if (observedHolderBytes === null) return { status: 'no-claim', workflowId };
    const observedEpochBytes = await this.#claimStorage.get(KEYS.workflowOwnerEpoch(workflowId));
    if (observedEpochBytes === null) return { status: 'no-claim', workflowId };

    const holder = decodeWorkflowClaimHolder(observedHolderBytes);
    if (
      holder !== null &&
      !isWorkflowClaimExpired({
        expiresAt: holder.expiresAt,
        now,
        renewIntervalMs: this.#claimRenewIntervalMs,
      })
    ) {
      return {
        status: 'not-expired',
        workflowId,
        heldBy: holder.engineId,
        expiresAt: holder.expiresAt,
      };
    }

    const fragment = buildWorkflowClaimTakeoverTransition({
      workflowId,
      engineId: this.#engineId,
      now,
      claimTtlMs: this.#claimTtlMs,
      observedHolderBytes,
      observedEpochBytes,
    });
    const committed = await storageConditionalBatch(
      this.#claimStorage,
      fragment.conditions,
      fragment.operations,
    );
    if (!committed) {
      const heldBy = await this.#resolveHeldBy(workflowId);
      return { status: 'lost-race', workflowId, heldBy };
    }
    const epoch = mintNextEpoch(observedEpochBytes);
    const epochBytes = extractPutOperationValue(
      fragment.operations,
      KEYS.workflowOwnerEpoch(workflowId),
    );
    const holderBytes = extractPutOperationValue(
      fragment.operations,
      KEYS.workflowOwnerHolder(workflowId),
    );
    this.#claims.set(workflowId, { epoch, claimedAt: now, epochBytes, holderBytes });
    this.#takeoverCooldown.clear(workflowId);
    return { status: 'acquired', workflowId, epoch };
  }

  /**
   * Best-effort release of every claim this engine currently tracks, for
   * graceful shutdown. A failed release (thrown or lost-race) is swallowed
   * per workflow so shutdown proceeds — the reclaim scan (a later stage)
   * collects any stranded claim once its grace-adjusted expiry passes.
   */
  async releaseAll(): Promise<void> {
    const workflowIds = [...this.#claims.keys()];
    await Promise.all(
      workflowIds.map(async (workflowId) => {
        try {
          await this.release(workflowId);
        } catch {
          // Best-effort: swallow so shutdown proceeds.
        }
      }),
    );
  }
}
