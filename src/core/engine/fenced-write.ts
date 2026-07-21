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
 * Reject an engine-owned work entry point (start, startOrSignal, fork, resume)
 * when `ownership: 'lease'` is configured but the engine does not currently hold
 * the lease. The lease is acquired at the two boot gates ({@link Engine.create}
 * and {@link Engine.recoverAll}); a directly constructed engine that does engine
 * work before `recoverAll()` would otherwise durably write workflow state without
 * single-writer ownership and without having recovered existing runs. Placed at
 * each public awaited entry so the caller gets a clean {@link EngineLeaseNotHeldError}
 * — without this, fork, resume, and the schedule mutators (`schedule`,
 * `pauseSchedule`, `resumeSchedule`, `cancelSchedule`, and `updateSchedule`) would
 * reach `resolveFenceEpochOrHalt` with no held epoch and be misreported as a
 * deposition (warn + teardown) rather than the true "lease not held yet"
 * condition. A no-op under `ownership: 'none'`.
 */
export function assertLeaseHeldForEngineWork(internals: EngineInternals): void {
  if (internals.options.ownershipMode !== 'lease') return;
  const held =
    !internals.deposed &&
    internals.leaseManager !== null &&
    internals.leaseManager.currentEpochBytes() !== null;
  if (!held) {
    throw new EngineLeaseNotHeldError();
  }
}

/** The outcome of a fenced commit when it is allowed to report a precondition miss. */
type FencedCommitResult = 'committed' | 'lost-race';

/**
 * Core fenced-commit: the single place that resolves the lease epoch, assembles
 * conditions, runs the batch/conditionalBatch, and resolves a `false` result. Both
 * public entry points are thin wrappers over this so the epoch handling and the
 * deposition disambiguation live in exactly one path.
 *
 * Behaviour by ownership posture:
 * - **`ownership: 'none'`**: byte-for-byte the pre-Step-2 shape — a plain
 *   {@link Storage.batch} when there are no base conditions, a
 *   {@link Storage.conditionalBatch} otherwise. No epoch condition is added, and a
 *   `false` is always a `'lost-race'`.
 * - **`ownership: 'lease'`** with a held epoch: appends an epoch condition and
 *   always commits via {@link Storage.conditionalBatch} (so the plain-batch bypass
 *   can never be taken in lease mode). On `false`, re-reads `lease:epoch`: a stale
 *   epoch means this instance is deposed — it drives {@link handleDeposition} (set
 *   the flag, warn, schedule teardown) and throws {@link EngineDeposedError};
 *   otherwise the result is `'lost-race'`.
 *
 * Two shared guards run first: a write that STARTS after deposition is rejected
 * before touching storage, and a lease-mode write with no held epoch FAILS CLOSED
 * (halts via {@link handleDeposition} and throws) rather than downgrading to an
 * unfenced write — unreachable in normal use (the boot gates +
 * {@link assertLeaseHeldForEngineWork} ensure a lease is held first).
 */
async function fencedCommit(
  internals: EngineInternals,
  operations: BatchOperation[],
  baseConditions: ConditionalBatchCondition[],
): Promise<FencedCommitResult> {
  const epochBytes = resolveFenceEpochOrHalt(internals);

  if (epochBytes === null) {
    // `ownership: 'none'`: byte-for-byte the pre-Step-2 shape — plain batch when
    // there are no base conditions, conditionalBatch otherwise. No epoch condition.
    if (baseConditions.length === 0) {
      await internals.storage.batch(operations);
      return 'committed';
    }
    const committed = await storageConditionalBatch(internals.storage, baseConditions, operations);
    return committed ? 'committed' : 'lost-race';
  }

  const conditions: ConditionalBatchCondition[] = [
    ...baseConditions,
    { key: KEYS.leaseEpoch(), expectedValue: epochBytes },
  ];
  const committed = await storageConditionalBatch(internals.storage, conditions, operations);
  if (committed) return 'committed';

  // A `false` in lease mode is ambiguous: a base-precondition conflict
  // (`'lost-race'`) or a lost epoch fence (deposed — halt). Disambiguate by
  // re-reading the epoch (cheap, on the rare failure path only).
  if (await isDeposed(internals, epochBytes)) {
    handleDeposition(internals);
    throw new EngineDeposedError();
  }
  return 'lost-race';
}

/**
 * Resolve the lease-epoch fence bytes for a durable write, applying the two halt
 * guards every fenced commit shares: a write that STARTS after deposition is
 * rejected before touching storage, and a lease-mode write with no held epoch FAILS
 * CLOSED — it halts the engine via {@link handleDeposition} and throws rather than
 * downgrading to an unfenced write a deposed instance could exploit (unreachable in
 * normal use; the boot gates + {@link assertLeaseHeldForEngineWork} ensure a lease is
 * held first). Returns the held epoch bytes under lease ownership, or `null` under
 * `ownership: 'none'` (no epoch condition is added).
 */
function resolveFenceEpochOrHalt(internals: EngineInternals): Uint8Array | null {
  if (internals.deposed) {
    throw new EngineDeposedError();
  }
  if (internals.options.ownershipMode !== 'lease') {
    return null;
  }
  const epochBytes = internals.leaseManager?.currentEpochBytes() ?? null;
  if (epochBytes === null) {
    handleDeposition(internals);
    throw new EngineDeposedError();
  }
  return epochBytes;
}

/**
 * Commit an engine-generator-owned durable write, fenced on the held lease epoch
 * under `ownership: 'lease'` (a byte-for-byte no-op under `ownership: 'none'`). A
 * lost CAS race throws the caller-supplied `onLostRace` error so existing retry
 * semantics apply; a deposition halts the engine and throws
 * {@link EngineDeposedError}. The helper owns the batch-vs-conditionalBatch
 * decision — pass plain operations plus whatever base conditions you already need.
 *
 * @param internals - the engine internals (ownership mode, lease manager, deposed flag)
 * @param operations - the durable operations to commit atomically
 * @param baseConditions - CAS conditions the caller already requires (may be empty)
 * @param onLostRace - builds the error thrown on a same-epoch lost CAS race
 */
export async function commitFencedEngineWrite(
  internals: EngineInternals,
  operations: BatchOperation[],
  baseConditions: ConditionalBatchCondition[],
  onLostRace: () => Error,
): Promise<void> {
  if ((await fencedCommit(internals, operations, baseConditions)) === 'lost-race') {
    throw onLostRace();
  }
}

/**
 * Like {@link commitFencedEngineWrite}, but the caller treats a base-precondition
 * failure as a legitimate outcome rather than an error — used by the idempotent
 * start path, where a `false` means a concurrent same-key caller already wrote the
 * record (resolve to the existing run) rather than "retry". Returns `true` when the
 * batch committed and `false` when a base condition failed. Deposition is still a
 * hard halt: if the epoch condition is the one that failed, this drives
 * {@link handleDeposition} and throws {@link EngineDeposedError} — a deposed engine
 * must never report a precondition-failure the caller would read as "already exists"
 * and silently move on.
 *
 * @param internals - the engine internals
 * @param operations - the durable operations to commit atomically
 * @param baseConditions - the caller's required CAS conditions (non-empty in
 *   practice — this path is for conditional starts, which always carry one)
 */
export async function commitFencedEngineWriteAllowingPreconditionFailure(
  internals: EngineInternals,
  operations: BatchOperation[],
  baseConditions: ConditionalBatchCondition[],
): Promise<boolean> {
  return (await fencedCommit(internals, operations, baseConditions)) === 'committed';
}

/**
 * Compare two epoch byte strings for exact equality. The held epoch is cached as
 * bytes by the lease manager and the re-read epoch is raw storage bytes; both are
 * the canonical 8-byte big-endian encoding, so a byte-for-byte compare is correct.
 */
function epochBytesEqual(a: Uint8Array, b: Uint8Array | null): boolean {
  if (b === null || a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
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
