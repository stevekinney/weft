import type { ContextOperationRequest } from '../context.ts';
import {
  isParallelOperationCacheEntry,
  type ParallelBranchSlot,
  type ParallelOperationCacheEntry,
} from '../context/parallel-operations.ts';
import {
  executeRunAllBranches,
  executeRunAllBranchesSettled,
  type RunAllBranch,
  type RunAllBranchOutcome,
} from '../engine-helpers.ts';
import { finalizeAndUnwrap } from './deferred-consume-envelope.ts';
import type { EngineInternals } from './internals.ts';
import {
  executeActivityOperationResult as executeActivityOperationResultFromInternals,
  type ActivityFunctionWithMetadata,
  type ActivityOperationCallbacks,
} from './operations-activity.ts';
import type { OperationWithCallerStack } from './operations-router.ts';
import {
  buildEntryFromSlots,
  dispatchBranchesAllSettled,
  valuesFromSlots,
} from './parallel-dispatch.ts';
import {
  consumeSignalWithAtomicWorkflowCommit,
  trackWaiterKey,
  untrackWaiterKey,
} from './signals.ts';
import type { SpeculativeExecutionState } from './speculative-execution-state.ts';
import { callActivityFunction } from './state-utilities.ts';

type WaitSignalOperation = Extract<ContextOperationRequest, { type: 'wait-signal' }>;
type ParallelOperation = Extract<ContextOperationRequest, { type: 'parallel' }>;
type RaceOperation = Extract<ContextOperationRequest, { type: 'race' }>;
type RunAllOperation = Extract<ContextOperationRequest, { type: 'run-all' }>;

/**
 * Reject a `ctx.race` / `ctx.all` whose branches wait on the SAME signal name,
 * recursively through nested `race` / `parallel` branches. Sibling wait-signal
 * branches share the `${workflowId}:${signalName}` waiter key, so two anywhere in
 * the coordination tree would clobber each other at registration, leaving one
 * branch permanently unreachable (the run would hang). Reject the meaningless
 * shape deterministically rather than silently dropping a branch. Distinct names
 * (the event-or-close idiom) are unaffected.
 */
export function assertSupportedSignalBranches(
  operations: readonly ContextOperationRequest[],
): void {
  const seen = new Set<string>();
  const walk = (subOperations: readonly ContextOperationRequest[]): void => {
    for (const subOperation of subOperations) {
      if (subOperation.type === 'wait-signal') {
        if (seen.has(subOperation.signalName)) {
          throw new Error(
            `ctx.race / ctx.all cannot have two branches waiting on the same signal "${subOperation.signalName}": ` +
              'sibling wait-signal branches share one waiter and would clobber each other. ' +
              'Wait on the signal once, or use distinct signal names.',
          );
        }
        seen.add(subOperation.signalName);
      } else if (subOperation.type === 'race' || subOperation.type === 'parallel') {
        walk(subOperation.operations);
      }
    }
  };
  walk(operations);
}

export type CoordinationOperationCallbacks = {
  completeOperation: (workflowId: string, value: unknown) => void;
  runOperationWithResult: (
    workflowId: string,
    operation: OperationWithCallerStack,
    execute: () => Promise<unknown>,
  ) => Promise<void>;
  executeSubOperation: (
    workflowId: string,
    operation: ContextOperationRequest,
    signal?: AbortSignal,
    speculativeState?: SpeculativeExecutionState,
  ) => Promise<unknown>;
  getActivityOperationCallbacks: () => ActivityOperationCallbacks;
};

export async function processWaitSignalOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: WaitSignalOperation,
  callbacks: Pick<CoordinationOperationCallbacks, 'completeOperation'>,
): Promise<void> {
  const abortSignal = internals.abortController.signal;
  const waiterKey = `${workflowId}:${operation.signalName}`;

  while (true) {
    if (abortSignal.aborted) {
      return;
    }

    const existingPayload = await consumeSignalWithAtomicWorkflowCommit(
      internals,
      workflowId,
      operation.signalName,
    );
    if (existingPayload.found) {
      callbacks.completeOperation(workflowId, existingPayload.payload);
      return;
    }

    const { promise, resolve } = Promise.withResolvers<void>();
    internals.signalWaiters.set(waiterKey, resolve);
    trackWaiterKey(internals.signalWaitersByWorkflow, workflowId, waiterKey);

    if (abortSignal.aborted) {
      internals.signalWaiters.delete(waiterKey);
      untrackWaiterKey(internals.signalWaitersByWorkflow, workflowId, waiterKey);
      return;
    }

    const bufferedPayload = await consumeSignalWithAtomicWorkflowCommit(
      internals,
      workflowId,
      operation.signalName,
    );
    if (bufferedPayload.found) {
      if (internals.signalWaiters.get(waiterKey) === resolve) {
        internals.signalWaiters.delete(waiterKey);
        untrackWaiterKey(internals.signalWaitersByWorkflow, workflowId, waiterKey);
      }
      callbacks.completeOperation(workflowId, bufferedPayload.payload);
      return;
    }

    await promise;

    if (abortSignal.aborted) {
      return;
    }
  }
}

export async function processParallelOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: ParallelOperation,
  callbacks: Pick<CoordinationOperationCallbacks, 'executeSubOperation' | 'runOperationWithResult'>,
): Promise<void> {
  // `ctx.all()` awaits every branch, so there's no "loser" to abort like
  // there is for `ctx.race()`. Each sub-operation runs to completion or
  // throws. We use `Promise.allSettled` semantics so successful branches'
  // results can be persisted to the parent's cache entry before any
  // rejection propagates — on retry, fulfilled branches are reused
  // instead of re-running, which fixes the duplicate-side-effects bug
  // when one branch in `ctx.all` fails.
  return callbacks.runOperationWithResult(workflowId, operation, async () => {
    assertSupportedSignalBranches(operation.operations);
    const resumedSlots = extractResumedSlots(operation.resumedCacheEntry);
    const operationIds = operation.operations.map((sub, i) =>
      typeof sub.operationId === 'string' ? sub.operationId : `parallel:${operation.step}:${i}`,
    );
    const { slots, hasFirstError, firstError } = await dispatchBranchesAllSettled(
      operationIds,
      resumedSlots,
      // Branches return their RAW result (a wait-signal envelope stays unfinalized)
      // so a fast wait-signal does not consume its durable signal while `ctx.all`
      // is still waiting for slower siblings — that would open a wait-for-siblings
      // window where the signal is gone but the `all` result is not yet
      // checkpointed. Finalization is deferred to `finalizeFulfilledSlots` below,
      // after every branch has settled.
      (index) => callbacks.executeSubOperation(workflowId, operation.operations[index]!),
    );

    // On the failure path, decide whether this execution mode can persist the
    // partial entry BEFORE finalizing — and throw the "unsupported" error first
    // if it cannot. `assertPartialFailurePersistenceSupported` only throws when
    // the partial cannot be written yet a fulfilled slot exists, so a worker-mode
    // `ctx.all` with a fulfilled wait-signal branch is destined to throw. Running
    // the check here, ahead of `finalizeFulfilledSlots`, means that doomed
    // operation never consumes a durable signal it could never checkpoint.
    // `canPersistPartialEntry` is finalize-independent and side-effect-free, so
    // probing it early does not perturb the slots.
    if (hasFirstError) {
      assertPartialFailurePersistenceSupported(
        canPersistPartialEntry(internals, workflowId),
        slots,
        'ctx.all',
        'worker execution mode',
      );
    }

    // Now that all branches have settled (and any unsupported worker-mode failure
    // has already thrown without consuming), finalize the fulfilled wait-signal
    // envelopes (and envelopes nested inside a coordinator array result) in place,
    // immediately before the cache entry is built. This keeps envelopes — which
    // carry a function and cannot encode — out of the durable cache, and shrinks
    // the consume-vs-checkpoint window to the same adjacency the top-level signal
    // path already has.
    await finalizeFulfilledSlots(slots);

    const entry = buildEntryFromSlots('all', slots);
    writePartialEntry(internals, workflowId, operation.step, entry);

    if (hasFirstError) {
      // Rethrow the original reason as-is (could be a string, number,
      // undefined, or any non-Error value) to mirror Promise.all.
      throw firstError;
    }
    return valuesFromSlots(slots);
  });
}

/**
 * Finalize-and-unwrap the value of every fulfilled slot in place, after all
 * `ctx.all` branches have settled. A fulfilled wait-signal branch's value is a
 * deferred-consume envelope (or an array holding one, from a nested coordinator);
 * `finalizeAndUnwrap` is idempotent on non-envelope values, so resumed/decoded
 * slots pass through untouched. Finalizing here — rather than as each branch
 * settles — avoids consuming a fast signal while slower siblings are still
 * pending, keeping the durable signal alive until the operation is about to
 * checkpoint.
 *
 * Uses `allSettled` rather than `Promise.all` so that EVERY finalizer completes
 * before this returns or throws: a `Promise.all` reject on the first finalize
 * failure would leave sibling `consumeSignal` deletions running in the background
 * after the operation has already exited, mutating durable state for an operation
 * that will never checkpoint. The first finalization error (if any) is re-thrown
 * only after all consumes have stopped.
 */
async function finalizeFulfilledSlots(slots: ParallelBranchSlot[]): Promise<void> {
  const outcomes = await Promise.allSettled(
    slots.map(async (slot) => {
      if (slot.status === 'fulfilled') {
        slot.value = await finalizeAndUnwrap(slot.value);
      }
    }),
  );
  const failure = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failure) {
    throw failure.reason;
  }
}

/** Pull resumed slots out of an opaque cache entry, validating the shape. */
function extractResumedSlots(resumedCacheEntry: unknown): ParallelBranchSlot[] | undefined {
  if (!isParallelOperationCacheEntry(resumedCacheEntry)) return undefined;
  return resumedCacheEntry.branches;
}

/**
 * Whether the current execution mode can persist a partial cache entry for this
 * workflow. Only the inline strategy exposes a context whose `accumulatedResults`
 * the next checkpoint flushes; worker mode has no inline context, so a partial
 * entry can never be written there. This read is side-effect-free, so it is safe
 * to probe on the failure path BEFORE finalizing — letting an unsupported
 * worker-mode `ctx.all` throw without first consuming a durable signal.
 */
function canPersistPartialEntry(internals: EngineInternals, workflowId: string): boolean {
  return internals.inlineStrategy?.getContext(workflowId) !== undefined;
}

/**
 * Mutate the workflow's `accumulatedResults` map in place at the given
 * step. The next checkpoint write — triggered by the workflow's next
 * yield — will persist the partial entry. If the workflow throws and
 * fails before yielding again, the partial entry is lost; users with
 * externally visible side effects must still use idempotency keys for
 * activities inside `ctx.all`.
 */
function writePartialEntry(
  internals: EngineInternals,
  workflowId: string,
  step: number,
  entry: ParallelOperationCacheEntry,
): boolean {
  const context = internals.inlineStrategy?.getContext(workflowId);
  if (context === undefined) return false;
  context.accumulatedResults.set(step, entry);
  return true;
}

function assertPartialFailurePersistenceSupported(
  partialEntryWritten: boolean,
  slots: ParallelBranchSlot[],
  operationName: 'ctx.all' | 'ctx.runAll',
  executionMode: string,
): void {
  if (partialEntryWritten || !slots.some((slot) => slot.status === 'fulfilled')) {
    return;
  }
  throw new Error(
    `${operationName} partial-failure preservation is not supported in ${executionMode}: ` +
      `the engine cannot persist fulfilled branch slots after a sibling branch fails. ` +
      `Run the workflow inline or make branch side effects idempotent.`,
  );
}

export async function processRaceOperation(
  _internals: EngineInternals,
  workflowId: string,
  operation: RaceOperation,
  callbacks: Pick<CoordinationOperationCallbacks, 'executeSubOperation' | 'runOperationWithResult'>,
): Promise<void> {
  return callbacks.runOperationWithResult(workflowId, operation, async () => {
    assertSupportedSignalBranches(operation.operations);
    // Abort losing sub-operations once the race settles so background work does
    // not keep consuming budget or emit events with no observer.
    const controller = new AbortController();
    const subOperations = operation.operations.map((subOperation) =>
      callbacks.executeSubOperation(workflowId, subOperation, controller.signal),
    );
    // Swallow rejections from losing branches — only the race winner's
    // result (or error) is surfaced. Losers typically reject with
    // AbortError after the controller fires in the finally block, and
    // without a handler those would surface as unhandled promise
    // rejections.
    void Promise.allSettled(subOperations);
    let winner: unknown;
    try {
      winner = await Promise.race(subOperations);
    } finally {
      // Abort losers as soon as the race settles — BEFORE the (possibly slow)
      // finalize below — so background work does not keep running, consuming
      // budget, or emitting events with no observer while the winner's signal is
      // consumed. The winning branch has already settled, so aborting cannot
      // un-resolve it or disturb its deferred-consume envelope.
      controller.abort();
    }
    // Finalize-and-unwrap the winner: a winning wait-signal branch resolves with
    // a deferred-consume envelope, and this is the linearization point of "this
    // branch won", so consuming here (after the race settles, before the result
    // reaches the durable cache) deletes the signal exactly once and only for the
    // winner. Losers' envelopes are dropped unfinalized.
    return finalizeAndUnwrap(winner);
  });
}

export async function processRunAllOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: RunAllOperation,
  callbacks: Pick<CoordinationOperationCallbacks, 'runOperationWithResult'>,
): Promise<void> {
  return callbacks.runOperationWithResult(workflowId, operation, async () => {
    const branchNames = Object.keys(operation.branches);
    const operationIds = branchNames.map((name) => `run-all:${operation.step}:${name}`);
    const resumedSlots = extractResumedSlots(operation.resumedCacheEntry);
    const resumedSlotsByName = mapResumedSlotsByName(resumedSlots, branchNames);

    const branchesToRun = filterBranchesToRun(operation.branches, branchNames, resumedSlotsByName);

    // Dispatch through the existing run-all helper shape so callers that
    // reuse it keep matching semantics. The settled variant returns
    // per-branch outcomes plus the first rejection by settlement timing,
    // matching `Promise.all`'s rethrow-as-is contract.
    const { outcomes, hasFirstError, firstError } = await executeRunAllBranchesSettled(
      branchesToRun,
      (fn, input) => callActivityFunction(fn, input),
    );

    const slots = mergeRunAllSlots(branchNames, operationIds, resumedSlotsByName, outcomes);

    const entry = buildEntryFromSlots('run-all', slots, branchNames);
    const partialEntryWritten = writePartialEntry(internals, workflowId, operation.step, entry);

    if (hasFirstError) {
      assertPartialFailurePersistenceSupported(
        partialEntryWritten,
        slots,
        'ctx.runAll',
        'worker execution mode',
      );
      // Rethrow the original reason as-is to mirror Promise.all semantics
      // for non-Error throws.
      throw firstError;
    }

    return reconstructRunAllRecord(branchNames, slots);
  });
}

/** Drop fulfilled-on-resume branches so we only re-dispatch the rest. */
function filterBranchesToRun(
  branches: Record<string, RunAllBranch>,
  branchNames: string[],
  resumedSlotsByName: Map<string, ParallelBranchSlot> | undefined,
): Record<string, RunAllBranch> {
  const result: Record<string, RunAllBranch> = {};
  for (const name of branchNames) {
    if (resumedSlotsByName?.get(name)?.status !== 'fulfilled') {
      const branch = branches[name];
      if (branch !== undefined) result[name] = branch;
    }
  }
  return result;
}

/** Merge resumed slots with fresh outcomes into the final slot table. */
function mergeRunAllSlots(
  branchNames: string[],
  operationIds: string[],
  resumedSlotsByName: Map<string, ParallelBranchSlot> | undefined,
  outcomes: RunAllBranchOutcome[],
): ParallelBranchSlot[] {
  // Index outcomes by name once so per-branch lookup is O(1) instead of
  // O(n) per branch (which would make this O(n^2) overall — fine for a
  // few branches but unnecessary work for runAll with many).
  const outcomesByName = new Map<string, RunAllBranchOutcome>();
  for (const outcome of outcomes) {
    outcomesByName.set(outcome.name, outcome);
  }
  return branchNames.map((name, i) => {
    const operationId = operationIds[i]!;
    const resumed = resumedSlotsByName?.get(name);
    if (resumed?.status === 'fulfilled') {
      return resumed;
    }
    const outcome = outcomesByName.get(name)!;
    if (outcome.status === 'fulfilled') {
      return { status: 'fulfilled', value: outcome.value, operationId };
    }
    const reasonError =
      outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason));
    return {
      status: 'rejected',
      reason: { name: reasonError.name, message: reasonError.message },
      operationId,
    };
  });
}

/** Reconstruct the name-keyed result from the final slot table. */
function reconstructRunAllRecord(
  branchNames: string[],
  slots: ParallelBranchSlot[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (let i = 0; i < branchNames.length; i++) {
    const slot = slots[i];
    if (slot?.status === 'fulfilled') {
      result[branchNames[i]!] = slot.value;
    }
  }
  return result;
}

/** Index resumed branch slots by their corresponding branch name. */
function mapResumedSlotsByName(
  resumedSlots: ParallelBranchSlot[] | undefined,
  branchNames: string[],
): Map<string, ParallelBranchSlot> | undefined {
  if (resumedSlots === undefined) return undefined;
  const result = new Map<string, ParallelBranchSlot>();
  for (let i = 0; i < branchNames.length; i++) {
    const name = branchNames[i];
    const slot = resumedSlots[i];
    if (name !== undefined && slot !== undefined) {
      result.set(name, slot);
    }
  }
  return result;
}

export function isConfiguredInlineActivity(
  fn: Function,
): fn is RunAllOperation['branches'][string][0] & ActivityFunctionWithMetadata {
  return typeof (fn as { execute?: unknown }).execute === 'function';
}

/**
 * Used by `executeSubOperation`'s `'run-all'` case (nested run-all inside
 * another sub-operation). Speculative-execution path retained for
 * `ctx.speculate` callers that need verification/compensation tracking.
 *
 * This path does NOT write a partial cache entry — it's only invoked for
 * nested run-alls whose results live inside the outer parent's slot. The
 * outer parent's partial-persistence handles durability.
 */
export async function executeRunAllOperationResult(
  internals: EngineInternals,
  workflowId: string,
  operation: RunAllOperation,
  callbacks: Pick<CoordinationOperationCallbacks, 'getActivityOperationCallbacks'>,
  speculativeState?: SpeculativeExecutionState,
): Promise<Record<string, unknown>> {
  return executeRunAllBranches(
    operation.branches as Parameters<typeof executeRunAllBranches>[0],
    (fn, input) => {
      // Only speculative runAll activity branches need the full execution
      // pipeline so verification and compensation tracking are preserved.
      if (!speculativeState || !isConfiguredInlineActivity(fn)) {
        return callActivityFunction(fn, input);
      }

      return executeActivityOperationResultFromInternals(
        internals,
        workflowId,
        {
          type: 'activity',
          operationId: crypto.randomUUID(),
          activityName: fn.name,
          fn,
          input,
        },
        callbacks.getActivityOperationCallbacks(),
        undefined,
        speculativeState,
      );
    },
  );
}
