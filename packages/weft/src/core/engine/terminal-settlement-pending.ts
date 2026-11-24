/**
 * Holding a terminated run's result back until its in-flight top-level activity has settled
 * (COR-1597).
 *
 * A cancel, a timeout, or the history circuit breaker commits the terminal state at once, but the
 * run's inline `activity` is still running and writing. The result waiter is settled only after
 * the handler turn that runs the activity ends, so anything a reader does after `result()` sees
 * what the activity wrote. Everything else about the termination, the committed state, the
 * terminal lifecycle event and the event forwarded to the handle, happens when it did.
 *
 * The settlement is a detached continuation on the captured turn, never an await on the
 * termination path: the history breaker terminates from inside the very turn it waits for, and
 * `engine.cancel()` and `engine.timeout()` return as soon as the terminal state is committed.
 *
 * A pending settlement is visible to every other path that would settle the waiter from the
 * durable terminal state, so one place holds back the first `result()` call after the commit, the
 * automatic poll, and the manual `runMaintenance()` poll alike. Nothing here builds on the claim
 * epoch, which `terminateWorkflow` has already released.
 *
 * Nothing waits on code that never settles. A cancel or a timeout aborts the activity's signal, a
 * configured `timeout` bounds an activity that ignores it, and disposal releases every pending
 * settlement with the terminal error that is already committed, not with `EngineDisposedError`.
 *
 * @module core/engine/terminal-settlement-pending
 */
import type { WorkflowResultWaiter } from './engine-internal-types.ts';
import type { EngineInternals } from './internals.ts';
import { recordResultCommitter } from './result-committer.ts';
import { waiterBelongsToRun } from './result-waiter-run.ts';

/** A terminated run whose result waiter is held until its handler turn ends. */
export type PendingTerminalSettlement = {
  readonly workflowId: string;
  /** The terminated run's execution token, read from the state the termination replaced. */
  readonly workflowExecutionToken: string | undefined;
  /** What the run's result rejects with: the terminal error already committed. */
  readonly terminalError: Error;
  /** The handler turn running the run's in-flight activity. */
  readonly turn: Promise<void>;
  /** The run's result waiter at the time of the termination, if it had one. */
  waiter: WorkflowResultWaiter | undefined;
  /** Whether the settlement has been released, by the turn ending or by disposal. */
  released: boolean;
};

/**
 * Register a pending settlement for a run that has just committed its terminal state, if it had
 * an activity in flight (`turn` is the turn running it). Nothing is registered for a run without.
 */
export function beginPendingTerminalSettlement(
  internals: EngineInternals,
  run: { readonly workflowId: string; readonly workflowExecutionToken: string | undefined },
  turn: Promise<void> | undefined,
  terminalError: Error,
): PendingTerminalSettlement | undefined {
  if (turn === undefined) return undefined;
  const settlement: PendingTerminalSettlement = {
    ...run,
    terminalError,
    turn,
    waiter: undefined,
    released: false,
  };
  internals.pendingTerminalSettlements.add(settlement);
  return settlement;
}

/**
 * Settle the run's result once its turn ends, rejected or not. Detached on purpose: see the module
 * comment.
 */
export function startPendingTerminalSettlement(
  internals: EngineInternals,
  settlement: PendingTerminalSettlement | undefined,
): void {
  if (settlement === undefined) return;
  const settle = (): void => releasePendingTerminalSettlement(internals, settlement);
  void settlement.turn.then(settle, settle);
}

/** The waiter a released settlement rejects: the one it captured, else the run's registered one. */
function waiterToReject(
  internals: EngineInternals,
  settlement: PendingTerminalSettlement,
): WorkflowResultWaiter | undefined {
  if (settlement.waiter !== undefined) return settlement.waiter;
  const registered = internals.resultResolvers.get(settlement.workflowId);
  // A waiter that has not read its run yet is left to settle itself from the durable record: it
  // finds no pending settlement and rejects with the same terminal error.
  if (registered === undefined || !registered.boundToRun) return undefined;
  return waiterBelongsToRun(registered, settlement.workflowExecutionToken) ? registered : undefined;
}

/** Reject the run's waiter with its terminal error and drop it, never a replacement's entry. */
function releasePendingTerminalSettlement(
  internals: EngineInternals,
  settlement: PendingTerminalSettlement,
): void {
  if (settlement.released) return;
  settlement.released = true;
  internals.pendingTerminalSettlements.delete(settlement);
  const waiter = waiterToReject(internals, settlement);
  if (waiter === undefined) return;
  recordResultCommitter(waiter, internals.workflowClaimRegistry?.engineId);
  waiter.reject(settlement.terminalError);
  if (internals.resultResolvers.get(settlement.workflowId) === waiter) {
    internals.resultResolvers.delete(settlement.workflowId);
  }
}

/**
 * Disposal: release every pending settlement with its committed terminal error. The terminal
 * state is already durable, so this is the run's real outcome, and a caller that reads
 * `EngineDisposedError` as a crash would otherwise leave a cancelled run looking live.
 */
export function releaseAllPendingTerminalSettlements(internals: EngineInternals): void {
  for (const settlement of internals.pendingTerminalSettlements) {
    releasePendingTerminalSettlement(internals, settlement);
  }
}
