/**
 * The durable `WorkflowState.waitingForSignals` list (COR-1472): which signals a
 * running workflow is parked on, written into its `wf:` record so `engine.get()`
 * reports it across a restart.
 *
 * Every change is a read-modify-write of the `wf:` record inside
 * {@link runSerializedWorkflowStateWrite}, the per-workflow chain that this
 * engine's terminal, suspend, and tag writes also run in, so a change applies
 * in the order it was requested and never interleaves with them. The commit is
 * also conditioned on the record bytes it was computed from, so a write by
 * another engine between the read and the commit (a cancel, say) makes this one
 * decide again rather than write `running` back over it.
 *
 * A change applies only while the record is the run the wait started under
 * (see {@link SignalWaitRun}), still `running`, and not being terminalized, and
 * while this engine is not shutting down: a wait torn down by `dispose()` is
 * still outstanding durably, which is the whole point of persisting it. Leaving
 * `running` removes the list in the terminal or suspend write itself
 * (`withoutSignalWaits` in `signal-wait-state.ts`).
 *
 * Neither function here rejects (see `changeSignalWaits`), so a caller may
 * await one for ordering without guarding a failure.
 *
 * @module core/engine/signal-wait-tracking
 */
import { type ConditionalBatchCondition } from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import { encode } from '../codec.ts';
import { SignalWaitingEvent } from '../events.ts';
import type { WorkflowState } from '../types.ts';
import { broadcast } from './broadcast.ts';
import { currentExecutionAttempt, type ExecutionAttempt } from './execution-attempts.ts';
import { commitFencedEngineWriteAllowingPreconditionFailure } from './fenced-write.ts';
import type { EngineInternals } from './internals.ts';
import { withoutSignalWaits } from './signal-wait-state.ts';
import { runSerializedWorkflowStateWrite } from './storage-io.ts';
import { FENCED_RETRY_BUDGET } from './termination/terminal-fence.ts';
import { decodeWorkflowState } from './validation.ts';

/** The next list for a workflow, or `null` when the change does not apply. */
type SignalWaitChange = (current: readonly string[]) => readonly string[] | null;

/**
 * The run a signal wait belongs to (COR-1604): the execution attempt this
 * engine held for the workflow when the wait started, or `undefined` when it
 * held none. Capture it with {@link captureSignalWaitRun} and pass the same
 * value to every change the wait makes.
 *
 * The attempt, not the in-memory token, is the identity. The in-memory token is
 * missing whenever the engine holds no checkpoint for the id, which used to make
 * a change match whatever run the record held by then, a `start-new`
 * replacement included. An attempt changes on every launch and outlives a
 * suspension, and its token is the run's persisted `workflowExecutionToken` (a
 * recovered run's is read from its record), so the token is compared exactly: a
 * pre-token run is identified by the absence of one rather than matching every
 * later run.
 */
export type SignalWaitRun = ExecutionAttempt | undefined;

/**
 * Capture the run a wait that starts now belongs to. Call it synchronously,
 * before the wait's first await: a cancel followed by a `start-new` replacement
 * can land during any later await, and a run read after that is the
 * replacement's.
 */
export function captureSignalWaitRun(
  internals: EngineInternals,
  workflowId: string,
): SignalWaitRun {
  return currentExecutionAttempt(internals, workflowId);
}

/**
 * Record that `workflowId` began waiting for `signalName`, then announce it
 * with `signal:waiting`. Call it once the wait is registered and the last
 * buffered-signal check found nothing, so a signal that was already waiting is
 * never listed. A name the record already lists (a wait recovered after a
 * restart) is left alone and not announced again.
 *
 * `isStillWaiting` is read inside the serialized section, after the record is
 * loaded: a signal delivered before the write runs has already ended the wait,
 * and listing it then would leave a stale entry.
 */
export async function recordSignalWaitBegan(
  internals: EngineInternals,
  workflowId: string,
  run: SignalWaitRun,
  signalName: string,
  isStillWaiting: () => boolean,
): Promise<void> {
  const listed = await changeSignalWaits(internals, workflowId, run, (current) =>
    current.includes(signalName) || !isStillWaiting() ? null : [...current, signalName],
  );
  if (!listed) return;
  internals.engine.dispatchEvent(new SignalWaitingEvent(workflowId, signalName));
  broadcast(internals, { type: SignalWaitingEvent.type, workflowId, signalName }, internals.engine);
}

/** Remove `signalName` from `workflowId`'s list: its wait ended without the workflow leaving `running`. */
export async function clearSignalWait(
  internals: EngineInternals,
  workflowId: string,
  run: SignalWaitRun,
  signalName: string,
): Promise<void> {
  await changeSignalWaits(internals, workflowId, run, (current) =>
    current.includes(signalName) ? current.filter((name) => name !== signalName) : null,
  );
}

/** The clears of waits that lost a race, still writing, by workflow: see {@link trackSignalWaitClear}. */
const PENDING_CLEARS = new WeakMap<object, Map<string, Set<Promise<void>>>>();

/**
 * Hold the clear of a wait that lost its race to a timeout or a sibling, so the race that settled
 * can await it ({@link settleSignalWaitClears}): a branch that lost has nothing awaiting it, and its
 * clear would otherwise land after the operation that followed it. A reader told that operation
 * settled (a commit's feed, a terminal event) then finds the list without the wait.
 */
export function trackSignalWaitClear(
  internals: EngineInternals,
  workflowId: string,
  cleared: Promise<void>,
): void {
  const byWorkflow = PENDING_CLEARS.get(internals) ?? new Map<string, Set<Promise<void>>>();
  PENDING_CLEARS.set(internals, byWorkflow);
  const pending = byWorkflow.get(workflowId) ?? new Set<Promise<void>>();
  byWorkflow.set(workflowId, pending);
  pending.add(cleared);
  void cleared.finally(() => {
    pending.delete(cleared);
    if (pending.size === 0 && byWorkflow.get(workflowId) === pending) byWorkflow.delete(workflowId);
  });
}

/**
 * Wait for the clears {@link trackSignalWaitClear} holds for `workflowId`. Returns without a turn
 * of its own when there are none, which is every race a signal won.
 */
export function settleSignalWaitClears(
  internals: EngineInternals,
  workflowId: string,
): Promise<void> | undefined {
  const pending = PENDING_CLEARS.get(internals)?.get(workflowId);
  if (pending === undefined || pending.size === 0) return undefined;
  return Promise.all(pending).then(() => undefined);
}

/**
 * Apply `change` to the persisted list. Returns whether it wrote. `run` was
 * captured when the wait started, so a change requested by one run never lands
 * on a `start-new` replacement that took the id meanwhile, on any attempt.
 *
 * Never rejects. The list reports on a wait, and a wait or a signal delivery
 * must not fail or hang because its report could not be written: a storage
 * failure, a deposed claim, or a record that keeps changing under every
 * attempt leaves the list as it was and the caller carries on. The workflow's
 * own next write meets the same storage and reports its failure there.
 */
async function changeSignalWaits(
  internals: EngineInternals,
  workflowId: string,
  run: SignalWaitRun,
  change: SignalWaitChange,
): Promise<boolean> {
  try {
    return await runSerializedWorkflowStateWrite(internals, workflowId, async () => {
      for (let attempt = 0; attempt < FENCED_RETRY_BUDGET; attempt += 1) {
        const outcome = await attemptSignalWaitChange(internals, workflowId, run, change);
        if (outcome !== 'lost-race') return outcome === 'written';
      }
      return false;
    });
  } catch {
    return false;
  }
}

async function attemptSignalWaitChange(
  internals: EngineInternals,
  workflowId: string,
  run: SignalWaitRun,
  change: SignalWaitChange,
): Promise<'written' | 'skipped' | 'lost-race'> {
  if (internals.abortController.signal.aborted) return 'skipped';
  const key = KEYS.workflow(workflowId);
  const bytes = await internals.storage.get(key);
  if (bytes === null) return 'skipped';
  const state = decodeWorkflowState(bytes);
  if (!changeApplies(internals, state, run)) return 'skipped';
  const next = change(state.waitingForSignals ?? []);
  if (next === null) return 'skipped';
  const nextState =
    next.length === 0 ? withoutSignalWaits(state) : { ...state, waitingForSignals: next };
  const conditions: ConditionalBatchCondition[] = internals.storage.capabilities().conditionalBatch
    ? [{ key, expectedValue: bytes }]
    : [];
  const committed = await commitFencedEngineWriteAllowingPreconditionFailure(
    internals,
    workflowId,
    [{ type: 'put', key, value: encode(nextState) }],
    conditions,
  );
  return committed ? 'written' : 'lost-race';
}

/**
 * Whether a signal-wait change may still touch this record: it is still
 * `running` and not being terminalized, this engine still holds the attempt the
 * wait started under, and the record is that attempt's run, compared by exact
 * token (see {@link SignalWaitRun}).
 */
function changeApplies(
  internals: EngineInternals,
  state: WorkflowState,
  run: SignalWaitRun,
): boolean {
  return (
    state.status === 'running' &&
    !internals.terminalizingWorkflows.has(state.id) &&
    currentExecutionAttempt(internals, state.id) === run &&
    state.workflowExecutionToken === run?.workflowExecutionToken
  );
}
