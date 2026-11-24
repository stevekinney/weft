import type { ContextOperationRequest } from '../context.ts';
import { branchDriversOf } from '../context/branch-driver.ts';
import {
  isParallelOperationCacheEntry,
  type ParallelBranchSlot,
} from '../context/parallel-cache-entry.ts';
import {
  executeRunAllBranches,
  executeRunAllBranchesSettled,
  type RunAllBranch,
  type RunAllBranchOutcome,
} from '../engine-helpers.ts';
import type { MidOperationCommitReport } from './checkpoint-io.ts';
import { createKeyedRaceResultEnvelope, finalizeAndUnwrap } from './deferred-consume-envelope.ts';
import {
  requestCompletion,
  stageCoordinatorCompletion,
  type SettledRequestCompletion,
} from './file-workflow-completion-events.ts';
import { HeldSideEffects } from './held-side-effects.ts';
import type { EngineInternals } from './internals.ts';
import {
  executeActivityOperationResult as executeActivityOperationResultFromInternals,
  type ActivityFunctionWithMetadata,
  type ActivityOperationCallbacks,
} from './operations-activity.ts';
import { processAdvancingParallelOperation } from './operations-advancing-parallel.ts';
import type { OperationWithCallerStack } from './operations-router.ts';
import {
  buildEntryFromSlots,
  dispatchBranchesAllSettled,
  valuesFromSlots,
  type OnSlotSettled,
} from './parallel-dispatch.ts';
import { canPersistPartialEntry, writePartialEntry } from './partial-entry.ts';
import { takeSettledSteps } from './settled-step-sink.ts';
import { captureSideEffects } from './side-effect-capture.ts';
import { assertSupportedSignalBranches } from './signal-branch-guard.ts';
import { settleSignalWaitClears } from './signal-wait-tracking.ts';
import { peekSignal } from './signals.ts';
import type { SpeculativeExecutionState } from './speculative-execution-state.ts';
import { callActivityFunction } from './state-utilities.ts';
import { isCurrentOperation, workflowExecutionTokenForWorkflow } from './strategy-helpers.ts';
import {
  parallelTimelineDetails,
  raceTimelineDetails,
  recordTimelineBranches,
  runAllTimelineDetails,
} from './timeline-coordinator-detail.ts';

type WaitSignalOperation = Extract<ContextOperationRequest, { type: 'wait-signal' }>;
type ParallelOperation = Extract<ContextOperationRequest, { type: 'parallel' }>;
type RaceOperation = Extract<ContextOperationRequest, { type: 'race' }>;
type RunAllOperation = Extract<ContextOperationRequest, { type: 'run-all' }>;

export type CoordinationOperationCallbacks = {
  completeOperation: (
    workflowId: string,
    value: unknown,
    operationId: string,
    workflowExecutionToken?: string,
  ) => void;
  failOperation: (
    workflowId: string,
    operation: OperationWithCallerStack,
    error: unknown,
    workflowExecutionToken?: string,
  ) => void;
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
  /**
   * Commit a checkpoint while the coordinator is still running, keeping its pending timeline
   * entry, and report the named branch activities as completed. Absent where a coordinator has no
   * way to commit mid-operation, which keeps the whole result until every branch has settled.
   */
  persistCheckpoint?: (
    workflowId: string,
    operation: ContextOperationRequest,
    report?: MidOperationCommitReport,
  ) => Promise<void>;
};

/**
 * Commits each `ctx.all` branch that settles before its siblings, so a branch that finished is not
 * run again when the workflow recovers while a sibling still waits. A slot commits only when a
 * sibling is still pending: the last branch to settle belongs to the operation's own result.
 *
 * A commit finalizes the slot's deferred signal consume first, into the committer's own hold (see
 * `held-side-effects.ts`), and writes the held consumes with the entry that records the slot: the
 * slot and the delete of its signal record land together. What the branch's operation staged for
 * the checkpoint (a child's cancellation link, an activity's reconciliation receipt) is caught as
 * it runs (`side-effect-capture.ts`) and lands in that commit too; the commit writes nothing a
 * branch still running staged. What the committer still holds when the branches settle goes to the
 * staged buffer, for the commit that settles the operation.
 * Commits are chained: each one compares-and-swaps against the checkpoint bytes the one before it
 * wrote, so two overlapping would make the second a conflict and abandon the run.
 */
function createSlotCommitter(
  internals: EngineInternals,
  workflowId: string,
  operation: ParallelOperation,
  persistCheckpoint: CoordinationOperationCallbacks['persistCheckpoint'],
  resumedSlots: readonly ParallelBranchSlot[] | undefined,
):
  | {
      /** Run branch `index`, catching what it stages for the commit of its slot. */
      execute: (index: number, execute: () => Promise<unknown>) => Promise<unknown>;
      onSlotSettled: OnSlotSettled;
      /** Call once every slot has settled: hands on what is held, and reports a failed commit. */
      settle: () => { error: unknown } | undefined;
    }
  | undefined {
  if (persistCheckpoint === undefined) return undefined;
  const workflowExecutionToken = workflowExecutionTokenForWorkflow(internals, workflowId);
  const variant = operation.settle === 'settled' ? 'all-settled' : 'all';
  const committed = new Set<number>(
    (resumedSlots ?? []).flatMap((slot, index) => (slot.status === 'fulfilled' ? [index] : [])),
  );
  const held = new HeldSideEffects();
  /** What each branch staged (`side-effect-capture.ts`), until its slot's commit takes it. */
  const staged = operation.operations.map(() => new HeldSideEffects());
  let chain: Promise<void> = Promise.resolve();
  let failure: { error: unknown } | undefined;
  const isCurrent = () =>
    isCurrentOperation(internals, workflowId, operation.operationId, workflowExecutionToken);
  const commitSlot = async (slots: readonly ParallelBranchSlot[], index: number) => {
    const slot = slots[index];
    if (failure !== undefined || slot?.status !== 'fulfilled') return;
    if (!slots.some((other) => other.status === 'pending')) return;
    if (!canPersistPartialEntry(internals, workflowId) || !isCurrent()) return;
    try {
      slot.value = await finalizeAndUnwrap(slot.value, held.hold);
      if (!isCurrent()) return;
      committed.add(index);
      staged[index]?.moveTo(held);
      // A settled branch whose own commit is still queued is not durable yet, and its value may
      // still hold an envelope that cannot encode: it stays pending in this entry.
      const snapshot = slots.map((other, otherIndex): ParallelBranchSlot => {
        if (other.status === 'fulfilled') {
          return committed.has(otherIndex)
            ? { ...other }
            : { status: 'pending', operationId: other.operationId };
        }
        return { ...other };
      });
      writePartialEntry(
        internals,
        workflowId,
        operation.step,
        buildEntryFromSlots(variant, snapshot),
      );
      await held.commitWith((sideEffects) =>
        persistCheckpoint(workflowId, operation, {
          settledBranchOperationIds: [slot.operationId],
          sideEffects,
        }),
      );
    } catch (error) {
      failure = { error };
    }
  };
  return {
    execute: async (index, execute) => {
      const endCapture = captureSideEffects(operation.operations[index]!, staged[index]!.keep);
      try {
        return await execute();
      } finally {
        endCapture();
      }
    },
    onSlotSettled: (slots, index) => {
      chain = chain.then(() => commitSlot(slots, index));
      return chain;
    },
    settle: () => {
      for (const branch of staged) branch.moveTo(held);
      held.stageRemaining(internals, workflowId);
      return failure;
    },
  };
}

/** How each branch of a `ctx.all` runs: through the slot committer, when it commits slots. */
function branchRunner(
  callbacks: Pick<CoordinationOperationCallbacks, 'executeSubOperation'>,
  workflowId: string,
  operation: ParallelOperation,
  committer: ReturnType<typeof createSlotCommitter>,
): (index: number) => Promise<unknown> {
  const execute = (index: number) =>
    callbacks.executeSubOperation(workflowId, operation.operations[index]!);
  if (committer === undefined) return execute;
  return (index) => committer.execute(index, () => execute(index));
}

/**
 * Hold what the branches that fulfilled completed, at any depth, for the commit that settles this
 * operation, which reports it in place of the first-level branch details the timeline entry keeps:
 * a document step nested in a branch (a `map` or `parallel` inside a `parallel`, a `map` inside a
 * `map`) completes as a step at the top level does.
 */
function stageSettledBranchCompletions(
  internals: EngineInternals,
  workflowId: string,
  operation: ParallelOperation,
  slots: readonly ParallelBranchSlot[],
  settled: SettledRequestCompletion,
): void {
  const entry = internals.pendingTimelineEntries?.get(workflowId)?.entry;
  if (entry === undefined) return;
  for (const [index, child] of operation.operations.entries()) {
    const slot = slots[index];
    if (slot?.status !== 'fulfilled') continue;
    // Only the events: the activity completions a coordinator reports stay those of its own
    // branches, which its timeline entry names.
    settled.events.push(...requestCompletion(child, slot.value).events);
  }
  stageCoordinatorCompletion(entry, settled);
}

export async function processParallelOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: ParallelOperation,
  callbacks: Pick<
    CoordinationOperationCallbacks,
    'executeSubOperation' | 'runOperationWithResult' | 'persistCheckpoint'
  >,
): Promise<void> {
  const drivers = branchDriversOf(operation);
  if (drivers !== undefined) {
    return processAdvancingParallelOperation(internals, workflowId, operation, drivers, callbacks);
  }
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
    const slotCommitter = createSlotCommitter(
      internals,
      workflowId,
      operation,
      callbacks.persistCheckpoint,
      resumedSlots,
    );
    const { slots, hasFirstError, firstError } = await dispatchBranchesAllSettled(
      operationIds,
      resumedSlots,
      // Branches return their RAW result (a wait-signal envelope stays unfinalized)
      // so the slot committer, or `finalizeFulfilledSlots` below once every branch has
      // settled, is the only place a durable signal is consumed: the consume goes into
      // the same batch that checkpoints the slot or the whole result.
      branchRunner(callbacks, workflowId, operation, slotCommitter),
      slotCommitter?.onSlotSettled,
    );
    // What an advancing parallel step nested in a branch settled reports here, whatever follows.
    const nestedCompletion = takeSettledSteps(internals, workflowId);
    // Every slot is in `slots` now: the commit that settles the operation writes what the
    // committer still holds. A slot commit that failed means a branch's result and its signal
    // consume never became durable: fail the operation the way a failed checkpoint write fails it.
    const slotCommitFailure = slotCommitter?.settle();
    if (slotCommitFailure !== undefined) throw slotCommitFailure.error;

    // On the failure path, decide whether this execution mode can persist the
    // partial entry BEFORE finalizing — and throw the "unsupported" error first
    // if it cannot. `assertPartialFailurePersistenceSupported` only throws when
    // the partial cannot be written yet a fulfilled slot exists, so a worker-mode
    // `ctx.all` with a fulfilled wait-signal branch is destined to throw. Running
    // the check here, ahead of `finalizeFulfilledSlots`, means that doomed
    // operation never consumes a durable signal it could never checkpoint.
    // `canPersistPartialEntry` is finalize-independent and side-effect-free, so
    // probing it early does not perturb the slots.
    if (hasFirstError && operation.settle !== 'settled') {
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

    const entry = buildEntryFromSlots(
      operation.settle === 'settled' ? 'all-settled' : 'all',
      slots,
    );
    writePartialEntry(internals, workflowId, operation.step, entry);
    recordTimelineBranches(
      internals,
      workflowId,
      parallelTimelineDetails(operation.operations, slots),
    );
    stageSettledBranchCompletions(internals, workflowId, operation, slots, nestedCompletion);

    if (hasFirstError && operation.settle !== 'settled') {
      // Rethrow the original reason as-is (could be a string, number,
      // undefined, or any non-Error value) to mirror Promise.all.
      throw firstError;
    }
    return operation.settle === 'settled' ? settledOutcomes(slots) : valuesFromSlots(slots);
  });
}

/** The ordered outcomes `ctx.allSettled` returns: each branch's value, or why it did not settle. */
function settledOutcomes(slots: readonly ParallelBranchSlot[]): unknown[] {
  return slots.map((slot) => {
    if (slot.status === 'fulfilled') return { status: 'fulfilled', value: slot.value };
    return {
      status: 'rejected',
      reason:
        slot.status === 'rejected'
          ? slot.reason
          : { name: 'UnsettledBranch', message: 'Branch did not settle' },
    };
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
  internals: EngineInternals,
  workflowId: string,
  operation: RaceOperation,
  callbacks: Pick<CoordinationOperationCallbacks, 'executeSubOperation' | 'runOperationWithResult'>,
): Promise<void> {
  return callbacks.runOperationWithResult(workflowId, operation, async () => {
    assertSupportedSignalBranches(operation.operations);
    assertValidRaceBranchNames(operation);
    let winnerIndex: number | undefined;
    let winnerError: unknown;
    try {
      const winner = await executeRaceSubOperations(
        internals,
        workflowId,
        operation.operations,
        (subOperation, signal) => callbacks.executeSubOperation(workflowId, subOperation, signal),
        undefined,
        (selectedIndex, value) => wrapRaceWinner(operation, selectedIndex, value),
        (selectedIndex, error) => {
          winnerIndex = selectedIndex;
          winnerError = error;
        },
      );
      // Finalize-and-unwrap the winner: a winning wait-signal branch resolves with
      // a deferred-consume envelope, and this is the linearization point of "this
      // branch won", so consuming here (after the race settles, before the result
      // reaches the durable cache) deletes the signal exactly once and only for the
      // winner. Losers' envelopes are dropped unfinalized.
      try {
        return await finalizeAndUnwrap(winner);
      } catch (error) {
        winnerError = error;
        throw error;
      }
    } finally {
      if (winnerIndex !== undefined) {
        recordTimelineBranches(
          internals,
          workflowId,
          raceTimelineDetails(
            operation.operations,
            winnerIndex,
            operation.branchNames,
            winnerError,
          ),
        );
      }
    }
  });
}

export function assertValidRaceBranchNames(operation: RaceOperation): void {
  if (
    operation.branchNames !== undefined &&
    operation.branchNames.length !== operation.operations.length
  ) {
    throw new Error('ctx.raceKeyed branch names must match its operation count');
  }
}

export function wrapRaceWinner(
  operation: RaceOperation,
  winnerIndex: number,
  value: unknown,
): unknown {
  const key = operation.branchNames?.[winnerIndex];
  return key === undefined ? value : createKeyedRaceResultEnvelope(key, value);
}

/**
 * Execute race branches while giving an already-buffered signal priority over a
 * literal zero-duration sleep. The preflight is non-destructive: the selected
 * wait-signal branch still returns its deferred-consume envelope, so the owning
 * coordinator remains the only place that consumes the durable record.
 *
 * Positive-duration sleeps deliberately bypass this preflight, including when
 * their deadline becomes past-due before dispatch. That keeps ordinary timeout
 * races on the existing Promise.race path and limits the stronger ordering
 * guarantee to the explicit non-blocking-drain idiom.
 */
type RaceSettlement =
  | { index: number; status: 'fulfilled'; value: unknown }
  | { error: unknown; index: number; status: 'rejected' };

type RaceWinnerObservers = {
  observeWinner?: (winnerIndex: number, error?: unknown) => void;
  wrapWinner?: (winnerIndex: number, value: unknown) => unknown;
};

function createRaceWinnerObservers(
  wrapWinner: RaceWinnerObservers['wrapWinner'],
  observeWinner: RaceWinnerObservers['observeWinner'],
): RaceWinnerObservers {
  const observers: RaceWinnerObservers = {};
  if (wrapWinner !== undefined) observers.wrapWinner = wrapWinner;
  if (observeWinner !== undefined) observers.observeWinner = observeWinner;
  return observers;
}

async function settleRaceBranch(
  operation: ContextOperationRequest,
  index: number,
  signal: AbortSignal,
  execute: (operation: ContextOperationRequest, signal: AbortSignal) => Promise<unknown>,
): Promise<RaceSettlement> {
  try {
    return { index, status: 'fulfilled', value: await execute(operation, signal) };
  } catch (error) {
    return { error, index, status: 'rejected' };
  }
}

function resolveRaceSettlement(
  settlement: RaceSettlement,
  observers: RaceWinnerObservers,
): unknown {
  if (settlement.status === 'rejected') {
    observers.observeWinner?.(settlement.index, settlement.error);
    throw settlement.error;
  }
  observers.observeWinner?.(settlement.index);
  return observers.wrapWinner === undefined
    ? settlement.value
    : observers.wrapWinner(settlement.index, settlement.value);
}

async function executeBufferedRaceWinner(
  bufferedSignal: { index: number; operation: WaitSignalOperation },
  signal: AbortSignal,
  execute: (operation: ContextOperationRequest, signal: AbortSignal) => Promise<unknown>,
  observers: RaceWinnerObservers,
): Promise<unknown> {
  const settlement = await settleRaceBranch(
    bufferedSignal.operation,
    bufferedSignal.index,
    signal,
    execute,
  );
  return resolveRaceSettlement(settlement, observers);
}

export async function executeRaceSubOperations(
  internals: EngineInternals,
  workflowId: string,
  operations: readonly ContextOperationRequest[],
  execute: (operation: ContextOperationRequest, signal: AbortSignal) => Promise<unknown>,
  parentSignal?: AbortSignal,
  wrapWinner?: (winnerIndex: number, value: unknown) => unknown,
  observeWinner?: (winnerIndex: number, error?: unknown) => void,
): Promise<unknown> {
  parentSignal?.throwIfAborted();

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  const observers = createRaceWinnerObservers(wrapWinner, observeWinner);
  parentSignal?.addEventListener('abort', abortFromParent, { once: true });

  try {
    const bufferedSignal = await findBufferedSignalDrainBranch(internals, workflowId, operations);
    parentSignal?.throwIfAborted();

    if (bufferedSignal !== undefined) {
      return await executeBufferedRaceWinner(bufferedSignal, controller.signal, execute, observers);
    }

    const subOperations = operations.map((operation, index) =>
      settleRaceBranch(operation, index, controller.signal, execute),
    );
    // Swallow rejections from losing branches — only the race winner's result
    // (or error) is surfaced. Losers usually reject after the controller aborts.
    void Promise.allSettled(subOperations);
    const winner = await Promise.race(subOperations);
    return resolveRaceSettlement(winner, observers);
  } finally {
    parentSignal?.removeEventListener('abort', abortFromParent);
    // Abort losers before the owning coordinator finalizes a signal envelope.
    controller.abort();
    // A wait that lost clears itself from the durable list in a write of its own. Settle it before
    // the race does, so a reader told the race's operation settled finds the list without the wait.
    const clearing = settleSignalWaitClears(internals, workflowId);
    if (clearing !== undefined) await clearing;
  }
}

async function findBufferedSignalDrainBranch(
  internals: EngineInternals,
  workflowId: string,
  operations: readonly ContextOperationRequest[],
): Promise<{ index: number; operation: WaitSignalOperation } | undefined> {
  if (operations.length !== 2) {
    return undefined;
  }

  const waitSignalOperation = operations.find(
    (operation): operation is WaitSignalOperation => operation.type === 'wait-signal',
  );
  const zeroDurationSleep = operations.find(
    (operation) => operation.type === 'sleep' && operation.duration === 0,
  );
  if (waitSignalOperation === undefined || zeroDurationSleep === undefined) {
    return undefined;
  }

  const bufferedSignal = await peekSignal(internals, workflowId, waitSignalOperation.signalName);
  if (!bufferedSignal.found) return undefined;
  return { index: operations.indexOf(waitSignalOperation), operation: waitSignalOperation };
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
    recordTimelineBranches(
      internals,
      workflowId,
      runAllTimelineDetails(branchNames, slots, operation.branches),
    );

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
  return executeRunAllBranches(operation.branches, (fn, input) => {
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
  });
}
