import { sleep } from '../../../runtime/portable.ts';
import { KEYS } from '../../../storage/interface.ts';
import { decode } from '../../codec.ts';
import type { StartOrSignalSignal } from '../../types.ts';
import { StartOrSignalConflictError } from '../errors.ts';
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
 * Signal the race winner, bounded-retrying when its record is not yet readable. A
 * caller-id loser can observe the winner's in-memory `pendingStarts` reservation
 * (see start.ts) BEFORE the winner's durable commit lands, so the first read may
 * miss the record; a short delay between reads lets the commit settle. Throws
 * after {@link WINNER_RESOLUTION_MAX_ATTEMPTS} reads if the record never appears
 * — reachable only if a reserving caller never commits (e.g. it crashed mid-start
 * after reserving), which is a genuine invariant violation, not a transient delay.
 */
export async function resolveWinnerWithSignal(
  internals: EngineInternals,
  winnerId: string,
  signalSpec: StartOrSignalSignal,
  signalId: string,
  callbacks: StartOrSignalCallbacks,
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
