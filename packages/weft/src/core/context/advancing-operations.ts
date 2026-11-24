/**
 * An advancing parallel step: `ctx.all` over branches that are sequences of operations, not single
 * ones. Each branch moves on as soon as its own current operation settles, without waiting for its
 * siblings' current operations, and a branch that finishes (or finishes a step) is committed
 * durably on its own, so a recovered run resumes every branch where it stopped.
 *
 * Every branch counts its own steps from zero in a scope of its own (see `branch-driver.ts`), so a
 * step's number does not depend on the order the branches settle in. The step's cache entry keeps,
 * for a branch that has not finished, the results of its steps so far; replaying them feeds the
 * branch back to where it stopped.
 *
 * @module context/advancing-operations
 */

import {
  attachBranchDrivers,
  settledBranchDriver,
  startBranchDriver,
  type BranchDriver,
} from './branch-driver.ts';
import type { Context } from './index.ts';
import {
  getInternals,
  hasContextInternals,
  stepStateKey,
  yieldOperation,
  type ContextInternals,
} from './internals.ts';
import type { ContextOperationRequest } from './operation-request.ts';
import {
  assertValidParallelOperationCacheEntry,
  BranchTopologyChangedError,
  createParallelOperationCacheEntry,
  isParallelOperationCacheEntry,
  type ParallelBranchSlot,
  type ParallelOperationCacheEntry,
} from './parallel-cache-entry.ts';
import { captureCallerStack } from './validation.ts';

/**
 * The slots a replay finds cached for the step, validated against the step it replays, or
 * `undefined` for a step that has none.
 */
function cachedSlots(
  cached: unknown,
  step: number,
  branchCount: number,
): readonly ParallelBranchSlot[] | undefined {
  assertValidParallelOperationCacheEntry(cached);
  if (!isParallelOperationCacheEntry(cached)) return undefined;
  if (cached.variant !== 'all') {
    throw new BranchTopologyChangedError(
      `A parallel step at step ${String(step)} found a cached entry of variant '${cached.variant}'. The same step must use the same parallel primitive across retries.`,
    );
  }
  if (cached.subOperationCount !== branchCount) {
    throw new BranchTopologyChangedError(
      `A parallel step's branch count changed across retry: expected ${String(cached.subOperationCount)}, got ${String(branchCount)}. Branch count must be deterministic.`,
    );
  }
  return cached.branches;
}

/** The cache entry of a step whose branches all finished with `values`. */
function finishedEntry(operationId: string, values: readonly unknown[]) {
  return createParallelOperationCacheEntry(
    'all',
    values.map((value, index): ParallelBranchSlot => ({
      status: 'fulfilled',
      value,
      operationId: `${operationId}:${String(index)}`,
    })),
    values.length,
  );
}

/** The operation id of the advancing parallel step at `step`, which its slots' ids extend. */
function operationIdAt(internals: ContextInternals, step: number): string {
  return `parallel:${stepStateKey(internals, step)}`;
}

/**
 * Whether `cached` is what an advancing parallel step of `branchCount` branches at `step` writes:
 * an `all` entry with one slot per branch, each slot named after the step. A run persisted before
 * branches advanced on their own holds the first result of its lockstep rounds there instead: a
 * plain value, the `race` winner of a timed wait, or the `all` entry of a `map` round, none of
 * whose slots carry this step's name.
 */
function isAdvancingEntry(
  cached: unknown,
  operationId: string,
  branchCount: number,
): cached is ParallelOperationCacheEntry {
  return (
    isParallelOperationCacheEntry(cached) &&
    cached.variant === 'all' &&
    cached.subOperationCount === branchCount &&
    cached.branches.length === branchCount &&
    cached.branches.every((slot, index) => slot.operationId === `${operationId}:${String(index)}`)
  );
}

/**
 * The checkpoint local that says a run began where parallel branches advance on their own. Every
 * run that begins now carries it from its first checkpoint, so its parallel steps advance whatever
 * the checkpoint happens to hold when one is recovered (a `map` round settled around a parallel
 * step nested in one of its items, say); a run persisted before has none.
 */
const ADVANCING_FORMAT_LOCAL = '__weftParallelBranchesAdvance';

/**
 * Mark the run `context` drives as one whose parallel branches advance on their own, when it has
 * recorded nothing yet: a run that begins now, or one persisted before that recorded no step, which
 * has nothing to finish the old way. Call it before the run's first operation; it yields nothing.
 */
export function markAdvancingRun(context: object): void {
  if (!hasContextInternals(context)) return;
  const internals = getInternals(context);
  if (internals.checkpointLocals[ADVANCING_FORMAT_LOCAL] === true) return;
  if ((internals.accumulatedResults?.size ?? 0) > 0) return;
  // Reassign rather than mutate in place: `checkpointLocals` is frozen between operations.
  internals.checkpointLocals = { ...internals.checkpointLocals, [ADVANCING_FORMAT_LOCAL]: true };
}

/**
 * Whether the step `context` numbers next can run as an advancing parallel step of `branchCount`
 * branches: it belongs to an inline run, no lockstep parallel step encloses it, and either the run
 * carries the mark of {@link markAdvancingRun} or, for a run persisted before, the step holds
 * nothing at or after its number. Such a run finishes a parallel step it began, and every parallel
 * step nested in it, in lockstep rounds (see the document `parallel` step): its rounds numbered
 * their operations through the shared counter from this step on, so once a round settled it holds
 * results at or after this number, though the step's own number may hold none (a branch that
 * failed there).
 */
export function canAdvanceBranches(context: object, branchCount: number): boolean {
  if (!hasContextInternals(context)) return false;
  const internals = getInternals(context);
  if (internals.lockstepDepth > 0) return false;
  if (internals.checkpointLocals[ADVANCING_FORMAT_LOCAL] === true) return true;
  const step = internals.stepIndex;
  const results = internals.accumulatedResults;
  if (results?.has(step) === true) {
    return isAdvancingEntry(results.get(step), operationIdAt(internals, step), branchCount);
  }
  return results === undefined || [...results.keys()].every((key) => key < step);
}

/**
 * Run `rounds`, the lockstep rounds of a parallel step a run began before branches advanced on
 * their own, so every parallel step nested in it runs in lockstep too: such a step was numbered
 * through the shared step counter, and there is no advancing step around it to commit it.
 */
export function* inLockstep<Result>(
  context: object,
  rounds: Generator<ContextOperationRequest, Result, unknown>,
): Generator<ContextOperationRequest, Result, unknown> {
  if (!hasContextInternals(context)) return yield* rounds;
  const internals = getInternals(context);
  internals.lockstepDepth += 1;
  try {
    return yield* rounds;
  } finally {
    internals.lockstepDepth -= 1;
  }
}

/** {@link advanceBranches} for a caller outside the context's own modules. */
export function* advanceBranchesOf(
  context: object,
  branches: Generator<ContextOperationRequest, unknown, unknown>[],
): Generator<ContextOperationRequest, unknown[], unknown> {
  if (!hasContextInternals(context)) {
    throw new Error('An advancing parallel step needs the context of an inline workflow run.');
  }
  return yield* advanceBranches(context, getInternals(context), branches);
}

/**
 * Run `branches` as an advancing parallel step and return each branch's result, in order. A branch
 * is a generator of operations; it is not started until the step runs.
 */
export function* advanceBranches(
  context: Context,
  internals: ContextInternals,
  branches: Generator<ContextOperationRequest, unknown, unknown>[],
): Generator<ContextOperationRequest, unknown[], unknown> {
  const step = internals.stepIndex++;
  const operationId = operationIdAt(internals, step);
  const parentNamespace =
    internals.branchNamespace === undefined ? '' : `${internals.branchNamespace}/`;
  const namespace = `${parentNamespace}p${String(step)}`;

  const cached = internals.accumulatedResults?.get(step);
  const slots = cachedSlots(cached, step, branches.length);
  if (slots?.every((slot) => slot.status === 'fulfilled') === true) {
    return slots.map((slot) => (slot.status === 'fulfilled' ? slot.value : undefined));
  }

  const drivers: BranchDriver[] = branches.map((generator, index) => {
    const slot = slots?.[index];
    if (slot?.status === 'fulfilled') return settledBranchDriver(slot.value);
    // A branch that threw resumes from the steps it finished, as one still running does: a signal
    // one of them took is gone, and only the step that threw runs again.
    const results = slot?.status === 'pending' || slot?.status === 'rejected' ? slot.results : [];
    return startBranchDriver(internals, generator, {
      namespace: `${namespace}.${String(index)}`,
      results,
    });
  });
  const operations = drivers.flatMap((driver) => (driver.first.done ? [] : [driver.first.request]));
  if (operations.length === 0) {
    // Every branch finished while priming (its steps all had results): nothing for the engine to run.
    const failed = drivers.find((driver) => driver.failure !== undefined);
    if (failed?.failure !== undefined) throw failed.failure.error;
    const values = drivers.map((driver) => (driver.first.done ? driver.first.value : undefined));
    context.accumulatedResults.set(step, finishedEntry(operationId, values));
    return values;
  }

  const request: ContextOperationRequest = {
    type: 'parallel',
    operationId,
    operations,
    step,
    ...(cached === undefined ? {} : { resumedCacheEntry: cached }),
    callerStack: captureCallerStack(),
  };
  attachBranchDrivers(request, drivers);
  const values = (yield* yieldOperation(internals, request)) as unknown[];
  // The engine writes this entry itself when it runs inline; write it here too so a replay sees a
  // finished step whatever strategy ran it.
  context.accumulatedResults.set(step, finishedEntry(operationId, values));
  return values;
}
