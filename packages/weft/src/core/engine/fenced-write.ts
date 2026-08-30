/**
 * Step-2 epoch fencing for `ownership: 'lease'` (issue #470), extended by ADR
 * 0002 to per-workflow fencing under `ownership: 'workflow-lease'`.
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
 * ADR 0002 adds a SECOND, independent fencing token: `wf-owner-epoch:<workflowId>`.
 * Every caller of {@link commitFencedEngineWrite} / {@link
 * commitFencedEngineWriteAllowingPreconditionFailure} now states, via the
 * required `workflowId` parameter, whether the write is scoped to one
 * workflow's execution (pass its id) or is engine-scoped/cross-workflow (pass
 * `null`) — an optional parameter would let a call site silently forget the
 * fence, which is exactly the correctness hole this mechanism exists to close.
 * Under `ownership: 'workflow-lease'` with a non-null `workflowId`, the write
 * is fenced on THAT workflow's claim epoch instead of the global lease epoch;
 * losing that fence deposes only that one workflow (warn + throw), never the
 * whole engine. Under `'lease'` and `'none'`, and under `'workflow-lease'`
 * with `workflowId: null`, behavior is byte-for-byte unchanged from Step 2 —
 * `workflowId` is only consulted in the one new branch.
 *
 * This module is allow-listed for import only from `src/core/engine/**`.
 */

import type { BatchOperation, ConditionalBatchCondition } from '../../storage/interface.ts';
import { KEYS, storageConditionalBatch } from '../../storage/interface.ts';
import type { EngineInternals } from './internals.ts';
import { decodeEpoch } from './lease-codec.ts';
import { emitWorkflowClaimLostWarning, handleDeposition } from './lease-deposition.ts';
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
 * condition. A no-op under `ownership: 'none'` and under `ownership:
 * 'workflow-lease'` — the analogous "claim not held yet" guard for a
 * workflow-scoped write is a later stage's concern (folding `acquire()` into
 * the enabling write), not this global-lease-only assertion.
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
 * Core fenced-commit: the single place that resolves the applicable epoch,
 * assembles conditions, runs the batch/conditionalBatch, and resolves a
 * `false` result. Both public entry points are thin wrappers over this so the
 * epoch handling and the deposition disambiguation live in exactly one path.
 *
 * `workflowId` selects between two fencing tokens:
 * - **non-null, under `ownership: 'workflow-lease'`**: delegates to {@link
 *   fencedCommitForWorkflow} — fenced on `wf-owner-epoch:<workflowId>`, this
 *   engine's per-workflow claim epoch. A lost fence deposes only that
 *   workflow.
 * - **every other case** (`'none'`, `'lease'`, or `'workflow-lease'` with
 *   `workflowId: null`): unchanged from Step 2 — see {@link
 *   resolveFenceEpochOrHalt}.
 */
async function fencedCommit(
  internals: EngineInternals,
  workflowId: string | null,
  operations: BatchOperation[],
  baseConditions: ConditionalBatchCondition[],
): Promise<FencedCommitResult> {
  if (internals.options.ownershipMode === 'workflow-lease' && workflowId !== null) {
    return fencedCommitForWorkflow(internals, workflowId, operations, baseConditions);
  }

  const epochBytes = resolveFenceEpochOrHalt(internals);

  if (epochBytes === null) {
    // `ownership: 'none'`, or `'workflow-lease'` with an engine-scoped write:
    // byte-for-byte the pre-ADR shape — plain batch when there are no base
    // conditions, conditionalBatch otherwise. No epoch condition.
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
 * `ownership: 'none'` or an engine-scoped `'workflow-lease'` write (no epoch
 * condition is added in either case).
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
 * Workflow-scoped fenced commit under `ownership: 'workflow-lease'` (ADR
 * 0002 § Ownership transitions). Appends `wf-owner-epoch:<workflowId>` as an
 * ADDITIONAL precondition — never a replacement — for the caller's base
 * conditions, using the epoch bytes this engine's `WorkflowClaimRegistry`
 * currently believes it holds for `workflowId`
 * ({@link EngineInternals.workflowClaimRegistry}).
 *
 * A `null` epoch (untracked — never acquired, lost via a failed renewal, or
 * already released; also always the case today, since wiring the registry
 * into `Engine` construction and folding `acquire()` into start/resume/
 * delayed-start-fire is a later stage) fails closed immediately, with no
 * storage round trip: this engine cannot fence a write for a workflow it does
 * not currently believe it owns.
 *
 * Deposition here is scoped to exactly ONE workflow: it emits {@link
 * WeftWorkflowClaimLostWarning} and throws {@link EngineDeposedError}
 * carrying `workflowId`, but — unlike {@link handleDeposition} — it never
 * sets {@link EngineInternals.deposed} and never halts the engine or its
 * other claimed workflows. Every subsequent write attempted for this
 * `workflowId` re-derives `epochBytes` from the registry and, until some
 * later reconciliation re-acquires the claim, keeps failing closed the same
 * way — which is what "stops that workflow" without any extra bookkeeping
 * here. That asymmetry versus global `'lease'` deposition is the entire
 * point of `workflow-lease`.
 */
async function fencedCommitForWorkflow(
  internals: EngineInternals,
  workflowId: string,
  operations: BatchOperation[],
  baseConditions: ConditionalBatchCondition[],
): Promise<FencedCommitResult> {
  const epochBytes = internals.workflowClaimRegistry?.currentEpochBytes(workflowId) ?? null;
  if (epochBytes === null) {
    haltWorkflowClaim(workflowId);
  }

  const conditions: ConditionalBatchCondition[] = [
    ...baseConditions,
    { key: KEYS.workflowOwnerEpoch(workflowId), expectedValue: epochBytes },
  ];
  const committed = await storageConditionalBatch(internals.storage, conditions, operations);
  if (committed) return 'committed';

  // A `false` is ambiguous the same way global lease mode's is: a
  // base-precondition conflict (`'lost-race'`) or a lost per-workflow epoch
  // fence (this workflow deposed — halt just this workflow). Disambiguate by
  // re-reading `wf-owner-epoch:<workflowId>` (cheap, on the rare failure path
  // only).
  if (await isWorkflowDeposed(internals, workflowId, epochBytes)) {
    haltWorkflowClaim(workflowId);
  }
  return 'lost-race';
}

/**
 * React to a confirmed per-workflow deposition: emit {@link
 * WeftWorkflowClaimLostWarning} for `workflowId`, then throw {@link
 * EngineDeposedError} carrying it. Never touches {@link
 * EngineInternals.deposed} and never schedules engine teardown — see {@link
 * fencedCommitForWorkflow}'s doc for why that asymmetry versus {@link
 * handleDeposition} is intentional.
 */
function haltWorkflowClaim(workflowId: string): never {
  emitWorkflowClaimLostWarning(workflowId);
  throw new EngineDeposedError(workflowId);
}

/**
 * Commit an engine-generator-owned durable write, fenced on the applicable
 * epoch: the global lease epoch under `ownership: 'lease'`, this workflow's
 * claim epoch under `ownership: 'workflow-lease'` when `workflowId` is
 * non-null, or — under `'none'` and every other `workflowId`/mode
 * combination — byte-for-byte unfenced. A lost CAS race throws the
 * caller-supplied `onLostRace` error so existing retry semantics apply; a
 * deposition halts (the engine under global `'lease'`, or just this one
 * workflow under `'workflow-lease'`) and throws {@link EngineDeposedError}.
 * The helper owns the batch-vs-conditionalBatch decision — pass plain
 * operations plus whatever base conditions you already need.
 *
 * @param internals - the engine internals (ownership mode, lease manager,
 *   workflow claim registry, deposed flag)
 * @param workflowId - the workflow this write is scoped to, fenced on that
 *   workflow's claim epoch under `ownership: 'workflow-lease'`; or `null` for
 *   an engine-scoped/cross-workflow write, which is never fenced on a
 *   per-workflow claim regardless of ownership mode. Required — there is no
 *   default — so every call site states its scope explicitly.
 * @param operations - the durable operations to commit atomically
 * @param baseConditions - CAS conditions the caller already requires (may be empty)
 * @param onLostRace - builds the error thrown on a same-epoch lost CAS race
 */
export async function commitFencedEngineWrite(
  internals: EngineInternals,
  workflowId: string | null,
  operations: BatchOperation[],
  baseConditions: ConditionalBatchCondition[],
  onLostRace: () => Error,
): Promise<void> {
  if ((await fencedCommit(internals, workflowId, operations, baseConditions)) === 'lost-race') {
    throw onLostRace();
  }
}

/**
 * Like {@link commitFencedEngineWrite}, but the caller treats a base-precondition
 * failure as a legitimate outcome rather than an error — used by the idempotent
 * start path, where a `false` means a concurrent same-key caller already wrote the
 * record (resolve to the existing run) rather than "retry". Returns `true` when the
 * batch committed and `false` when a base condition failed. Deposition is still a
 * hard halt: if the epoch condition is the one that failed, this drives the
 * applicable deposition path and throws {@link EngineDeposedError} — a deposed
 * engine (or a deposed single workflow, under `workflow-lease`) must never report a
 * precondition-failure the caller would read as "already exists" and silently
 * move on.
 *
 * @param internals - the engine internals
 * @param workflowId - see {@link commitFencedEngineWrite} — the workflow this
 *   write is scoped to, or `null` for an engine-scoped write
 * @param operations - the durable operations to commit atomically
 * @param baseConditions - the caller's required CAS conditions (non-empty in
 *   practice — this path is for conditional starts, which always carry one)
 */
export async function commitFencedEngineWriteAllowingPreconditionFailure(
  internals: EngineInternals,
  workflowId: string | null,
  operations: BatchOperation[],
  baseConditions: ConditionalBatchCondition[],
): Promise<boolean> {
  return (await fencedCommit(internals, workflowId, operations, baseConditions)) === 'committed';
}

/**
 * Compare two epoch byte strings for exact equality. The held epoch is cached as
 * bytes by the lease manager (or the workflow claim registry) and the re-read
 * epoch is raw storage bytes; both are the canonical 8-byte big-endian encoding,
 * so a byte-for-byte compare is correct.
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

/**
 * Disambiguate a workflow-scoped fenced-write CAS failure: re-read
 * `wf-owner-epoch:<workflowId>` and report whether this engine has been
 * deposed FOR THAT WORKFLOW (the stored epoch no longer matches the epoch
 * this engine's registry believes it holds). Mirrors {@link isDeposed}'s
 * fail-closed treatment of an unreadable or undecodable epoch.
 */
async function isWorkflowDeposed(
  internals: EngineInternals,
  workflowId: string,
  heldEpochBytes: Uint8Array,
): Promise<boolean> {
  let currentEpochRaw: Uint8Array | null;
  try {
    currentEpochRaw = await internals.storage.get(KEYS.workflowOwnerEpoch(workflowId));
  } catch {
    return true;
  }
  if (currentEpochRaw === null) return true;
  if (decodeEpoch(currentEpochRaw) === null) return true;
  return !epochBytesEqual(heldEpochBytes, currentEpochRaw);
}
