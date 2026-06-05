import { sleep } from '../../../runtime/portable.ts';
import type { BatchOperation, ConditionalBatchCondition } from '../../../storage/interface.ts';
import { KEYS, requireStorageCapability } from '../../../storage/interface.ts';
import { decode, encode } from '../../codec.ts';
import {
  assertValidIdempotencyKey,
  StartWorkflowValidationError,
} from '../../start-workflow-validation.ts';
import type { StartOptions, StartOrSignalSignal } from '../../types.ts';
import {
  IdempotencyKeyPurgedError,
  StartOrSignalConflictError,
  WorkflowAlreadyExistsError,
} from '../errors.ts';
import { type WorkflowHandle } from '../handles.ts';
import type { EngineInternals } from '../internals.ts';
import { buildCreateBatchSignalOperations } from '../signals.ts';
import { loadWorkflowState } from '../storage-io.ts';
import { isTerminalWorkflowStatus } from '../validation.ts';
import { type LifecycleCallbacks } from './shared.ts';
import {
  StartIdempotencyRaceLostError,
  type BuildIdempotentStartOperations,
} from './start-commit.ts';
import { startWorkflow } from './start.ts';

/**
 * Callbacks {@link startOrSignal} needs beyond the lifecycle set: a way to
 * deliver a signal to an already-running workflow through the full engine signal
 * path (interceptors, events, parked-run wakeups). Supplied by the engine so the
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

type StartIdempotencyMapping = { workflowId: string };

/**
 * Resolve the signal id used for convergence. A caller-supplied `signalId` wins;
 * otherwise it derives from the `idempotencyKey` so independent concurrent
 * callers — who share only the key — still converge on one signal. At least one
 * of the two must be present, enforced by {@link startOrSignal}.
 */
function resolveSignalId(
  signalSpec: StartOrSignalSignal,
  idempotencyKey: string | undefined,
): string {
  // The idempotency key wins when present. Independent concurrent callers (e.g.
  // retried webhooks) share only the key, never a signalId, so deriving from the
  // key is what makes them converge on ONE delivered signal. A caller-supplied
  // signalId alongside a key would let racers each write a distinct signal — the
  // exact double-delivery the dedup exists to prevent — so the two are mutually
  // exclusive (rejected at the API boundary; see `startOrSignal`).
  if (idempotencyKey !== undefined) {
    return KEYS.startIdempotencySignalId(idempotencyKey);
  }
  if (signalSpec.signalId !== undefined) {
    return signalSpec.signalId;
  }
  throw new StartWorkflowValidationError(
    'startOrSignal requires either signal.signalId or options.idempotencyKey so concurrent ' +
      'callers converge on a single delivered signal.',
  );
}

/** Resolve an existing workflow id for an idempotency key, if one was created. */
async function resolveIdempotencyKeyWorkflowId(
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
 * Build the `(workflowId) => { operations, conditions }` callback that folds the
 * idempotency mapping and (optionally) the create-batch signal into the start
 * batch, gated on the mapping key being absent. Every caller supplies at least
 * one of `idempotencyKey` / `signal` (the plain start path skips this builder
 * entirely), so the returned callback always contributes at least one operation.
 */
function idempotentStartOperationsFor(
  internals: EngineInternals,
  idempotencyKey: string | undefined,
  signal: { name: string; payload: unknown; signalId: string } | undefined,
): BuildIdempotentStartOperations {
  return (workflowId) => {
    const operations: BatchOperation[] = [];
    const conditions: ConditionalBatchCondition[] = [];

    if (idempotencyKey !== undefined) {
      const key = KEYS.startIdempotency(idempotencyKey);
      operations.push({
        type: 'put',
        key,
        value: encode({ workflowId } satisfies StartIdempotencyMapping),
      });
      conditions.push({ key, expectedValue: null });
    }

    if (signal !== undefined) {
      const built = buildCreateBatchSignalOperations(
        internals,
        workflowId,
        signal.name,
        signal.payload,
        signal.signalId,
      );
      operations.push(...built.operations);
      conditions.push(built.condition);
    }

    return { operations, conditions };
  };
}

/**
 * Enforce at-most-once start for a given `idempotencyKey`. On the first call,
 * the workflow record and a `startIdempotency(key) → { workflowId }` mapping
 * commit in one compare-and-swap gated on the mapping being absent. Every later
 * call with the same key resolves the mapping and returns a handle to that run —
 * even if it has since reached a terminal state (idempotent start is a pure
 * dedup; it never restarts).
 *
 * Concurrent same-key callers race at the lookup→commit gap; the CAS lets exactly
 * one win, and the loser (its create batch rejected) resolves to the winner's
 * run. Requires the `conditionalBatch` capability and throws if it is absent —
 * single-execution semantics cannot be honored without atomic compare-and-swap.
 */
export async function startWithIdempotency(
  internals: EngineInternals,
  type: string,
  input: unknown,
  options: StartOptions,
  callbacks: LifecycleCallbacks,
): Promise<WorkflowHandle> {
  requireStorageCapability(internals.storage, 'conditionalBatch', 'start idempotency');
  const { idempotencyKey } = options;
  if (idempotencyKey === undefined) {
    // The engine only routes here when a key is set; an undefined key is a
    // programming error, not a runtime input — fail loudly rather than silently
    // starting without idempotency.
    throw new StartWorkflowValidationError('startWithIdempotency requires options.idempotencyKey');
  }
  assertValidIdempotencyKey(idempotencyKey, 'options.idempotencyKey');
  assertIdAndIdempotencyKeyExclusive(options);

  const existingId = await resolveIdempotencyKeyWorkflowId(internals, idempotencyKey);
  if (existingId !== undefined) {
    // The mapping survives terminal cleanup but NOT purge/delete. If the record
    // is gone the key is spent — a fresh create would fail the mapping CAS and
    // strand the caller; surface a clear error instead.
    if ((await loadWorkflowState(internals, existingId)) === null) {
      throw new IdempotencyKeyPurgedError(existingId);
    }
    return callbacks.getHandle(existingId);
  }

  try {
    return await startWorkflow(
      internals,
      type,
      input,
      options,
      undefined,
      callbacks,
      idempotentStartOperationsFor(internals, idempotencyKey, undefined),
    );
  } catch (error) {
    // Only an idempotency-mapping CAS loss is a same-key race we resolve to the
    // winner. A `WorkflowAlreadyExistsError` cannot reach here: the key path
    // always uses a generated id (id + idempotencyKey is rejected above), so the
    // caller-id reservation never collides — a genuine id collision is therefore
    // impossible on this path and is not swallowed.
    if (!(error instanceof StartIdempotencyRaceLostError)) {
      throw error;
    }
  }

  return callbacks.getHandle(await requireWinnerId(internals, idempotencyKey));
}

/**
 * `id` and `idempotencyKey` are mutually exclusive. Idempotency assigns its own
 * generated id and dedups through the `start-idem:` mapping; pinning a caller
 * `id` alongside it would make the loser of a same-key race collide on the fixed
 * id (a genuine `WorkflowAlreadyExistsError`) rather than converge through the
 * mapping, conflating "id already taken" with "lost the idempotency race". Reject
 * the combination so each concern stays separable.
 */
function assertIdAndIdempotencyKeyExclusive(options: StartOptions): void {
  if (options.id !== undefined && options.idempotencyKey !== undefined) {
    throw new StartWorkflowValidationError(
      'options.id and options.idempotencyKey are mutually exclusive: idempotency assigns its own ' +
        'workflow id and dedups through the idempotency key. Provide one or the other.',
    );
  }
}

/**
 * Validate the convergence tokens for {@link startOrSignal}: when an
 * `idempotencyKey` is present it must be well-formed, exclusive of `options.id`,
 * and exclusive of a caller-supplied `signal.signalId` (the key derives the
 * signal id). Throws {@link StartWorkflowValidationError} otherwise. The
 * "exactly one of signalId / idempotencyKey is required" check happens later in
 * {@link resolveSignalId}, after the absent case is known.
 */
function validateStartOrSignalConvergence(
  signalSpec: StartOrSignalSignal,
  options: StartOptions | undefined,
): void {
  const idempotencyKey = options?.idempotencyKey;
  if (idempotencyKey === undefined) {
    return;
  }
  assertValidIdempotencyKey(idempotencyKey, 'options.idempotencyKey');
  assertIdAndIdempotencyKeyExclusive(options ?? {});
  if (signalSpec.signalId !== undefined) {
    throw new StartWorkflowValidationError(
      'startOrSignal does not accept both signal.signalId and options.idempotencyKey: the signal ' +
        'id derives from the idempotency key for convergence. Provide exactly one.',
    );
  }
}

/**
 * Atomic start-or-signal (signal-with-start). Resolves the target workflow, then:
 *
 * - **Absent** → create the workflow and deliver the signal in ONE conditional
 *   batch (workflow record + `sig:`/`sigres:` pair + optional idempotency
 *   mapping). The freshly-launched run consumes the signal on its first drive.
 * - **Non-terminal** (running, pending, suspended) → deliver the signal through
 *   the standard engine signal path with the same `signalId`, so it dedups
 *   against a create-batch signal a concurrent winner may have written.
 * - **Terminal** → throw {@link StartOrSignalConflictError}: a finished run
 *   cannot be signalled and is not silently replaced.
 *
 * Concurrent callers converge on one workflow and one signal: the create CAS (or
 * the caller-id reservation) picks a single creator, and every other caller
 * falls through to the signal path whose CAS dedups on the shared `signalId`.
 */
export async function startOrSignal(
  internals: EngineInternals,
  type: string,
  input: unknown,
  signalSpec: StartOrSignalSignal,
  options: StartOptions | undefined,
  callbacks: StartOrSignalCallbacks,
): Promise<WorkflowHandle> {
  requireStorageCapability(internals.storage, 'conditionalBatch', 'startOrSignal');

  const idempotencyKey = options?.idempotencyKey;
  validateStartOrSignalConvergence(signalSpec, options);
  const signalId = resolveSignalId(signalSpec, idempotencyKey);

  const mappedId =
    idempotencyKey !== undefined
      ? await resolveIdempotencyKeyWorkflowId(internals, idempotencyKey)
      : undefined;
  const existingId = mappedId ?? options?.id;

  if (existingId !== undefined) {
    const resolved = await signalOrConflictExistingWorkflow(
      internals,
      existingId,
      signalSpec,
      signalId,
      callbacks,
    );
    if (resolved !== undefined) {
      return resolved;
    }
    // The record is absent. If it came from a resolved idempotency mapping, the
    // key's run was purged — the key is spent (a create would fail the still-
    // present mapping CAS and strand the caller). A caller-`id` with no record
    // simply means "create it", so fall through only in that case.
    if (mappedId !== undefined) {
      throw new IdempotencyKeyPurgedError(mappedId);
    }
  }

  return createWithSignalOrFallBack(
    internals,
    type,
    input,
    signalSpec,
    signalId,
    options,
    callbacks,
  );
}

/**
 * For a workflow that already exists: signal it if non-terminal, conflict if
 * terminal. Returns the handle on a successful signal, or `undefined` when the
 * workflow record is not present (so the caller falls through to create).
 */
async function signalOrConflictExistingWorkflow(
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

/**
 * Create the workflow and deliver the signal atomically. If the create batch
 * loses to a concurrent caller — by idempotency-mapping CAS
 * ({@link StartIdempotencyRaceLostError}) or by caller-id reservation
 * ({@link WorkflowAlreadyExistsError}) — resolve the winner and signal it (or
 * conflict if it has already gone terminal).
 */
async function createWithSignalOrFallBack(
  internals: EngineInternals,
  type: string,
  input: unknown,
  signalSpec: StartOrSignalSignal,
  signalId: string,
  options: StartOptions | undefined,
  callbacks: StartOrSignalCallbacks,
): Promise<WorkflowHandle> {
  const idempotencyKey = options?.idempotencyKey;
  const winnerId = await resolveCreateRaceWinnerId(internals, idempotencyKey, async () => {
    return startWorkflow(
      internals,
      type,
      input,
      options,
      undefined,
      callbacks,
      idempotentStartOperationsFor(internals, idempotencyKey, {
        name: signalSpec.name,
        payload: signalSpec.payload,
        signalId,
      }),
    );
  });
  if (winnerId.kind === 'created') {
    return winnerId.handle;
  }

  // Lost the create race to a concurrent caller. Resolve the winner and deliver
  // via the signal path, whose CAS dedups against the winner's create-batch
  // signal (same signalId). The winner's record may not be readable on the first
  // read if its commit is still settling, so resolution is bounded-retried.
  return resolveWinnerWithSignal(internals, winnerId.id, signalSpec, signalId, callbacks);
}

/**
 * Run the create batch. On success, return the new handle. On a lost create race
 * — by idempotency-mapping CAS ({@link StartIdempotencyRaceLostError}) or by
 * caller-id reservation ({@link WorkflowAlreadyExistsError}) — return the winner's
 * id so the caller can resolve and signal it. The caller-id loss carries the
 * winning id directly on the error; the mapping loss reads it back from the
 * `start-idem:` mapping. Any other error propagates.
 */
async function resolveCreateRaceWinnerId(
  internals: EngineInternals,
  idempotencyKey: string | undefined,
  runCreate: () => Promise<WorkflowHandle>,
): Promise<{ kind: 'created'; handle: WorkflowHandle } | { kind: 'lost'; id: string }> {
  try {
    return { kind: 'created', handle: await runCreate() };
  } catch (error) {
    if (error instanceof WorkflowAlreadyExistsError) {
      // id+key is mutually exclusive, so a caller-id collision is the id-only
      // path; the error carries the reserved (winning) id directly.
      return { kind: 'lost', id: error.workflowId };
    }
    if (error instanceof StartIdempotencyRaceLostError && idempotencyKey !== undefined) {
      return { kind: 'lost', id: await requireWinnerId(internals, idempotencyKey) };
    }
    throw error;
  }
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
async function resolveWinnerWithSignal(
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
async function requireWinnerId(
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
