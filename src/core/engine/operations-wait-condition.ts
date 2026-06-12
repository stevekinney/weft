import type { ContextOperationRequest } from '../context.ts';
import type { EngineInternals } from './internals.ts';
import type { CoordinationOperationCallbacks } from './operations-coordination.ts';

type WaitConditionOperation = Extract<ContextOperationRequest, { type: 'wait-condition' }>;

export type ConditionOperationCallbacks = Pick<
  CoordinationOperationCallbacks,
  'completeOperation'
> & {
  /**
   * Fail the pending operation, feeding the error to the generator so it
   * re-throws at the `yield* ctx.waitUntil` site. Used when the user predicate
   * throws — a throwing predicate must surface as a catchable workflow failure,
   * not park the run forever.
   */
  failOperation: (workflowId: string, operation: WaitConditionOperation, error: unknown) => void;
  /** Whether the workflow is still running — gates completion after a wake. */
  isWorkflowRunning: (workflowId: string) => Promise<boolean>;
  /** Schedule the deterministic deadline timer (`cond:${workflowId}:${step}`). */
  scheduleConditionDeadline: (workflowId: string, step: number, fireAt: number) => Promise<void>;
  /** Cancel the deadline timer in storage on teardown. */
  cancelConditionDeadline: (workflowId: string, step: number) => Promise<void>;
};

/**
 * Drive an inline `ctx.waitUntil(predicate, timeout?)`. The predicate closure
 * rides on the operation request (held in-process, never checkpointed) and is
 * re-evaluated on every wake. Wakes come from two sources, both routed through
 * the same bare resolver registered in `conditionWaiters`:
 *
 * 1. An inline update handler that mutated state (`tryInlineUpdateHandler`).
 * 2. The optional deadline timer firing.
 *
 * (Weft signals are pull-only and run no state-mutating handler, so signal
 * delivery is intentionally NOT a re-drive trigger — `onUpdate` is the push path.)
 *
 * On every wake the check order is predicate-first, deadline-second, so a
 * predicate that became true exactly at the deadline resolves as met (`true`),
 * not timed-out. A single `settled` guard ensures exactly one completion even if
 * the timer fires in the same tick as a poke. The immediately-true case is
 * settled before the deadline timer is armed, so an already-satisfied timed wait
 * does no wasteful timer write and cancel.
 *
 * Completion is a single durable write: `completeOperation` feeds the result to
 * the generator, which runs to its next yield and the checkpoint captures
 * `accumulatedResults[step]` (with the deadline anchor already inside the same
 * checkpointLocals). No second out-of-band durable write — atomic by
 * construction.
 */
/**
 * Evaluate a wait-condition's terminal outcome. Predicate-first, deadline-second
 * (so a predicate true exactly at the deadline resolves MET, not timed-out).
 * Returns the value to complete with, or `'pending'` to keep waiting. Shared by
 * the pre-loop check and the in-loop lost-wakeup re-check so they cannot diverge.
 */
function evaluateConditionOutcome(
  internals: EngineInternals,
  predicate: () => boolean,
  deadline: number | undefined,
): { done: true; value: boolean | undefined } | { done: false } {
  if (predicate()) {
    return { done: true, value: deadline === undefined ? undefined : true };
  }
  if (deadline !== undefined && internals.options.getNow() >= deadline) {
    return { done: true, value: false };
  }
  return { done: false };
}

export async function processWaitConditionOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: WaitConditionOperation,
  callbacks: ConditionOperationCallbacks,
): Promise<void> {
  const abortSignal = internals.abortController.signal;
  const { predicate, deadline } = operation;

  let settled = false;
  const complete = (value: boolean | undefined): void => {
    if (settled) return;
    settled = true;
    callbacks.completeOperation(workflowId, value);
  };

  if (abortSignal.aborted) return;

  try {
    // Settle the immediately-true / already-expired cases BEFORE arming the
    // timer, so an already-satisfied timed wait avoids a wasteful timer
    // write and cancel.
    const initial = evaluateConditionOutcome(internals, predicate, deadline);
    if (initial.done) {
      complete(initial.value);
      return;
    }

    // Arm the deadline timer exactly once, before the loop. Arming inside the
    // loop would schedule a duplicate timer on every poke. The timer id keys by
    // `step` (stable across replay) while the in-process waiter keys by
    // `workflowId`.
    if (deadline !== undefined) {
      await callbacks.scheduleConditionDeadline(workflowId, operation.step, deadline);
    }

    try {
      let step = await runConditionWaitStep(internals, workflowId, predicate, deadline, callbacks);
      while (step.status === 'continue') {
        step = await runConditionWaitStep(internals, workflowId, predicate, deadline, callbacks);
      }
      if (step.status === 'complete') complete(step.value);
    } finally {
      releaseConditionWaiter(internals, workflowId);
      if (deadline !== undefined) {
        await callbacks.cancelConditionDeadline(workflowId, operation.step);
      }
    }
  } catch (error) {
    // A user predicate is arbitrary code and can throw on its initial evaluation
    // or on any update-driven re-evaluation (the lost-wakeup re-check). Route the
    // throw through `failOperation` so it re-throws at the `yield* ctx.waitUntil`
    // site (like a throwing activity/memo) instead of becoming an unhandled
    // rejection that parks the run forever.
    //
    // This catch can ALSO see a throw from the inner `finally`'s
    // `cancelConditionDeadline` AFTER `complete()` already settled the op (a
    // storage failure during teardown). That is a benign double-settle: the
    // generator already ran to its `return`, so the inline strategy's `#cleanup`
    // removed it from `#generators`; the subsequent `failOperation` →
    // `feedOperationResult` → `inlineStrategy.throwIntoWorkflow` finds no
    // generator (`if (!generator) return`) and is absorbed — the workflow stays
    // completed. So no `settled` guard is needed here. Pinned by the "no
    // double-settle" test.
    callbacks.failOperation(workflowId, operation, error);
  }
}

type ConditionWaitStepResult =
  | { status: 'continue' }
  | { status: 'stop' }
  | { status: 'complete'; value: boolean | undefined };

/**
 * One iteration of the condition wait loop: register the waiter, re-check the
 * predicate/deadline (the lost-wakeup guard), park until a poke or timer wakes
 * us, then re-validate that the workflow is still running. Returns whether to
 * loop again (`continue`), give up without completing (`stop` — aborted or
 * terminal), or complete with a value.
 */
async function runConditionWaitStep(
  internals: EngineInternals,
  workflowId: string,
  predicate: () => boolean,
  deadline: number | undefined,
  callbacks: Pick<ConditionOperationCallbacks, 'isWorkflowRunning'>,
): Promise<ConditionWaitStepResult> {
  const abortSignal = internals.abortController.signal;
  if (abortSignal.aborted) return { status: 'stop' };

  const { promise, resolve } = Promise.withResolvers<void>();
  internals.conditionWaiters.set(workflowId, resolve);

  // Lost-wakeup guard (the wait-signal second-consume analog): a poke between the
  // pre-registration eval and registering the waiter would otherwise be a no-op,
  // leaving us awaiting a promise nothing resolves. Re-check after registering
  // (and re-check abort) before parking.
  const outcome = abortSignal.aborted
    ? { done: true as const, value: undefined, aborted: true }
    : { ...evaluateConditionOutcome(internals, predicate, deadline), aborted: false };
  if (outcome.done) {
    releaseConditionWaiter(internals, workflowId);
    return outcome.aborted ? { status: 'stop' } : { status: 'complete', value: outcome.value };
  }

  await promise;

  if (abortSignal.aborted) return { status: 'stop' };
  // The workflow may have reached a terminal state (cancel/timeout) while parked;
  // cleanup resolved our waiter to wake us. Stop before driving a gone generator.
  // A spurious wake (e.g. a late timer from a prior step) is harmless: the next
  // iteration's predicate-first re-check re-evaluates and re-parks.
  if (!(await callbacks.isWorkflowRunning(workflowId))) return { status: 'stop' };
  return { status: 'continue' };
}

/**
 * Remove the workflow's condition waiter. A workflow has at most one active
 * wait-condition (see EngineInternals.conditionWaiters), and this is only ever
 * called with the resolver this same loop iteration just registered or from the
 * `finally` teardown — so an unconditional delete is correct (no stale-resolver
 * clobber is possible).
 */
function releaseConditionWaiter(internals: EngineInternals, workflowId: string): void {
  internals.conditionWaiters.delete(workflowId);
}
