/**
 * Step-2 epoch fencing for `ownership: 'lease'` (issue #470).
 *
 * Step 1 made a rolling deploy a clean lease handoff but added no correctness
 * backstop: a deposed zombie instance (GC pause, partition) that emerged after
 * its lease expired could still issue a plain durable write and corrupt the
 * successor's state. Step 2 closes that hole by conditioning every
 * engine-generator-owned per-workflow durable write on the held lease epoch, so
 * a deposed instance's write loses its CAS instead of landing.
 *
 * The correctness guarantee lives entirely in the epoch CONDITION: a deposed
 * instance's commit CAS-fails regardless of any in-process flag, because the
 * successor bumped `lease:epoch` when it took over. The {@link EngineInternals.deposed}
 * flag and the engine teardown are hygiene on top of that — they stop the engine
 * from silently spinning on swallowed write losses, surface the deposition to the
 * operator, and release resources. They are not what makes the system safe.
 *
 * This module is allow-listed for import only from `src/core/engine/**`.
 */

import type { BatchOperation, ConditionalBatchCondition } from '../../storage/interface.ts';
import { KEYS, storageConditionalBatch } from '../../storage/interface.ts';
import type { EngineInternals } from './internals.ts';
import { decodeEpoch } from './lease-codec.ts';
import { handleDeposition } from './lease-deposition.ts';
import { EngineDeposedError, EngineLeaseNotHeldError } from './lease-errors.ts';

/**
 * Reject a new-workflow start when `ownership: 'lease'` is configured but the
 * engine does not currently hold the lease. The lease is acquired at the two boot
 * gates ({@link Engine.create} and {@link Engine.recoverAll}); a directly
 * constructed engine that calls {@link Engine.start} / {@link Engine.startOrSignal}
 * before `recoverAll()` would otherwise durably write fresh workflow state without
 * single-writer ownership and without having recovered existing runs. This guard
 * runs on the awaited public entry — unlike the swallowed fenced-write throw, its
 * rejection reaches the caller. A no-op under `ownership: 'none'`.
 */
export function assertLeaseHeldForStart(internals: EngineInternals): void {
  if (internals.options.ownershipMode !== 'lease') return;
  const held =
    !internals.deposed &&
    internals.leaseManager !== null &&
    internals.leaseManager.currentEpochBytes() !== null;
  if (!held) {
    throw new EngineLeaseNotHeldError();
  }
}

/**
 * Resolve the lease-epoch fence bytes for a durable write, applying the two guards
 * every fenced commit shares:
 *
 * - a write that STARTS after this engine was detected as deposed is rejected
 *   before it touches storage (the in-flight ones are still caught by the CAS);
 * - under `ownership: 'lease'` a missing held epoch FAILS CLOSED (throws) rather
 *   than downgrading to an unfenced write a deposed instance could exploit — this
 *   is unreachable in normal use (the boot gates + {@link assertLeaseHeldForStart}
 *   ensure a lease is held before any engine-owned durable write).
 *
 * Returns the held epoch bytes under lease ownership, or `null` under
 * `ownership: 'none'` (no epoch condition is added).
 */
function resolveFenceEpoch(internals: EngineInternals): Uint8Array | null {
  if (internals.deposed) {
    throw new EngineDeposedError();
  }
  if (internals.options.ownershipMode !== 'lease') {
    return null;
  }
  const epochBytes = internals.leaseManager?.currentEpochBytes() ?? null;
  if (epochBytes === null) {
    throw new EngineDeposedError();
  }
  return epochBytes;
}

/**
 * Compare two epoch byte strings for exact equality. The held epoch is cached as
 * bytes by the lease manager and the re-read epoch is raw storage bytes; both are
 * the canonical 8-byte big-endian encoding, so a byte-for-byte compare is the
 * correct identity test.
 */
function epochBytesEqual(a: Uint8Array, b: Uint8Array | null): boolean {
  if (b === null || a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * Commit an engine-generator-owned durable write, fencing it on the held lease
 * epoch when `ownership: 'lease'` is configured.
 *
 * This helper owns the entire batch-vs-conditionalBatch decision — callers pass
 * their plain operations plus whatever base CAS conditions they already need
 * (e.g. the checkpoint's expected-bytes condition), and the helper decides how to
 * commit:
 *
 * - **`ownership: 'none'`** (or lease mode with no held epoch yet): a byte-for-byte
 *   no-op relative to the pre-Step-2 path. With no base conditions it issues a
 *   plain {@link Storage.batch}; with base conditions it issues a
 *   {@link Storage.conditionalBatch} exactly as before. No epoch condition is added.
 * - **`ownership: 'lease'`** with a held epoch: appends an epoch condition
 *   (`lease:epoch` must equal the held bytes) to the conditions and always commits
 *   via {@link Storage.conditionalBatch}. Because the epoch condition makes the
 *   condition list non-empty, the plain-batch path can never be taken in lease
 *   mode — so there is no unconditioned bypass through which a deposed zombie's
 *   write could slip.
 *
 * On a `false` CAS result the helper disambiguates: it re-reads `lease:epoch` and,
 * if it no longer matches the held epoch, treats this instance as deposed (drives
 * {@link handleDeposition} and throws {@link EngineDeposedError}); otherwise the
 * failure is an ordinary lost CAS race against a concurrent same-epoch writer and
 * the caller-supplied `onLostRace` error is thrown so existing retry semantics
 * apply.
 *
 * @param internals - the engine internals (carries ownership mode, lease manager, deposed flag)
 * @param operations - the durable operations to commit atomically
 * @param baseConditions - CAS conditions the caller already requires (may be empty)
 * @param onLostRace - builds the error thrown on a same-epoch lost CAS race (non-deposed false)
 */
export async function commitFencedEngineWrite(
  internals: EngineInternals,
  operations: BatchOperation[],
  baseConditions: ConditionalBatchCondition[],
  onLostRace: () => Error,
): Promise<void> {
  const epochBytes = resolveFenceEpoch(internals);

  if (epochBytes === null) {
    // `ownership: 'none'`: preserve the exact pre-Step-2 commit shape — plain batch
    // when there are no conditions, conditionalBatch otherwise. No epoch condition.
    if (baseConditions.length === 0) {
      await internals.storage.batch(operations);
      return;
    }
    await commitConditional(internals, baseConditions, operations, onLostRace);
    return;
  }

  const conditions: ConditionalBatchCondition[] = [
    ...baseConditions,
    { key: KEYS.leaseEpoch(), expectedValue: epochBytes },
  ];
  await commitConditional(internals, conditions, operations, onLostRace, epochBytes);
}

/**
 * Like {@link commitFencedEngineWrite}, but the caller treats a base-precondition
 * failure as a legitimate outcome rather than an error — used by the idempotent
 * start path, where a `false` means a concurrent same-key caller already wrote the
 * record (resolve to the existing run) rather than "retry". Returns `true` when the
 * batch committed and `false` when a base condition failed. Deposition is still a
 * hard halt: if the epoch condition is the one that failed, this drives
 * {@link handleDeposition} and throws {@link EngineDeposedError} — a deposed engine
 * must never report a precondition-failure that the caller would treat as "the run
 * already exists" and silently move on.
 *
 * @param internals - the engine internals
 * @param operations - the durable operations to commit atomically
 * @param baseConditions - the caller's required CAS conditions (must be non-empty;
 *   this path is for conditional starts, which always carry a precondition)
 */
export async function commitFencedEngineWriteAllowingPreconditionFailure(
  internals: EngineInternals,
  operations: BatchOperation[],
  baseConditions: ConditionalBatchCondition[],
): Promise<boolean> {
  const epochBytes = resolveFenceEpoch(internals);
  const conditions =
    epochBytes === null
      ? baseConditions
      : [...baseConditions, { key: KEYS.leaseEpoch(), expectedValue: epochBytes }];

  const committed = await storageConditionalBatch(internals.storage, conditions, operations);
  if (committed) return true;

  // A false in lease mode is ambiguous: a base-precondition conflict (legitimate —
  // return false) or a lost epoch fence (deposed — halt). Disambiguate by re-read.
  if (epochBytes !== null && (await isDeposed(internals, epochBytes))) {
    handleDeposition(internals);
    throw new EngineDeposedError();
  }
  return false;
}

/**
 * Run a conditional batch and resolve a `false` result. When `heldEpochBytes` is
 * provided (lease mode), a `false` triggers the deposition disambiguation
 * re-read; otherwise a `false` is always an ordinary lost CAS race.
 */
async function commitConditional(
  internals: EngineInternals,
  conditions: ConditionalBatchCondition[],
  operations: BatchOperation[],
  onLostRace: () => Error,
  heldEpochBytes?: Uint8Array,
): Promise<void> {
  const committed = await storageConditionalBatch(internals.storage, conditions, operations);
  if (committed) return;

  if (heldEpochBytes !== undefined && (await isDeposed(internals, heldEpochBytes))) {
    handleDeposition(internals);
    throw new EngineDeposedError();
  }
  throw onLostRace();
}

/**
 * Disambiguate a fenced-write CAS failure: re-read `lease:epoch` and report
 * whether this instance has been deposed (the stored epoch no longer matches the
 * held epoch). Safe because epochs are monotonic — reading back your own epoch
 * proves you still genuinely hold (you cannot lose then reacquire without a
 * successor minting a strictly newer epoch).
 *
 * Fail-closed: if the re-read itself throws or returns an undecodable epoch, we
 * treat the instance as deposed. This is a liveness choice, not a correctness one
 * — the epoch CAS already prevented the corrupt write — and halting on an
 * unreadable lease is safer than spinning while another instance may own the store.
 */
async function isDeposed(internals: EngineInternals, heldEpochBytes: Uint8Array): Promise<boolean> {
  let currentEpochRaw: Uint8Array | null;
  try {
    currentEpochRaw = await internals.storage.get(KEYS.leaseEpoch());
  } catch {
    return true;
  }
  if (currentEpochRaw === null) return true;
  if (decodeEpoch(currentEpochRaw) === null) return true;
  return !epochBytesEqual(heldEpochBytes, currentEpochRaw);
}
