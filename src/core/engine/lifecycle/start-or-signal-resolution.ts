import { sleep } from '../../../runtime/portable.ts';
import { KEYS } from '../../../storage/interface.ts';
import { decode } from '../../codec.ts';
import type { StartOrSignalSignal } from '../../types.ts';
import { IdempotencyKeyPurgedError, StartOrSignalConflictError } from '../errors.ts';
import { type WorkflowHandle } from '../handles.ts';
import type { EngineInternals } from '../internals.ts';
import { loadWorkflowState } from '../storage-io.ts';
import { isTerminalWorkflowStatus } from '../validation.ts';
import { type LifecycleCallbacks } from './shared.ts';

/**
 * Callbacks `startOrSignal` needs beyond the lifecycle set: a way to deliver a
 * signal to an already-running workflow through the full engine signal path
 * (interceptors, events, parked-run wakeups). Supplied by the engine so the
 * "signal an existing non-terminal run" branch reuses `engine.signal` with the
 * same `signalId` the create batch would have used.
 */
export type StartOrSignalCallbacks = LifecycleCallbacks & {
  signalExistingWorkflow: (
    workflowId: string,
    signalName: string,
    payload: unknown,
    signalId: string,
  ) => Promise<void>;
};

/** The value stored at `KEYS.startIdempotency(key)`: the workflow the key created. */
export type StartIdempotencyMapping = { workflowId: string };

/** Resolve an existing workflow id for an idempotency key, if one was created. */
export async function resolveIdempotencyKeyWorkflowId(
  internals: EngineInternals,
  idempotencyKey: string,
): Promise<string | undefined> {
  const bytes = await internals.storage.get(KEYS.startIdempotency(idempotencyKey));
  if (bytes === null) {
    return undefined;
  }
  // Written by this module's create batch as `{ workflowId }`; trusted.
  return (decode(bytes) as StartIdempotencyMapping).workflowId;
}

/**
 * Resolve a key-mapped workflow id to a handle id, asserting its record still
 * exists. The `start-idem:` mapping is permanent — it survives BOTH terminal
 * cleanup AND purge/retention (those reclaim the workflow record, never the
 * `start-idem:` keyspace) — so a present mapping whose record is gone means the
 * key is spent: a fresh create would fail the still-present mapping CAS and strand
 * the caller. Surface {@link IdempotencyKeyPurgedError} instead of handing back a
 * handle to a vanished run. Shared by the synchronous mapping hit and the
 * post-race winner lookup so both reject a purged key identically.
 */
export async function resolveExistingRunOrThrowPurged(
  internals: EngineInternals,
  workflowId: string,
): Promise<string> {
  if ((await loadWorkflowState(internals, workflowId)) === null) {
    throw new IdempotencyKeyPurgedError(workflowId);
  }
  return workflowId;
}

/** Maximum waits for a winner's in-memory `pendingStarts` reservation to clear. */
const RESERVATION_CLEAR_MAX_ATTEMPTS = 5;
/** Delay between `pendingStarts` reservation-clearance checks. */
const RESERVATION_CLEAR_RETRY_DELAY_MS = 5;

/**
 * Wait for a winner's in-memory `pendingStarts` reservation to clear, yielding the
 * event loop between checks so the winner's `start` `finally` can run (a busy spin
 * would starve it — Weft runs one engine per durable store, single event loop, so
 * the reservation set is authoritative). Returns once the reservation is gone, or
 * after {@link RESERVATION_CLEAR_MAX_ATTEMPTS} waits. The caller then reads the
 * record to discriminate a committed winner (resolve) from an aborted reservation
 * (retry create): the reservation clears whether `start` committed or rolled back
 * (its `finally` always deletes it), so a cleared reservation with no record means
 * the winner aborted before its durable write.
 */
async function awaitReservationCleared(
  internals: EngineInternals,
  workflowId: string,
): Promise<void> {
  for (let attempt = 0; attempt < RESERVATION_CLEAR_MAX_ATTEMPTS; attempt += 1) {
    if (!internals.pendingStarts.has(workflowId)) {
      return;
    }
    await sleep(RESERVATION_CLEAR_RETRY_DELAY_MS);
  }
}

/**
 * Resolve a caller-`id` create-race loss without conflating an in-memory
 * reservation with a durable record. A loser collides on the winner's
 * `pendingStarts` reservation (start.ts) BEFORE the winner commits, so the bare
 * collision proves nothing about whether a run will exist.
 *
 * Read the winner's record FIRST: this catches a winner that has already committed
 * but is still non-terminal before it can complete (a fast workflow consumes its
 * create-batch signal and finishes the moment it is driven — reading immediately
 * resolves it instead of racing it to a terminal-conflict). Only when the record is
 * absent do we wait for the reservation to clear and read once more to discriminate:
 *
 * - **record present** — the winner committed: signal it (or conflict if terminal)
 *   and return the handle.
 * - **record absent after the reservation clears** — the winner aborted before
 *   committing (storage failure, oversized payload, throwing start interceptor): no
 *   run exists, so return `undefined` and let the caller retry its own create.
 */
export async function resolveCallerIdWinnerOrRetry(
  internals: EngineInternals,
  winnerId: string,
  signalSpec: StartOrSignalSignal,
  signalId: string,
  callbacks: StartOrSignalCallbacks,
): Promise<WorkflowHandle | undefined> {
  const resolved = await signalOrConflictExistingWorkflow(
    internals,
    winnerId,
    signalSpec,
    signalId,
    callbacks,
  );
  if (resolved !== undefined) {
    return resolved;
  }
  await awaitReservationCleared(internals, winnerId);
  return signalOrConflictExistingWorkflow(internals, winnerId, signalSpec, signalId, callbacks);
}

/**
 * For a workflow that already exists: signal it if non-terminal, conflict if
 * terminal. Returns the handle on a successful signal, or `undefined` when the
 * workflow record is not present (so the caller falls through to create).
 */
export async function signalOrConflictExistingWorkflow(
  internals: EngineInternals,
  workflowId: string,
  signalSpec: StartOrSignalSignal,
  signalId: string,
  callbacks: StartOrSignalCallbacks,
): Promise<WorkflowHandle | undefined> {
  const state = await loadWorkflowState(internals, workflowId);
  if (state === null) {
    return undefined;
  }
  if (isTerminalWorkflowStatus(state.status)) {
    throw new StartOrSignalConflictError(workflowId, state.status);
  }
  await callbacks.signalExistingWorkflow(workflowId, signalSpec.name, signalSpec.payload, signalId);
  return callbacks.getHandle(workflowId);
}

/** Number of times winner resolution re-reads a not-yet-readable record before erroring. */
const WINNER_RESOLUTION_MAX_ATTEMPTS = 5;
/**
 * Delay between winner-resolution reads, matching the coordinated-update guard's
 * retry cadence. Gives a winner that reserved `pendingStarts` but has not yet
 * durably committed time to land before the next read, instead of busy-spinning.
 */
const WINNER_RESOLUTION_RETRY_DELAY_MS = 5;

/**
 * Signal a KEYED race winner, bounded-retrying when its record is not yet readable.
 * The keyed winner commits its record atomically with the `start-idem:` mapping, so
 * the record is guaranteed to exist — but the loser may read before the commit
 * settles, so a short delay between reads lets it land. (Caller-`id` winners can
 * abort before committing and are handled by `resolveCallerIdWinnerOrRetry`, not
 * here.)
 *
 * After {@link WINNER_RESOLUTION_MAX_ATTEMPTS} reads with no record, the record is
 * absent for a committed-with-mapping winner only because it was purged: re-read
 * the mapping, and if it still resolves to this exact `winnerId` the key is spent —
 * throw {@link IdempotencyKeyPurgedError}. A mapping that now resolves to a
 * DIFFERENT id (or vanished) cannot prove this winner was purged, so it falls
 * through to the invariant throw rather than mislabelling external keyspace
 * mutation as a spent key.
 */
export async function resolveWinnerWithSignal(
  internals: EngineInternals,
  winnerId: string,
  signalSpec: StartOrSignalSignal,
  signalId: string,
  callbacks: StartOrSignalCallbacks,
  idempotencyKey: string,
): Promise<WorkflowHandle> {
  for (let attempt = 0; attempt < WINNER_RESOLUTION_MAX_ATTEMPTS; attempt += 1) {
    const resolved = await signalOrConflictExistingWorkflow(
      internals,
      winnerId,
      signalSpec,
      signalId,
      callbacks,
    );
    if (resolved !== undefined) {
      return resolved;
    }
    if (attempt < WINNER_RESOLUTION_MAX_ATTEMPTS - 1) {
      await sleep(WINNER_RESOLUTION_RETRY_DELAY_MS);
    }
  }
  const remappedId = await resolveIdempotencyKeyWorkflowId(internals, idempotencyKey);
  if (remappedId === winnerId) {
    throw new IdempotencyKeyPurgedError(winnerId);
  }
  throw new Error(
    `startOrSignal resolved winning workflow "${winnerId}" but its record never became readable ` +
      `after ${WINNER_RESOLUTION_MAX_ATTEMPTS} attempts.`,
  );
}

/**
 * Read the winning workflow id from the idempotency mapping after a lost CAS. The
 * mapping must exist once any caller's create commits; its absence means the
 * `start-idem:` keyspace was mutated externally.
 */
export async function requireWinnerId(
  internals: EngineInternals,
  idempotencyKey: string,
): Promise<string> {
  const winnerId = await resolveIdempotencyKeyWorkflowId(internals, idempotencyKey);
  if (winnerId === undefined) {
    throw new Error(
      `start idempotency mapping for key "${idempotencyKey}" vanished after a lost ` +
        'compare-and-swap; the start-idem: keyspace may have been mutated externally.',
    );
  }
  return winnerId;
}
