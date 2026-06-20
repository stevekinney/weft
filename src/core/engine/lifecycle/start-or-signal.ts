import { KEYS, requireStorageCapability } from '../../../storage/interface.ts';
import {
  assertIdAndIdempotencyKeyExclusive,
  assertValidIdempotencyKey,
  assertValidOnTerminalConflict,
  StartWorkflowValidationError,
} from '../../start-workflow-validation.ts';
import type { StartOptions, StartOrSignalOptions, StartOrSignalSignal } from '../../types.ts';
import { IdempotencyKeyPurgedError, StartOrSignalConflictError } from '../errors.ts';
import { type WorkflowHandle } from '../handles.ts';
import type { EngineInternals } from '../internals.ts';
import { type LifecycleCallbacks } from './shared.ts';
import { StartIdempotencyRaceLostError } from './start-commit.ts';
import {
  createWithSignalOrFallback,
  idempotentStartOperationsFor,
  type StartOrSignalResult,
} from './start-or-signal-create.ts';
import {
  requireWinnerId,
  resolveExistingRunOrThrowPurged,
  resolveIdempotencyKeyWorkflowId,
  signalOrConflictExistingWorkflow,
  type StartOrSignalCallbacks,
} from './start-or-signal-resolution.ts';
import { startWorkflow } from './start.ts';

export type { StartOrSignalCallbacks, StartOrSignalResult };

/**
 * Resolve the signal id used for convergence. The `idempotencyKey` takes
 * precedence when present (the two are mutually exclusive, so it is the only
 * input in that case) so independent concurrent callers — who share only the key,
 * never a signalId — derive the same signal id and converge on one delivered
 * signal; otherwise a caller-supplied `signalId` is used directly. At least one of
 * the two must be present, enforced by {@link startOrSignal}.
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
    'startOrSignal requires either signal.signalId or options.idempotencyKey to identify the ' +
      'signal to deliver. (Concurrent callers converge on one workflow and one signal only with a ' +
      'shared idempotencyKey, or a shared id plus signalId; a bare signalId starts a fresh run per ' +
      'caller.)',
  );
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
  // An existing-key call returns early below, skipping startWorkflow's own
  // assertValidOnTerminalConflict — so run that validation here, before the
  // mapping lookup, so it is caught even on the dedup path. It rejects
  // `idempotencyKey` combined with `onTerminalConflict: 'start-new'` (a permanent
  // at-most-once mapping cannot restart a terminal run); the default `'error'` and
  // an absent value are accepted, as on the plain start path.
  assertValidOnTerminalConflict(options);

  const existingId = await resolveIdempotencyKeyWorkflowId(internals, idempotencyKey);
  if (existingId !== undefined) {
    // The mapping survives terminal cleanup but NOT purge/delete; a present
    // mapping whose record is gone means the key is spent, so reject rather than
    // return a handle to a vanished run.
    return callbacks.getHandle(await resolveExistingRunOrThrowPurged(internals, existingId));
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

  // Mirror the synchronous mapping hit above: the winner's record may have been
  // purged since it created, so assert it still exists before handing back a
  // handle rather than returning one to a vanished run.
  return callbacks.getHandle(
    await resolveExistingRunOrThrowPurged(
      internals,
      await requireWinnerId(internals, idempotencyKey),
    ),
  );
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
  options: StartOrSignalOptions | undefined,
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

function validateStartOrSignalRestartPolicy(
  signalSpec: StartOrSignalSignal,
  options: StartOrSignalOptions | undefined,
): void {
  if (options?.onTerminalConflict !== 'start-new' || signalSpec.signalId !== undefined) {
    return;
  }
  throw new StartWorkflowValidationError(
    "startOrSignal options.onTerminalConflict: 'start-new' requires signal.signalId so " +
      'concurrent restart-capable callers converge on one deterministic initial signal.',
  );
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
 * - **Terminal** → throw {@link StartOrSignalConflictError} by default. With
 *   `options.onTerminalConflict: 'start-new'`, purge the prior terminal run
 *   through the shared terminal-replacement path, start a fresh run, and deliver
 *   the initial signal in the create batch.
 *
 * Convergence requires a SHARED workflow identity. Concurrent callers converge on
 * one workflow and one signal only when they share an `options.idempotencyKey`
 * (the durable mapping picks one creator and the signal id derives from the key)
 * or an explicit `options.id` (the caller-id reservation picks one creator).
 *
 * A bare `signal.signalId` with NEITHER `options.id` nor `options.idempotencyKey`
 * does NOT converge: each absent-target call generates its own workflow id, so
 * concurrent callers create distinct runs and each delivers its own signal. In
 * that mode `startOrSignal` is an atomic start-with-one-initial-signal, not a
 * convergence primitive. Use `idempotencyKey` (id-free convergence) or
 * `id` + `signalId` when concurrent callers must converge.
 */
export async function startOrSignal(
  internals: EngineInternals,
  type: string,
  input: unknown,
  signalSpec: StartOrSignalSignal,
  options: StartOrSignalOptions | undefined,
  callbacks: StartOrSignalCallbacks,
): Promise<StartOrSignalResult> {
  requireStorageCapability(internals.storage, 'conditionalBatch', 'startOrSignal');
  assertValidOnTerminalConflict(options);
  validateStartOrSignalRestartPolicy(signalSpec, options);

  const idempotencyKey = options?.idempotencyKey;
  validateStartOrSignalConvergence(signalSpec, options);
  const signalId = resolveSignalId(signalSpec, idempotencyKey);

  const mappedId =
    idempotencyKey !== undefined
      ? await resolveIdempotencyKeyWorkflowId(internals, idempotencyKey)
      : undefined;
  const existingId = mappedId ?? options?.id;

  if (existingId !== undefined) {
    const resolved = await resolveExistingStartOrSignalTarget(
      internals,
      existingId,
      mappedId,
      signalSpec,
      signalId,
      options,
      callbacks,
    );
    if (resolved !== undefined) {
      // The target already existed and was signalled (#466).
      return { handle: resolved, outcome: 'signalled' };
    }
    // The record is absent. If it came from a resolved idempotency mapping, the
    // key's run was purged — the key is spent (a create would fail the still-
    // present mapping CAS and strand the caller). A caller-`id` with no record
    // simply means "create it", so fall through only in that case.
    if (mappedId !== undefined) {
      throw new IdempotencyKeyPurgedError(mappedId);
    }
  }

  return createWithSignalOrFallback(
    internals,
    type,
    input,
    signalSpec,
    signalId,
    options,
    callbacks,
  );
}

async function resolveExistingStartOrSignalTarget(
  internals: EngineInternals,
  existingId: string,
  mappedId: string | undefined,
  signalSpec: StartOrSignalSignal,
  signalId: string,
  options: StartOrSignalOptions | undefined,
  callbacks: StartOrSignalCallbacks,
): Promise<WorkflowHandle | undefined> {
  try {
    return await signalOrConflictExistingWorkflow(
      internals,
      existingId,
      signalSpec,
      signalId,
      callbacks,
    );
  } catch (error) {
    if (canRestartTerminalCallerIdTarget(error, options, mappedId)) {
      return undefined;
    }
    throw error;
  }
}

function canRestartTerminalCallerIdTarget(
  error: unknown,
  options: StartOrSignalOptions | undefined,
  mappedId: string | undefined,
): boolean {
  return (
    error instanceof StartOrSignalConflictError &&
    options?.onTerminalConflict === 'start-new' &&
    mappedId === undefined
  );
}
