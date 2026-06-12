/**
 * Create-and-deliver machinery for {@link startOrSignal}: building the atomic
 * start-with-signal batch, running it, and recovering from every way the create
 * can lose its CAS (keyed-mapping loss, caller-`id` reservation collision, or a
 * pre-buffered signal). Split from `start-or-signal.ts` to keep that module
 * focused on the public `startOrSignal` / `startWithIdempotency` entry points.
 *
 * @module core/engine/lifecycle/start-or-signal-create
 */

import type { BatchOperation, ConditionalBatchCondition } from '../../../storage/interface.ts';
import { KEYS } from '../../../storage/interface.ts';
import { encode } from '../../codec.ts';
import type { StartOptions, StartOrSignalSignal } from '../../types.ts';
import { WorkflowAlreadyExistsError } from '../errors.ts';
import { type StartOrSignalOutcome, type WorkflowHandle } from '../handles.ts';
import type { EngineInternals } from '../internals.ts';
import { buildCreateBatchSignalOperations } from '../signals.ts';
import {
  StartIdempotencyRaceLostError,
  type BuildIdempotentStartOperations,
} from './start-commit.ts';
import {
  requireWinnerId,
  resolveCallerIdWinnerOrRetry,
  resolveWinnerWithSignal,
  type StartIdempotencyMapping,
  type StartOrSignalCallbacks,
} from './start-or-signal-resolution.ts';
import { startWorkflow } from './start.ts';

/**
 * Build the `(workflowId) => { operations, conditions }` callback that folds the
 * idempotency mapping and (optionally) the create-batch signal into the start
 * batch, gated on the mapping key being absent. Every caller supplies at least
 * one of `idempotencyKey` / `signal` (the plain start path skips this builder
 * entirely), so the returned callback always contributes at least one operation.
 */
export function idempotentStartOperationsFor(
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
 * Maximum create attempts when a caller-`id` winner keeps aborting before its
 * durable commit. Each retry has at most one winner making progress, so concurrent
 * losers converge in the normal case; this cap only bounds a pathological run of
 * back-to-back aborts (a livelock guard, not an expected path).
 */
const CALLER_ID_CREATE_MAX_ATTEMPTS = 5;

/**
 * A resolved start-or-signal handle paired with which atomic path produced it
 * (#466), computed during the call at zero extra cost.
 */
export type StartOrSignalResult<TResult = unknown> = {
  handle: WorkflowHandle<TResult>;
  outcome: StartOrSignalOutcome;
};

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
 *   caller-`id` path: the only CAS condition there is the signal's `sigres:`
 *   accepted-response marker, so the loss means a signal with this signalId was
 *   pre-buffered and (the batch being atomic) the `wf:` record was NOT written.
 *   Plain-create the workflow; the buffered signal is consumed on first drive
 *   (scan-then-park), and the caller's payload loses to the pre-buffered one by
 *   the same first-wins dedup.
 */
export async function createWithSignalOrFallback(
  internals: EngineInternals,
  type: string,
  input: unknown,
  signalSpec: StartOrSignalSignal,
  signalId: string,
  options: StartOptions | undefined,
  callbacks: StartOrSignalCallbacks,
): Promise<StartOrSignalResult> {
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
      return { handle: outcome.handle, outcome: 'started' }; // this call created the run
    }
    if (outcome.kind === 'lost-keyed') {
      // The keyed winner committed atomically with its mapping. Deliver via the
      // signal path; bounded record-read retries cover commit settling, and the
      // idempotency key lets exhaustion distinguish a purged run from the
      // never-committed invariant. We lost the create race → signalled.
      return {
        handle: await resolveWinnerWithSignal(
          internals,
          outcome.id,
          signalSpec,
          signalId,
          callbacks,
          outcome.idempotencyKey,
        ),
        outcome: 'signalled',
      };
    }
    // Both remaining outcomes resolve a committed winner, or return undefined so
    // the loop retries (the winner aborted pre-commit); re-running the create
    // re-reserves and re-CASes so a winner committing in the gap is a clean loss.
    if (outcome.kind === 'lost-caller-id') {
      // Lost a caller-`id` reservation → a resolved winner means we signalled it.
      const resolved = await resolveCallerIdWinnerOrRetry(
        internals,
        outcome.id,
        signalSpec,
        signalId,
        callbacks,
      );
      if (resolved !== undefined) {
        return { handle: resolved, outcome: 'signalled' };
      }
    } else {
      // `signal-already-buffered`: a pre-buffered signal forces a plain create.
      // Winning it 'started' the run; losing a concurrent caller-`id` race
      // 'signalled' the winner — `plainCreateBufferedSignalOrResolve` classifies.
      const resolved = await plainCreateBufferedSignalOrResolve(
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
): Promise<StartOrSignalResult | undefined> {
  try {
    // This call created the run (the pre-buffered signal is consumed on first
    // drive; the caller's own payload loses by first-wins dedup) → 'started'.
    return {
      handle: await startWorkflow(internals, type, input, options, undefined, callbacks),
      outcome: 'started',
    };
  } catch (error) {
    if (!(error instanceof WorkflowAlreadyExistsError)) {
      throw error;
    }
    // A concurrent caller-`id` winner created the run first; we converge onto and
    // signal it (or `undefined` to retry if the winner aborted) → 'signalled'.
    const resolved = await resolveCallerIdWinnerOrRetry(
      internals,
      error.workflowId,
      signalSpec,
      signalId,
      callbacks,
    );
    return resolved === undefined ? undefined : { handle: resolved, outcome: 'signalled' };
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
 *   condition (the signal's `sigres:` accepted-response marker) failed because a
 *   signal with the same signalId was pre-buffered, so no record was written and
 *   the workflow must still be created.
 *
 * The keyed path's create batch uses a freshly generated workflow id, so its
 * signal `sigres:` condition cannot collide with a pre-buffered signal; a keyed
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
      // Caller-id path: the only CAS condition was the signal's `sigres:` marker,
      // so this is a pre-buffered signal of the same signalId, not a concurrent
      // winner — create the workflow.
      return { kind: 'signal-already-buffered' };
    }
    throw error;
  }
}
