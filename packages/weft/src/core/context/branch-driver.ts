/**
 * The driver of one branch of an advancing parallel step: the branch's generator, run in a step
 * scope of its own.
 *
 * A `ctx.all` branch is a single operation. A branch of an advancing parallel step is a sequence of
 * them that the engine resumes as each settles, so one branch moves on while its siblings are still
 * on an earlier step. Resuming a generator is synchronous, so the driver swaps the context's step
 * counter and result cache for the branch's own around each call and restores them after: the
 * branch counts its steps from zero and keeps its own results, whatever order its siblings settle
 * in, and a replay that feeds the same results back numbers every step the same way.
 *
 * @module context/branch-driver
 */

import type { ContextInternals } from './internals.ts';
import type { ContextOperationRequest } from './operation-request.ts';

/** Where a branch stands after it ran: waiting on an operation, or finished with its result. */
export type BranchStep =
  { done: false; request: ContextOperationRequest } | { done: true; value: unknown };

/** How the operation a branch was waiting on settled. A fulfilled value is already finalized. */
export type BranchOutcome =
  { status: 'fulfilled'; value: unknown } | { status: 'rejected'; error: unknown };

export interface BranchDriver {
  /** The branch after priming: the first operation it needs, or its result if it needed none. */
  readonly first: BranchStep;
  /**
   * Why the branch threw while priming, when it did: a recovered branch whose replayed results end
   * in a rejected review throws again before it asks for anything. `first` is then `done`.
   */
  readonly failure?: { error: unknown } | undefined;
  /**
   * Resume the branch with the outcome of the operation it last asked for. A rejected outcome is
   * thrown into the branch, which may handle it. Throws when the branch itself throws.
   */
  resume(outcome: BranchOutcome): BranchStep;
  /** The results of the branch's own steps so far, as the parent's cache entry keeps them. */
  results(): [number, unknown][];
  /**
   * Keep `value` as the result of the branch's step `step` before that step has finished: the
   * progress of a parallel step nested in the branch, which a replay resumes from.
   */
  hold(step: number, value: unknown): void;
}

/**
 * The drivers of an advancing parallel step, kept beside its `parallel` request rather than on it:
 * `ContextOperationRequest` is a published type, and a driver is a closure over the running
 * context that only the inline engine can use.
 */
const BRANCH_DRIVERS = new WeakMap<object, readonly BranchDriver[]>();

/**
 * Mark `request`, a `parallel` request, as an advancing parallel step. Its `operations` hold the
 * first operation of each branch that still has work, and a branch that already has its result
 * runs nothing.
 */
export function attachBranchDrivers(
  request: ContextOperationRequest,
  drivers: readonly BranchDriver[],
): void {
  BRANCH_DRIVERS.set(request, drivers);
}

/** The drivers of an advancing parallel step, or `undefined` for any other operation. */
export function branchDriversOf(
  request: ContextOperationRequest,
): readonly BranchDriver[] | undefined {
  return BRANCH_DRIVERS.get(request);
}

type BranchScope = {
  stepIndex: number;
  accumulatedResults: Map<number, unknown>;
};

/**
 * Prime `generator` in a scope named `namespace`, seeded with the results a recovered run kept for
 * it, and return its driver. Priming runs the branch through every step that has a result already,
 * so `first` is the first operation that has none.
 */
export function startBranchDriver(
  internals: ContextInternals,
  generator: Generator<ContextOperationRequest, unknown, unknown>,
  options: { namespace: string; results?: readonly (readonly [number, unknown])[] | undefined },
): BranchDriver {
  const scope: BranchScope = {
    stepIndex: 0,
    accumulatedResults: new Map(options.results ?? []),
  };
  const inScope = (advance: () => IteratorResult<ContextOperationRequest, unknown>): BranchStep => {
    const outer = {
      stepIndex: internals.stepIndex,
      accumulatedResults: internals.accumulatedResults,
      branchNamespace: internals.branchNamespace,
    };
    internals.stepIndex = scope.stepIndex;
    internals.accumulatedResults = scope.accumulatedResults;
    internals.branchNamespace = options.namespace;
    try {
      const result = advance();
      return result.done
        ? { done: true, value: result.value }
        : { done: false, request: result.value };
    } finally {
      scope.stepIndex = internals.stepIndex;
      scope.accumulatedResults = internals.accumulatedResults ?? scope.accumulatedResults;
      internals.stepIndex = outer.stepIndex;
      internals.accumulatedResults = outer.accumulatedResults;
      internals.branchNamespace = outer.branchNamespace;
    }
  };
  let first: BranchStep;
  let failure: { error: unknown } | undefined;
  try {
    first = inScope(() => generator.next());
  } catch (error) {
    first = { done: true, value: undefined };
    failure = { error };
  }
  return {
    first,
    failure,
    resume(outcome) {
      return inScope(() => {
        // Time has moved on since the resumed checkpoint's parked moment: a sleep this step asks for
        // reads the clock, not that anchor, which only the operations primed with it may use.
        internals.sleepReferenceTime = undefined;
        return outcome.status === 'fulfilled'
          ? generator.next(outcome.value)
          : generator.throw(outcome.error);
      });
    },
    results: () => [...scope.accumulatedResults.entries()],
    hold: (step, value) => {
      scope.accumulatedResults.set(step, value);
    },
  };
}

/** The driver of a branch that already has its result: it runs nothing. */
export function settledBranchDriver(value: unknown): BranchDriver {
  return {
    first: { done: true, value },
    resume: () => ({ done: true, value }),
    results: () => [],
    hold: () => undefined,
  };
}
