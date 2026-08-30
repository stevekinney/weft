/**
 * Pure, storage-agnostic builders for the `wf-owner-epoch:<id>` /
 * `wf-owner-holder:<id>` compare-and-swap fragments described in
 * [ADR 0002 § Ownership transitions](../../../documentation/contributing/architecture-decisions/0002-multiengine-per-workflow-ownership.md#ownership-transitions).
 *
 * Every function here returns a `{ conditions, operations }` fragment meant to
 * be passed straight to {@link storageConditionalBatch}, or folded into a
 * larger batch alongside an enabling write (a start, a delayed-start fire, a
 * terminal-state commit). None of them perform IO, read a clock, or import
 * `EngineInternals` — `now` and every previously-read byte value are supplied
 * by the caller, which is what makes every CAS branch here exhaustively
 * unit-testable without a real `Storage` or a live claim manager (a later
 * stage). This mirrors why `lease-codec.ts` was split out of
 * `lease-manager.ts`: the transition math has no engine state of its own.
 *
 * **Why raw bytes, not re-encoded values, for every condition.** A
 * `conditionalBatch` precondition compares the whole stored value as bytes.
 * Re-deriving expected bytes from a decoded value (`encode(decode(raw))`)
 * only round-trips by luck — a storage adapter's byte-level transport (e.g. a
 * `BYTEA` column) or an older writer's differently-ordered JSON keys can be
 * logically equal but byte-different, which would spuriously fail a CAS that
 * should have succeeded. Every builder below therefore takes the exact bytes
 * the caller most recently read or wrote, never a value reconstructed from a
 * decoded record. See `lease-manager.ts`'s `readState`/`takeOwnership` for the
 * same discipline applied to the global lease.
 *
 * @module core/engine/workflow-claim-transitions
 */

import type { BatchOperation, ConditionalBatchCondition } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import {
  decodeEpoch,
  decodeWorkflowClaimHolder,
  encodeEpoch,
  encodeWorkflowClaimHolder,
  type WorkflowClaimHolderRecord,
} from './workflow-claim-codec.ts';

/**
 * `workflowClaimTtl` must be at least this many multiples of
 * `workflowClaimRenewInterval`, enforced at `Engine` construction. Proposed
 * default per ADR 0002; not yet a fixed final value (see the ADR's Open
 * questions), but exported here so callers reference the constant rather than
 * a repeated literal.
 */
export const WORKFLOW_CLAIM_TTL_SAFETY_MULTIPLIER = 3;

/**
 * Grace multiplier applied to `workflowClaimRenewInterval` and added to a
 * holder's `expiresAt` before the `expire` judgment considers it stale. This
 * dampens clock-skew-driven false-expiry judgments. Proposed default per ADR
 * 0002 (see the ADR's Open questions for the not-yet-fixed final value).
 */
export const WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER = 2;

/** A `{ conditions, operations }` fragment for `storageConditionalBatch`. */
export type WorkflowClaimTransitionFragment = {
  conditions: ConditionalBatchCondition[];
  operations: BatchOperation[];
};

/** Mint the next epoch from bytes just read: `(decode(bytes) ?? 0) + 1`, never a literal. */
function nextEpochFromObservedBytes(observedEpochBytes: Uint8Array | null): number {
  const observedEpoch = observedEpochBytes === null ? null : decodeEpoch(observedEpochBytes);
  return (observedEpoch ?? 0) + 1;
}

/** Build the fresh holder record and its epoch/holder write operations for a grant (acquire or takeover). */
function buildClaimGrantOperations(input: {
  workflowId: string;
  engineId: string;
  now: number;
  claimTtlMs: number;
  nextEpoch: number;
}): BatchOperation[] {
  const holder: WorkflowClaimHolderRecord = {
    engineId: input.engineId,
    epoch: input.nextEpoch,
    expiresAt: input.now + input.claimTtlMs,
    claimedAt: input.now,
  };
  return [
    {
      type: 'put',
      key: KEYS.workflowOwnerEpoch(input.workflowId),
      value: encodeEpoch(input.nextEpoch),
    },
    {
      type: 'put',
      key: KEYS.workflowOwnerHolder(input.workflowId),
      value: encodeWorkflowClaimHolder(holder),
    },
  ];
}

/** Input to {@link buildWorkflowClaimAcquireTransition}. */
export type WorkflowClaimAcquireInput = {
  workflowId: string;
  /** This engine's identity, minted once per process. */
  engineId: string;
  now: number;
  claimTtlMs: number;
  /**
   * The exact bytes last read for `wf-owner-epoch:<workflowId>`, or `null`
   * when genuinely never written. `acquire` always reads this key first — it
   * never assumes absence — so a never-seen id observes `null` and mints
   * epoch `1`, while a reused id (e.g. after release, or `start-new` reusing
   * a purged id) observes its true prior epoch and mints one past it. This is
   * the ABA-safety property: the epoch counter is never reset, so a stale
   * zombie's cached epoch from an earlier generation can never coincide with
   * a later one.
   */
  observedEpochBytes: Uint8Array | null;
};

/**
 * `acquire`: holder expected absent, epoch expected the exact bytes just
 * read. Grants a fresh claim at `(observedEpoch ?? 0) + 1`. Meant to be
 * folded into the same atomic batch as the enabling write (a create-batch or
 * a pending-to-running transition), except for the named `acquire (standalone
 * resume)` exception described in the ADR, which commits this fragment alone.
 */
export function buildWorkflowClaimAcquireTransition(
  input: WorkflowClaimAcquireInput,
): WorkflowClaimTransitionFragment {
  const nextEpoch = nextEpochFromObservedBytes(input.observedEpochBytes);
  return {
    conditions: [
      { key: KEYS.workflowOwnerHolder(input.workflowId), expectedValue: null },
      { key: KEYS.workflowOwnerEpoch(input.workflowId), expectedValue: input.observedEpochBytes },
    ],
    operations: buildClaimGrantOperations({
      workflowId: input.workflowId,
      engineId: input.engineId,
      now: input.now,
      claimTtlMs: input.claimTtlMs,
      nextEpoch,
    }),
  };
}

/** Input to {@link buildWorkflowClaimRenewTransition}. */
export type WorkflowClaimRenewInput = {
  workflowId: string;
  now: number;
  claimTtlMs: number;
  /**
   * The exact holder bytes this engine last wrote (from its own prior
   * acquire, takeover, or renew) — the sole CAS condition. The epoch key is
   * not conditioned on separately: any epoch change already changes these
   * bytes, since `epoch` is one of the holder record's fields.
   */
  currentHolderBytes: Uint8Array;
};

/**
 * `renew`: holder expected the exact bytes this engine last wrote. Rewrites
 * the holder with the SAME `engineId`, SAME `epoch`, and SAME `claimedAt`,
 * and a fresh `expiresAt`. `currentHolderBytes` must decode (it is this
 * engine's own prior write); a caller that no longer has a valid cached
 * holder should not attempt renewal.
 */
export function buildWorkflowClaimRenewTransition(
  input: WorkflowClaimRenewInput,
): WorkflowClaimTransitionFragment {
  const currentHolder = decodeWorkflowClaimHolder(input.currentHolderBytes);
  if (currentHolder === null) {
    throw new Error(
      'buildWorkflowClaimRenewTransition: currentHolderBytes did not decode to a valid holder record',
    );
  }
  const renewedHolder: WorkflowClaimHolderRecord = {
    engineId: currentHolder.engineId,
    epoch: currentHolder.epoch,
    expiresAt: input.now + input.claimTtlMs,
    claimedAt: currentHolder.claimedAt,
  };
  return {
    conditions: [
      { key: KEYS.workflowOwnerHolder(input.workflowId), expectedValue: input.currentHolderBytes },
    ],
    operations: [
      {
        type: 'put',
        key: KEYS.workflowOwnerHolder(input.workflowId),
        value: encodeWorkflowClaimHolder(renewedHolder),
      },
    ],
  };
}

/** Input to {@link buildWorkflowClaimReleaseTransition}. */
export type WorkflowClaimReleaseInput = {
  workflowId: string;
  /** This engine's cached epoch bytes — CAS condition on `wf-owner-epoch:<workflowId>`. */
  currentEpochBytes: Uint8Array;
  /** This engine's last-known holder bytes — CAS condition on `wf-owner-holder:<workflowId>`. */
  currentHolderBytes: Uint8Array;
};

/**
 * `release`: epoch expected this engine's cached epoch bytes AND holder
 * expected last-known holder bytes. Deletes ONLY the holder — the epoch key
 * is never deleted, so a successor's next `acquire` reads the true prior
 * epoch and mints one past it rather than re-minting a stale generation.
 */
export function buildWorkflowClaimReleaseTransition(
  input: WorkflowClaimReleaseInput,
): WorkflowClaimTransitionFragment {
  return {
    conditions: [
      { key: KEYS.workflowOwnerEpoch(input.workflowId), expectedValue: input.currentEpochBytes },
      { key: KEYS.workflowOwnerHolder(input.workflowId), expectedValue: input.currentHolderBytes },
    ],
    operations: [{ type: 'delete', key: KEYS.workflowOwnerHolder(input.workflowId) }],
  };
}

/** Input to {@link buildWorkflowClaimTakeoverTransition}. */
export type WorkflowClaimTakeoverInput = {
  workflowId: string;
  engineId: string;
  now: number;
  claimTtlMs: number;
  /** The exact stale holder bytes read during the `expire` judgment — CAS condition. */
  observedHolderBytes: Uint8Array;
  /** The exact epoch bytes read alongside `observedHolderBytes` — CAS condition and the source for the minted epoch, never self-reported by the stale holder. */
  observedEpochBytes: Uint8Array;
};

/**
 * `takeover`: holder expected the exact stale holder bytes read AND epoch
 * expected the exact epoch bytes read alongside it. Grants a fresh claim at
 * `readEpoch + 1`, minted from the epoch bytes just read — never from the
 * stale holder's self-reported `epoch` field, which a corrupt or hostile
 * record could understate.
 */
export function buildWorkflowClaimTakeoverTransition(
  input: WorkflowClaimTakeoverInput,
): WorkflowClaimTransitionFragment {
  const nextEpoch = nextEpochFromObservedBytes(input.observedEpochBytes);
  return {
    conditions: [
      { key: KEYS.workflowOwnerHolder(input.workflowId), expectedValue: input.observedHolderBytes },
      { key: KEYS.workflowOwnerEpoch(input.workflowId), expectedValue: input.observedEpochBytes },
    ],
    operations: buildClaimGrantOperations({
      workflowId: input.workflowId,
      engineId: input.engineId,
      now: input.now,
      claimTtlMs: input.claimTtlMs,
      nextEpoch,
    }),
  };
}

/** Input to {@link buildWorkflowClaimExternalTerminalRotationTransition}. */
export type WorkflowClaimExternalTerminalRotationInput = {
  workflowId: string;
  /**
   * The exact bytes last read for `wf-owner-epoch:<workflowId>`, or `null`
   * when the workflow was never claimed (e.g. cancelling a workflow that
   * never resumed). The rotated epoch is `(observedEpoch ?? 0) + 1`, the same
   * never-a-literal minting rule `acquire` uses.
   */
  observedEpochBytes: Uint8Array | null;
};

/**
 * External terminal rotation: rotates `wf-owner-epoch:<workflowId>` to
 * `readEpoch + 1` and deletes `wf-owner-holder:<workflowId>`, in one fragment
 * meant to be folded into the SAME atomic batch that writes a cancel,
 * timeout, suspend, or purge terminal/suspended state. Any engine may commit
 * this — that is what makes these transitions "intentionally external" per
 * the ADR's entry-point classification. Rotation is what deposes a still-running
 * owner: its next write carries the now-stale epoch and loses its CAS.
 *
 * This must NOT be used for non-terminal external mutations (signal delivery,
 * tag/search-attribute edits) — those do not end the run, so the owner's
 * continued execution is correct and the epoch must not rotate under it.
 */
export function buildWorkflowClaimExternalTerminalRotationTransition(
  input: WorkflowClaimExternalTerminalRotationInput,
): WorkflowClaimTransitionFragment {
  const nextEpoch = nextEpochFromObservedBytes(input.observedEpochBytes);
  return {
    conditions: [
      { key: KEYS.workflowOwnerEpoch(input.workflowId), expectedValue: input.observedEpochBytes },
    ],
    operations: [
      {
        type: 'put',
        key: KEYS.workflowOwnerEpoch(input.workflowId),
        value: encodeEpoch(nextEpoch),
      },
      { type: 'delete', key: KEYS.workflowOwnerHolder(input.workflowId) },
    ],
  };
}

/** Input to {@link isWorkflowClaimExpired}. */
export type WorkflowClaimExpiryInput = {
  /** `expiresAt` from the holder bytes last read. */
  expiresAt: number;
  /** This engine's own clock. */
  now: number;
  /** The configured `workflowClaimRenewInterval`, scaled by {@link WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER}. */
  renewIntervalMs: number;
};

/**
 * `expire`: an observed condition, not a storage transition. A holder is
 * eligible for `takeover` once its `expiresAt` plus a grace term
 * (`WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER * renewIntervalMs`) is strictly
 * earlier than `now` — matching the ADR's "is earlier than this engine's own
 * clock" wording exactly, so a grace-adjusted deadline equal to `now` is NOT
 * yet expired. The grace term dampens clock-skew-driven false-expiry
 * judgments; it carries no write-safety weight on its own — only the
 * subsequent `takeover` CAS does.
 */
export function isWorkflowClaimExpired(input: WorkflowClaimExpiryInput): boolean {
  const graceAdjustedDeadline =
    input.expiresAt + WORKFLOW_CLAIM_TAKEOVER_GRACE_MULTIPLIER * input.renewIntervalMs;
  return graceAdjustedDeadline < input.now;
}

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
