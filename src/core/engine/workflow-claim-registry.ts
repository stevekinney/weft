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
 * **Scope.** This is the unit alone: acquire, renew, release, takeover, and
 * release-all. It is NOT wired into `Engine`/`EngineInternals` — a later
 * stage folds `acquire` into enabling writes (start, delayed-start fire,
 * recovery), drives `renew` and the reclaim scan from a lifecycle task, and
 * turns a lost `acquire`/`takeover` into `WorkflowClaimUnavailableError` for
 * explicit single-workflow callers. Per the ADR, background scanning never
 * throws that error — it skips the workflow and continues — so every method
 * here returns a discriminated result instead of throwing on a lost CAS,
 * leaving that decision to the caller. Also out of scope for this stage: the
 * per-workflow-id anti-thrash takeover cooldown, `weft_workflow_claim_*`
 * metrics, `wakeOwnershipCheck`, and external terminal-transition rotation
 * (cancel/timeout/suspend/purge — any engine may commit those, and they do
 * not condition on this engine's cached bytes).
 *
 * **Renewal-vs-release serialization.** A per-workflow in-flight-renewal
 * promise (mirroring `lease-manager.ts`'s single `inFlightRenewal`) lets
 * `release()` await any renewal already in progress before it reads the
 * cached bytes it conditions on — otherwise the two would race the same
 * holder bytes and whichever commits second would lose its CAS. A
 * `releasing` set additionally stops a NEW renewal from starting once
 * release has begun for that id, so a `renew()` call that arrives mid-release
 * fails fast as `'not-held'` instead of entering a race it cannot win. A
 * renewal that THROWS (a transient storage error, not a CAS-false result) is
 * not treated as a lost claim: it propagates to its own caller and leaves the
 * cached bytes untouched, and `release()`'s wait swallows that rejection
 * rather than propagating it — a storage hiccup during renewal must not make
 * a terminal/suspend/shutdown release fail.
 *
 * @module core/engine/workflow-claim-registry
 */

import {
  KEYS,
  storageConditionalBatch,
  type BatchOperation,
  type Storage,
} from '../../storage/interface.ts';
import { emitWorkflowClaimLostWarning, type EmitWorkflowLeaseWarning } from './lease-deposition.ts';
import { decodeEpoch, decodeWorkflowClaimHolder } from './workflow-claim-codec.ts';
import {
  buildWorkflowClaimAcquireTransition,
  buildWorkflowClaimReleaseTransition,
  buildWorkflowClaimRenewTransition,
  buildWorkflowClaimTakeoverTransition,
  isWorkflowClaimExpired,
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

/** Result of {@link WorkflowClaimRegistry.takeover}. */
export type WorkflowClaimTakeoverResult =
  | { status: 'acquired'; workflowId: string; epoch: number }
  | { status: 'lost-race'; workflowId: string; heldBy: string | null }
  | { status: 'not-expired'; workflowId: string; heldBy: string | null; expiresAt: number }
  | { status: 'no-claim'; workflowId: string };

/**
 * Pull the exact bytes a just-built transition fragment wrote for `key`,
 * rather than re-encoding a value from the fields the caller happens to
 * know. This is what lets {@link WorkflowClaimRegistry} cache "the bytes it
 * actually wrote" without silently drifting if `workflow-claim-transitions.ts`'s
 * internal object-literal field order ever changed. Exported so the
 * not-found branch — unreachable through the registry itself, since every
 * fragment it extracts from is one it just built — has direct unit coverage.
 */
export function extractPutOperationValue(operations: BatchOperation[], key: string): Uint8Array {
  const operation = operations.find(
    (candidate): candidate is Extract<BatchOperation, { type: 'put' }> =>
      candidate.type === 'put' && candidate.key === key,
  );
  if (operation === undefined) {
    throw new Error(`workflow-claim-registry: expected a "put" operation for key "${key}"`);
  }
  return operation.value;
}

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

  constructor(options: WorkflowClaimRegistryOptions) {
    this.#claimStorage = options.storage;
    this.#engineId = options.engineId;
    this.#getNow = options.getNow;
    this.#claimTtlMs = options.claimTtlMs;
    this.#claimRenewIntervalMs = options.claimRenewIntervalMs;
    this.#warn = options.warn;
  }

  /** The epoch this engine currently believes it holds for `workflowId`, or `null` if untracked. */
  currentEpoch(workflowId: string): number | null {
    return this.#claims.get(workflowId)?.epoch ?? null;
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
    return { status: 'acquired', workflowId, epoch };
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
      // Only forget the claim if the tracked entry is still the one this renewal
      // read. A `takeover` for the same id can land while this CAS is in flight
      // and install a fresh entry that storage now durably backs; deleting
      // unconditionally would drop a claim this engine still owns, so it would
      // stop renewing a live claim and let a successor steal it at expiry.
      if (this.#claims.get(workflowId) === entry) {
        this.#claims.delete(workflowId);
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
      this.#claims.delete(workflowId);
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
    const observedHolderBytes = await this.#claimStorage.get(KEYS.workflowOwnerHolder(workflowId));
    if (observedHolderBytes === null) return { status: 'no-claim', workflowId };
    const observedEpochBytes = await this.#claimStorage.get(KEYS.workflowOwnerEpoch(workflowId));
    if (observedEpochBytes === null) return { status: 'no-claim', workflowId };

    const holder = decodeWorkflowClaimHolder(observedHolderBytes);
    const now = this.#getNow();
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
