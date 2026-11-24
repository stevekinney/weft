/**
 * Binds a result waiter to the run generation it was created for.
 *
 * `internals.resultResolvers` is keyed by workflow id, and an `onTerminalConflict: 'start-new'`
 * replacement reuses the id. A replacement started by another engine never touches this engine's
 * map, so a waiter created for the original run can still be registered when the replacement
 * terminates. Every place that settles a waiter from a run's outcome therefore asks, through this
 * module, whether the waiter belongs to that run. A waiter that does not is rejected as replaced
 * with {@link workflowRunReplacedError}, never settled with the replacement's outcome. Every
 * check is a synchronous comparison, so none adds an await to a persist, launch, or terminal path.
 *
 * @module core/engine/result-waiter-run
 */
import type { WorkflowResultWaiter } from './engine-internal-types.ts';
import { currentExecutionAttempt } from './execution-attempts.ts';
import type { EngineInternals } from './internals.ts';
import { markResultReplaced } from './result-committer.ts';
import type { PendingTerminalSettlement } from './terminal-settlement-pending.ts';

/** What a result waiter rejects with when a newer run reused its workflow id before it settled. */
export function workflowRunReplacedError(workflowId: string): Error {
  return new Error(`Workflow "${workflowId}" was replaced by a newer run before it ended.`);
}

/**
 * The run this engine holds for `workflowId` right now, if any, which a new result waiter is bound
 * to. The live checkpoint is replaced when a `start-new` replacement launches here, whereas the
 * durable inline-operation record can still name the run it replaced, so the token is read from
 * the checkpoint first. With neither, the execution attempt still names the run while it is
 * suspended (COR-1604). A held run recorded before tokens existed is still held, with no token,
 * so its waiter is bound to it and does not match a later token-bearing run.
 */
export function heldRunForResultWaiter(
  internals: EngineInternals,
  workflowId: string,
): { readonly workflowExecutionToken: string | undefined } | undefined {
  const held = [
    internals.checkpoints?.get(workflowId),
    internals.durableInlineOperations?.get(workflowId),
    currentExecutionAttempt(internals, workflowId),
  ].filter((run) => run !== undefined);
  if (held.length === 0) return undefined;
  return {
    workflowExecutionToken: held.find((run) => run.workflowExecutionToken !== undefined)
      ?.workflowExecutionToken,
  };
}

/**
 * Whether `waiter` is the result waiter for the run identified by `executionToken`. An unbound
 * waiter matches any run, and is bound by its caller from the record it reads. A bound waiter
 * matches only its own token, so a waiter bound to a run recorded before tokens existed does not
 * match a token-bearing replacement. An `executionToken` of `undefined` names no run (a pre-token
 * record, which cannot follow a token-bearing run, or a caller that holds no token) and matches.
 */
export function waiterBelongsToRun(
  waiter: WorkflowResultWaiter,
  executionToken: string | undefined,
): boolean {
  return (
    !waiter.boundToRun ||
    executionToken === undefined ||
    waiter.workflowExecutionToken === executionToken
  );
}

/**
 * The pending settlement holding back `waiter`, if the run it belongs to has one. A waiter that
 * belongs to a different run, such as a `start-new` replacement's, is never held.
 */
export function pendingTerminalSettlementFor(
  internals: EngineInternals,
  workflowId: string,
  waiter: WorkflowResultWaiter,
): PendingTerminalSettlement | undefined {
  return [...internals.pendingTerminalSettlements].find(
    (settlement) =>
      settlement.workflowId === workflowId &&
      waiterBelongsToRun(waiter, settlement.workflowExecutionToken),
  );
}

/**
 * Whether two waiters registered for the same workflow id speak for the same run. Only two
 * bound waiters can be told apart, and then by exact token, so a waiter bound to a pre-token
 * run never answers for a token-bearing one.
 */
export function waitersBelongToSameRun(
  first: WorkflowResultWaiter,
  second: WorkflowResultWaiter,
): boolean {
  return (
    !first.boundToRun ||
    !second.boundToRun ||
    first.workflowExecutionToken === second.workflowExecutionToken
  );
}

/**
 * Bind `waiter` to the run `executionToken` identifies, unless it is already bound. A record
 * with no token binds the waiter to that pre-token run.
 */
export function bindResultWaiterToRun(
  waiter: WorkflowResultWaiter,
  executionToken: string | undefined,
): void {
  if (waiter.boundToRun) return;
  waiter.boundToRun = true;
  waiter.workflowExecutionToken = executionToken;
}

/**
 * Reject `waiter` because a newer run reused its workflow id, and drop it from the map if it is
 * still the entry there. The original run's outcome is no longer readable, since the replacement
 * purged it, so the handle also reports the run as concluded by another engine: only another
 * engine can have terminated a run whose waiter this engine never settled.
 */
export function rejectReplacedResultWaiter(
  internals: EngineInternals,
  workflowId: string,
  waiter: WorkflowResultWaiter,
): void {
  if (internals.resultResolvers.get(workflowId) === waiter) {
    internals.resultResolvers.delete(workflowId);
  }
  // A terminated run's result is held for its in-flight activity (COR-1597), and its outcome is
  // the terminal error already committed, not "replaced". Its settlement rejects it once the
  // activity lands; the replacement only takes over the per-id slot.
  const held = pendingTerminalSettlementFor(internals, workflowId, waiter);
  if (held !== undefined) {
    held.waiter ??= waiter;
    return;
  }
  markResultReplaced(waiter);
  waiter.reject(workflowRunReplacedError(workflowId));
}

/**
 * The waiter registered for `workflowId` if it belongs to the run `executionToken` identifies.
 * A registered waiter that belongs to an older run is rejected as replaced and dropped, and
 * `undefined` is returned so the caller settles nothing with this run's outcome.
 */
export function resultWaiterForRun(
  internals: EngineInternals,
  workflowId: string,
  executionToken: string | undefined,
): WorkflowResultWaiter | undefined {
  const waiter = internals.resultResolvers.get(workflowId);
  if (waiter === undefined) return undefined;
  if (waiterBelongsToRun(waiter, executionToken)) return waiter;
  rejectReplacedResultWaiter(internals, workflowId, waiter);
  return undefined;
}
