import type { BatchOperation, ConditionalBatchCondition } from '../../../storage/interface.ts';
import { KEYS, requireStorageCapability } from '../../../storage/interface.ts';
import { decode, encode } from '../../codec.ts';
import type { StartOptions, StartOrSignalSignal } from '../../types.ts';
import { StartOrSignalConflictError, WorkflowAlreadyExistsError } from '../errors.ts';
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
    return `start-idem:${idempotencyKey}`;
  }
  if (signalSpec.signalId !== undefined) {
    return signalSpec.signalId;
  }
  throw new Error(
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
 * batch, gated on the mapping key being absent. Returns `undefined` when neither
 * an idempotency key nor a signal needs to be persisted, so the plain start path
 * is used.
 */
function buildIdempotentStartOperationsFactory(
  internals: EngineInternals,
  idempotencyKey: string | undefined,
  signal: { name: string; payload: unknown; signalId: string } | undefined,
): BuildIdempotentStartOperations | undefined {
  if (idempotencyKey === undefined && signal === undefined) {
    return undefined;
  }
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
  options: StartOptions & { idempotencyKey: string },
  callbacks: LifecycleCallbacks,
): Promise<WorkflowHandle> {
  requireStorageCapability(internals.storage, 'conditionalBatch', 'start idempotency');
  const { idempotencyKey } = options;

  const existingId = await resolveIdempotencyKeyWorkflowId(internals, idempotencyKey);
  if (existingId !== undefined) {
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
      buildIdempotentStartOperationsFactory(internals, idempotencyKey, undefined),
    );
  } catch (error) {
    // Lost the race to a concurrent same-key caller, by either the idempotency-
    // mapping CAS (random/typical id) or the caller-id reservation (a fixed
    // `id` was also supplied — the loser's `callerProvidedId` check throws
    // before the mapping CAS). Both resolve to the winner via the mapping.
    const lostRace =
      error instanceof StartIdempotencyRaceLostError || error instanceof WorkflowAlreadyExistsError;
    if (!lostRace) {
      throw error;
    }
  }

  return callbacks.getHandle(await requireWinnerId(internals, idempotencyKey));
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
  if (idempotencyKey !== undefined && signalSpec.signalId !== undefined) {
    // They are mutually exclusive: the key-derived id is what makes independent
    // concurrent callers converge, so honoring a caller signalId alongside a key
    // would silently re-introduce double-delivery. Reject rather than pick one.
    throw new Error(
      'startOrSignal does not accept both signal.signalId and options.idempotencyKey: the ' +
        'signal id derives from the idempotency key for convergence. Provide exactly one.',
    );
  }
  const signalId = resolveSignalId(signalSpec, idempotencyKey);

  const existingId =
    idempotencyKey !== undefined
      ? await resolveIdempotencyKeyWorkflowId(internals, idempotencyKey)
      : options?.id;

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
    // The id is reserved (mapping present) but the record is not yet readable;
    // fall through to the create path, which will lose the CAS and re-resolve.
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
  try {
    return await startWorkflow(
      internals,
      type,
      input,
      options,
      undefined,
      callbacks,
      buildIdempotentStartOperationsFactory(internals, idempotencyKey, {
        name: signalSpec.name,
        payload: signalSpec.payload,
        signalId,
      }),
    );
  } catch (error) {
    const lostByMapping = error instanceof StartIdempotencyRaceLostError;
    const lostByCallerId = error instanceof WorkflowAlreadyExistsError;
    if (!lostByMapping && !lostByCallerId) {
      throw error;
    }
  }

  // Lost the create race. Resolve the winner and deliver via the signal path,
  // whose CAS dedups against the winner's create-batch signal (same signalId).
  const winnerId =
    idempotencyKey !== undefined
      ? await requireWinnerId(internals, idempotencyKey)
      : requireCallerProvidedId(options);
  const resolved = await signalOrConflictExistingWorkflow(
    internals,
    winnerId,
    signalSpec,
    signalId,
    callbacks,
  );
  if (resolved === undefined) {
    throw new Error(
      `startOrSignal resolved winning workflow "${winnerId}" but its record is missing.`,
    );
  }
  return resolved;
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

/** The caller-provided id is the winner when an id-only create loses its reservation. */
function requireCallerProvidedId(options: StartOptions | undefined): string {
  if (options?.id === undefined) {
    throw new Error(
      'startOrSignal lost a caller-id create race without a caller-provided id; this is ' +
        'unreachable because WorkflowAlreadyExistsError is only thrown for a supplied id.',
    );
  }
  return options.id;
}
