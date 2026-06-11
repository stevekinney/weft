import type { BatchOperation, ConditionalBatchCondition } from '../../../storage/interface.ts';
import { KEYS, requireStorageCapability } from '../../../storage/interface.ts';
import { encode } from '../../codec.ts';
import {
  assertIdAndIdempotencyKeyExclusive,
  assertOnTerminalConflictUnsupported,
  assertValidIdempotencyKey,
  assertValidOnTerminalConflict,
  StartWorkflowValidationError,
} from '../../start-workflow-validation.ts';
import type { StartOptions, StartOrSignalSignal } from '../../types.ts';
import { IdempotencyKeyPurgedError, WorkflowAlreadyExistsError } from '../errors.ts';
import { type WorkflowHandle } from '../handles.ts';
import type { EngineInternals } from '../internals.ts';
import { buildCreateBatchSignalOperations } from '../signals.ts';
import { type LifecycleCallbacks } from './shared.ts';
import {
  StartIdempotencyRaceLostError,
  type BuildIdempotentStartOperations,
} from './start-commit.ts';
import {
  requireWinnerId,
  resolveCallerIdWinnerOrRetry,
  resolveExistingRunOrThrowPurged,
  resolveIdempotencyKeyWorkflowId,
  resolveWinnerWithSignal,
  signalOrConflictExistingWorkflow,
  type StartIdempotencyMapping,
  type StartOrSignalCallbacks,
} from './start-or-signal-resolution.ts';
import { startWorkflow } from './start.ts';

export type { StartOrSignalCallbacks };

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
  options: StartOptions | undefined,
  callbacks: StartOrSignalCallbacks,
): Promise<WorkflowHandle> {
  requireStorageCapability(internals.storage, 'conditionalBatch', 'startOrSignal');
  // Runtime backstop for a transport/JS caller smuggling the engine.start-only
  // `onTerminalConflict` past the type boundary (see the assert's JSDoc, #489).
  assertOnTerminalConflictUnsupported(options, 'startOrSignal');

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

/**
 * Maximum create attempts when a caller-`id` winner keeps aborting before its
 * durable commit. Each retry has at most one winner making progress, so concurrent
 * losers converge in the normal case; this cap only bounds a pathological run of
 * back-to-back aborts (a livelock guard, not an expected path).
 */
const CALLER_ID_CREATE_MAX_ATTEMPTS = 5;

/**
 * Create the workflow and deliver the signal atomically, recovering from a lost
 * create batch:
 *
 * - **Lost to a keyed winner** — idempotency-mapping CAS loss
 *   ({@link StartIdempotencyRaceLostError} on the keyed path): the mapping commits
 *   atomically with the record, so the winner is guaranteed committed — resolve it
 *   and signal it (or conflict if terminal).
 * - **Lost to a caller-`id` winner** — collision on the winner's in-memory
 *   `pendingStarts` reservation ({@link WorkflowAlreadyExistsError}): the
 *   reservation is held BEFORE the durable commit, so it may clear without a run
 *   ever existing (the winner aborted: storage failure, oversized payload, a
 *   throwing start interceptor). Wait for the reservation to clear, then signal a
 *   committed winner or — if it aborted — retry the create. Bounded by
 *   {@link CALLER_ID_CREATE_MAX_ATTEMPTS}.
 * - **Signal already buffered** — `StartIdempotencyRaceLostError` on the
 *   caller-`id` path: the only CAS condition there is the signal's, so the loss
 *   means a `sig:` with this signalId was pre-buffered and (the batch being
 *   atomic) the `wf:` record was NOT written. Plain-create the workflow; the
 *   buffered signal is consumed on first drive (scan-then-park), and the caller's
 *   payload loses to the pre-buffered one by the same first-wins dedup.
 */
async function createWithSignalOrFallback(
  internals: EngineInternals,
  type: string,
  input: unknown,
  signalSpec: StartOrSignalSignal,
  signalId: string,
  options: StartOptions | undefined,
  callbacks: StartOrSignalCallbacks,
): Promise<WorkflowHandle> {
  const idempotencyKey = options?.idempotencyKey;
  // A caller-`id` loser whose winner aborts pre-commit retries its own create. The
  // loop only re-iterates on that rare abort; the common case returns on the first
  // pass. The keyed and committed-winner paths never loop.
  for (let attempt = 0; attempt < CALLER_ID_CREATE_MAX_ATTEMPTS; attempt += 1) {
    const outcome = await resolveCreateRaceOutcome(internals, options, async () => {
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

    if (outcome.kind === 'created') {
      return outcome.handle;
    }
    if (outcome.kind === 'lost-keyed') {
      // The keyed winner committed atomically with its mapping. Deliver via the
      // signal path; bounded record-read retries cover commit settling, and the
      // idempotency key lets exhaustion distinguish a purged run from the
      // never-committed invariant.
      return resolveWinnerWithSignal(
        internals,
        outcome.id,
        signalSpec,
        signalId,
        callbacks,
        outcome.idempotencyKey,
      );
    }
    // Both remaining outcomes are caller-`id` losses that resolve a committed
    // winner or, if the winner aborted before committing, return undefined so we
    // retry. Looping re-runs the create above, re-reserving and re-CASing so a
    // winner that commits in the gap causes a clean loss, not a double-create.
    const resolved =
      outcome.kind === 'lost-caller-id'
        ? await resolveCallerIdWinnerOrRetry(internals, outcome.id, signalSpec, signalId, callbacks)
        : await plainCreateBufferedSignalOrResolve(
            internals,
            type,
            input,
            signalSpec,
            signalId,
            options,
            callbacks,
          );
    if (resolved !== undefined) {
      return resolved;
    }
  }
  // Every attempt collided with a caller-`id` winner that then aborted before
  // committing — a pathological run of back-to-back pre-commit failures, not a
  // transient delay. Surface it rather than looping unbounded.
  throw new Error(
    `startOrSignal could not create workflow "${options?.id ?? '<generated>'}" after ` +
      `${CALLER_ID_CREATE_MAX_ATTEMPTS} attempts: each concurrent same-id winner aborted before ` +
      'its durable commit.',
  );
}

/**
 * Handle the `signal-already-buffered` outcome: a `sig:`/`sigres:` for this
 * signalId is already in storage and no `wf:` record exists. Create the workflow
 * WITHOUT folding the signal in again (first drive consumes the buffered signal,
 * and the caller's payload loses to the pre-buffered one by first-wins dedup). A
 * concurrent same-id caller can win this plain create — so on a caller-`id`
 * collision, resolve a committed winner (deduping against the pre-buffered
 * `sigres:`) or, if it aborted, return `undefined` to retry, keeping the
 * `WorkflowAlreadyExistsError` from leaking out of `startOrSignal`.
 */
async function plainCreateBufferedSignalOrResolve(
  internals: EngineInternals,
  type: string,
  input: unknown,
  signalSpec: StartOrSignalSignal,
  signalId: string,
  options: StartOptions | undefined,
  callbacks: StartOrSignalCallbacks,
): Promise<WorkflowHandle | undefined> {
  try {
    return await startWorkflow(internals, type, input, options, undefined, callbacks);
  } catch (error) {
    if (!(error instanceof WorkflowAlreadyExistsError)) {
      throw error;
    }
    return resolveCallerIdWinnerOrRetry(
      internals,
      error.workflowId,
      signalSpec,
      signalId,
      callbacks,
    );
  }
}

/**
 * Classify the result of running the create batch:
 *
 * - `created` — the batch committed; carries the new handle.
 * - `lost-caller-id` — lost a caller-`id` reservation
 *   ({@link WorkflowAlreadyExistsError}); carries the reserved winner id. The
 *   collision may be against an in-memory reservation that never commits, so the
 *   resolver re-checks rather than assuming a run exists.
 * - `lost-keyed` — lost the idempotency-mapping CAS; carries the winner id (read
 *   back from the `start-idem:` mapping) and the key. The mapping commits
 *   atomically with the record, so the winner is guaranteed committed.
 * - `signal-already-buffered` — caller-id path only: the batch's sole CAS
 *   condition (the signal) failed because the signal was pre-buffered, so no
 *   record was written and the workflow must still be created.
 *
 * The keyed path's create batch uses a freshly generated workflow id, so its
 * signal `sig:` condition cannot collide with a pre-buffered signal; a keyed
 * {@link StartIdempotencyRaceLostError} is therefore always a genuine
 * mapping-CAS loss. Any other error propagates.
 */
async function resolveCreateRaceOutcome(
  internals: EngineInternals,
  options: StartOptions | undefined,
  runCreate: () => Promise<WorkflowHandle>,
): Promise<
  | { kind: 'created'; handle: WorkflowHandle }
  | { kind: 'lost-caller-id'; id: string }
  | { kind: 'lost-keyed'; id: string; idempotencyKey: string }
  | { kind: 'signal-already-buffered' }
> {
  try {
    return { kind: 'created', handle: await runCreate() };
  } catch (error) {
    if (error instanceof WorkflowAlreadyExistsError) {
      // id+key is mutually exclusive, so a caller-id collision is the id-only
      // path; the error carries the reserved (winning) id directly. The collision
      // is against the winner's in-memory `pendingStarts` reservation, which may
      // clear without a durable commit — so the loser must re-check, not assume a
      // run exists.
      return { kind: 'lost-caller-id', id: error.workflowId };
    }
    if (error instanceof StartIdempotencyRaceLostError) {
      const idempotencyKey = options?.idempotencyKey;
      if (idempotencyKey !== undefined) {
        // Keyed mapping-CAS loss. The mapping commits atomically with the record,
        // so the winner is guaranteed to have committed (a keyed winner uses a
        // generated id and cannot strand on `pendingStarts`). Carry the (known-
        // defined) key so the resolver can narrow it without re-checking.
        return {
          kind: 'lost-keyed',
          id: await requireWinnerId(internals, idempotencyKey),
          idempotencyKey,
        };
      }
      // Caller-id path: the only CAS condition was the signal's, so this is a
      // pre-buffered signal, not a concurrent winner — create the workflow.
      return { kind: 'signal-already-buffered' };
    }
    throw error;
  }
}
