import { WorkflowCompletedEvent, WorkflowFailedEvent } from '../../events.ts';
import type { CancelWorkflowResult } from '../../types.ts';
import type { WorkflowResultWaiter } from '../engine-internal-types.ts';
import { currentExecutionAttempt, type ExecutionAttempt } from '../execution-attempts.ts';
import { getWorkflowExecutionStartedAt } from '../handles.ts';
import type { EngineInternals } from '../internals.ts';
import { recordResultCommitter } from '../result-committer.ts';
import { pendingTerminalSettlementFor } from '../result-waiter-run.ts';
import { deriveWorkflowResultFromState, loadWorkflowState } from '../storage-io.ts';
import type { WorkflowStateUpdateRefusal } from '../workflow-state-update.ts';
import {
  cleanupTerminalWorkflowImmediately,
  TERMINAL_WORKFLOW_STATUSES,
  type TerminationCallbacks,
} from './cleanup.ts';
import {
  captureCurrentClaimEpoch,
  releaseWorkflowClaimAfterTerminalSettlement,
} from './terminal-claim-release.ts';

/**
 * The run a terminate, or a write that may end a run, was issued against, captured before it
 * awaits anything: the execution attempt this engine holds for the id, that attempt's generation
 * token, and the result waiter the generation registered. A replacement that lands later installs
 * its own attempt and waiter under the same id, so only this capture says which ones belong to the
 * run being ended.
 *
 * The attempt object, not its token, is the run's identity on this engine (see
 * {@link engineHoldsRun}): every launch of an id installs a new object, so a `start-new`
 * replacement, and a relaunch of the very same generation after a suspend, are both told apart
 * from the captured run, which a token comparison cannot do for two pre-token launches.
 */
export type TerminatedRun = {
  /** The attempt this engine held for the id when the run was captured; `undefined` when it held none. */
  readonly attempt: ExecutionAttempt | undefined;
  readonly workflowExecutionToken: string | undefined;
  readonly waiter: WorkflowResultWaiter | undefined;
  /** The ownership claim this engine held for the run when it was captured, to release with it. */
  readonly claimEpoch: number | null;
};

export function cancellationOutcomeFromRefusal(
  workflowId: string,
  refusal: WorkflowStateUpdateRefusal,
): CancelWorkflowResult {
  if (refusal.reason === 'replaced') {
    throw new Error(`Workflow "${workflowId}" was replaced before it was cancelled.`);
  }
  return { workflowId, status: 'already-terminal', terminalStatus: refusal.state.status };
}

/**
 * Whether this engine still holds `run`'s own execution attempt: it held one when the run was
 * captured, and the attempt it holds now is that very object. A run captured with no attempt is
 * never held. Any later launch of the id, whether a replacement generation or the same generation
 * launched again, installs a different object, so it never passes for the captured run, whatever
 * tokens the two carry: two pre-token launches share an absent token, and comparing tokens alone
 * would treat them as one run.
 */
export function engineHoldsRun(
  internals: EngineInternals,
  workflowId: string,
  run: TerminatedRun,
): boolean {
  return (
    run.attempt !== undefined && currentExecutionAttempt(internals, workflowId) === run.attempt
  );
}

export function captureTerminatedRun(
  internals: EngineInternals,
  workflowId: string,
): TerminatedRun {
  const attempt = currentExecutionAttempt(internals, workflowId);
  return {
    attempt,
    workflowExecutionToken: attempt?.workflowExecutionToken,
    waiter: internals.resultResolvers.get(workflowId),
    claimEpoch: captureCurrentClaimEpoch(internals, workflowId),
  };
}

/**
 * A terminate that found nothing to write (another engine, or an earlier cancel, already ended
 * the run, or a replacement took the id) may still leave this engine holding the terminated run's
 * result waiter and in-memory state, which no commit of its own will settle. Settle exactly the
 * captured run's:
 *
 * - The record is still that run and is terminal: settle its waiter from the durable outcome and
 *   release the local state, as a terminal commit of its own would.
 * - The record belongs to another run (a replacement, on this engine or another): release nothing
 *   and never settle with the replacement's outcome. The old waiter is rejected as replaced; the
 *   replacement's checkpoint, state and waiter are untouched.
 * - The record is still that run and not terminal: leave everything for the terminate that wins.
 */
export async function settleTerminatedRunAfterRefusal(
  internals: EngineInternals,
  workflowId: string,
  callbacks: TerminationCallbacks,
  run: TerminatedRun,
): Promise<void> {
  const waiter = run.waiter;
  if (waiter === undefined) return;
  // A terminated run's result is held for its in-flight activity (COR-1597). A second terminate,
  // or the failure that activity's late result raises, must not release or replace it early.
  if (pendingTerminalSettlementFor(internals, workflowId, waiter) !== undefined) return;
  const state = await loadWorkflowState(internals, workflowId);
  if (state !== null && state.workflowExecutionToken === run.workflowExecutionToken) {
    if (!TERMINAL_WORKFLOW_STATUSES.has(state.status)) return;
    settleFromState(waiter, state);
    releaseWaiterEntry(internals, workflowId, waiter);
    if (engineHoldsRun(internals, workflowId, run)) {
      cleanupTerminalWorkflowImmediately(internals, workflowId, callbacks);
    }
    return;
  }
  releaseWaiterEntry(internals, workflowId, waiter);
  waiter.reject(new Error(`Workflow "${workflowId}" was replaced by a newer run before it ended.`));
}

/**
 * The result waiter that belongs to `run`: the one captured with it, or, when the run had none
 * then, one a `result()` registered since, while the engine was still ending the run. A waiter
 * bound to another run, such as a replacement's, never counts, and neither does an unbound one,
 * since this engine held the run and binds every waiter it creates for it (COR-1626).
 */
export function waiterForRun(
  internals: EngineInternals,
  workflowId: string,
  run: TerminatedRun,
): WorkflowResultWaiter | undefined {
  if (run.waiter !== undefined) return run.waiter;
  const registered = internals.resultResolvers.get(workflowId);
  if (
    registered === undefined ||
    !registered.boundToRun ||
    run.workflowExecutionToken === undefined ||
    registered.workflowExecutionToken !== run.workflowExecutionToken
  ) {
    return undefined;
  }
  return registered;
}

function settleFromState(
  waiter: WorkflowResultWaiter,
  state: NonNullable<Awaited<ReturnType<typeof loadWorkflowState>>>,
): void {
  recordResultCommitter(waiter, state.terminalCommittedBy);
  try {
    waiter.resolve(deriveWorkflowResultFromState(state));
  } catch (error) {
    waiter.reject(error);
  }
}

/** Drop the map entry only if it is still this run's waiter, never a replacement's. */
function releaseWaiterEntry(
  internals: EngineInternals,
  workflowId: string,
  waiter: WorkflowResultWaiter,
): void {
  if (internals.resultResolvers.get(workflowId) === waiter) {
    internals.resultResolvers.delete(workflowId);
  }
}

/** What {@link settleRunFromStoredRecord} found: the run's record decides what the engine may do. */
export type StoredRecordSettlement =
  /** The record is terminal for this run: its waiter settled and what the run held was released. */
  | 'settled'
  /** The record belongs to another run, or is gone: the waiter was rejected as replaced. */
  | 'replaced'
  /** The record is this run's and not terminal: nothing was settled or released. */
  | 'open'
  /** The record could not be read, so nothing was settled or released. */
  | 'unreadable';

/**
 * End a run from the record the store holds, for a terminal write that did not settle it: the
 * waiter (when a `result()` registered one) settles with the stored outcome, and everything this
 * engine still holds for the run is released, which a terminal commit of its own would have done:
 * the checkpoint, the execution attempt and the event-log head, and the ownership claim.
 *
 * The run's completed or failed event is dispatched when the stored record carries this engine's
 * own terminal stamp, or carries no stamp at all and this engine held the run: only
 * `workflow-lease` ownership stamps a terminal write, so under any other ownership the run this
 * engine was driving is announced here, and the events are local to the process, so another
 * engine's announcement cannot double it. A run another engine stamped is announced by that
 * engine. The waiter is the one {@link waiterForRun} finds, so a `result()` first asked for while
 * the run was being ended settles too. A record that is not terminal, or cannot be read, leaves
 * everything as it was for the caller to decide, and a record of another run is never settled as
 * this run's outcome.
 */
export async function settleRunFromStoredRecord(
  internals: EngineInternals,
  workflowId: string,
  callbacks: TerminationCallbacks,
  run: TerminatedRun,
): Promise<StoredRecordSettlement> {
  const waiter = waiterForRun(internals, workflowId, run);
  if (waiter !== undefined && pendingTerminalSettlementFor(internals, workflowId, waiter)) {
    return 'open';
  }
  let state: Awaited<ReturnType<typeof loadWorkflowState>>;
  try {
    state = await loadWorkflowState(internals, workflowId);
  } catch {
    return 'unreadable';
  }
  if (state === null || state.workflowExecutionToken !== run.workflowExecutionToken) {
    if (waiter !== undefined) {
      releaseWaiterEntry(internals, workflowId, waiter);
      waiter.reject(
        new Error(`Workflow "${workflowId}" was replaced by a newer run before it ended.`),
      );
    }
    releaseHeldRun(internals, workflowId, callbacks, run);
    return 'replaced';
  }
  if (!TERMINAL_WORKFLOW_STATUSES.has(state.status)) return 'open';
  // Released before the waiter settles, as a terminal commit of its own does: a caller that awaited
  // `result()` must not observe the run ended while the claim it holds is still held.
  releaseHeldRun(internals, workflowId, callbacks, run);
  await releaseWorkflowClaimAfterTerminalSettlement(internals, workflowId, run.claimEpoch);
  announceOwnTerminalWrite(internals, workflowId, callbacks, state, run);
  if (waiter !== undefined) {
    settleFromState(waiter, state);
    releaseWaiterEntry(internals, workflowId, waiter);
  }
  return 'settled';
}

/**
 * Release the in-memory state this engine holds for `run`, when what it holds is still that run's
 * and not a replacement's: the checkpoint, the execution attempt, the event-log head and the rest of
 * the terminal memory cleanup.
 */
function releaseHeldRun(
  internals: EngineInternals,
  workflowId: string,
  callbacks: TerminationCallbacks,
  run: TerminatedRun,
): void {
  if (engineHoldsRun(internals, workflowId, run)) {
    cleanupTerminalWorkflowImmediately(internals, workflowId, callbacks);
  }
}

/**
 * Dispatch the completed or failed event for a record this engine ended: one that carries its own
 * terminal stamp, or, under an ownership that stamps nothing, one for the run it held.
 */
function announceOwnTerminalWrite(
  internals: EngineInternals,
  workflowId: string,
  callbacks: TerminationCallbacks,
  state: NonNullable<Awaited<ReturnType<typeof loadWorkflowState>>>,
  run: TerminatedRun,
): void {
  const engineId = internals.workflowClaimRegistry?.engineId;
  const stampedHere = engineId !== undefined && state.terminalCommittedBy === engineId;
  const unstampedAndHeld = state.terminalCommittedBy === undefined && run.attempt !== undefined;
  if (!stampedHere && !unstampedAndHeld) return;
  let event: WorkflowCompletedEvent | WorkflowFailedEvent;
  if (state.status === 'completed') {
    event = new WorkflowCompletedEvent(
      workflowId,
      state.result,
      state.updatedAt - getWorkflowExecutionStartedAt(state),
    );
  } else if (state.status === 'failed') {
    event = new WorkflowFailedEvent(workflowId, new Error(state.error ?? 'Workflow failed'));
  } else {
    return;
  }
  callbacks.dispatchEvent(event);
  callbacks.forwardEventToHandle(workflowId, event);
}
