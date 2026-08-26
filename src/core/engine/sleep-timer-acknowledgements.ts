import type { ContextOperationRequest } from '../context.ts';
import type { TimerEntry, WorkflowState } from '../types.ts';
import type {
  DurableInlineOperation,
  EngineInternals,
  SleepTimerAcknowledgementWaiter,
} from './internals.ts';
import { isTerminalWorkflowStatus } from './validation.ts';
import { confirmWakeOwnership } from './wake-ownership-guard.ts';

export type SleepTimerAcknowledgement = {
  cancel: () => void;
  promise: Promise<void>;
};

/**
 * Durable sleep timers fire globally — under `ownership: 'workflow-lease'`
 * every engine sharing the store observes the same expired timer, not only
 * the workflow's owner (see ADR 0002's entry-point classification: the
 * scheduler dispatch shell is claim-acquiring only for claim-ACQUIRING
 * branches; this one is claim-REQUIRING and checks for itself). Running
 * `confirmWakeOwnership` FIRST — before `shouldIgnoreUnclaimedSleepTimer`
 * even loads workflow state — matters: on a non-owning engine that state
 * legitimately reads `'running'` (the true owner is actively driving it),
 * which would otherwise hit `shouldIgnoreUnclaimedSleepTimer`'s "fired
 * before ready" throw meant for a same-engine registration race, not a
 * cross-engine ownership miss.
 *
 * A discard is NOT a silent no-op: `handleTimerFired`'s caller — the
 * `Scheduler` — treats a callback that returns without throwing as
 * "processed" and durably deletes the fired timer key
 * (`commitTimerCleanup`, engine-scoped and unfenced on any single workflow's
 * claim, since one tick's cleanup batch can span fired timers from many
 * workflows — see `src/core/engine/index.ts`'s `Scheduler` wiring). If a
 * discarding non-owner let that deletion proceed, it would delete the true
 * owner's only durable record of this fire before the owner ever observes
 * it — see `retainDiscardedDurableTimer` below.
 */
export async function handleSleepTimerWithAcknowledgement(
  internals: EngineInternals,
  entry: TimerEntry,
  loadWorkflowState: (workflowId: string) => Promise<WorkflowState | null>,
): Promise<void> {
  if ((await confirmWakeOwnership(internals, entry.workflowId, 'sleep')) === 'discard') {
    await retainDiscardedDurableTimer(entry.id, entry.workflowId, loadWorkflowState);
    return;
  }

  const operationId = entry.id.replace('sleep:', '');
  if (await shouldIgnoreUnclaimedSleepTimer(internals, entry, operationId, loadWorkflowState))
    return;

  const acknowledgement =
    internals.inlineStrategy === null
      ? null
      : createSleepTimerAcknowledgement(internals, entry.workflowId, operationId, entry.fireAt);
  const shouldAwaitDurableProgress = resolveSleepTimer(internals, entry);
  if (!shouldAwaitDurableProgress) {
    acknowledgement?.cancel();
    return;
  }
  await acknowledgement?.promise;
}

/** What to do with a durable timer key once a claim-requiring wake has discarded it. */
export type DiscardedTimerDisposition = 'retain' | 'collect';

/**
 * Decide what a discarded claim-requiring timer fire (ADR 0002's `sleep` and
 * `wait-condition` wake kinds — see `operations-time.ts`'s
 * `resolveConditionTimer` for the second caller) should do with its durable
 * timer key. Shared by both wake kinds because they share the exact same
 * hazard: `commitTimerCleanup` batches deletes across many workflows in one
 * engine-scoped, unfenced write, so a non-owner that discards must not let
 * the Scheduler treat the fire as "processed" while some other engine still
 * needs the same durable record to perform the real wake.
 *
 * "Not locally owned" is not by itself proof the timer is stale, though —
 * `resolveSleepTimer`'s own comment documents that a durable sleep timer
 * OUTLIVES terminal cleanup (cleanup only drops the in-memory resolver, not
 * the durable key). Blindly retaining on every discard would turn an
 * orphaned post-terminal timer into an immortal one: every engine sharing
 * the store would rediscover it, discard it, and retain it again on every
 * Scheduler tick forever. So this reads the workflow's CURRENT persisted
 * status to disambiguate:
 * - `null`, or a terminal status ({@link isTerminalWorkflowStatus}):
 *   `'collect'` — no engine holds or will ever again acquire a claim for
 *   this workflow, so nothing will ever consume this fire; let the
 *   Scheduler's normal cleanup remove the orphaned key, matching
 *   pre-ADR-0002 behavior for an unclaimed timer.
 * - `'suspended'`: `'collect'` — `engine.suspend()`'s durable re-arm
 *   establishes its own fresh timer on resume; the pre-suspend fire being
 *   discarded here is not the one that wakes the resumed run.
 * - any other status (`'running'`, `'pending'`): `'retain'` — some engine
 *   still holds, or will still acquire, a live claim for this workflow;
 *   leave the durable key so that engine's own copy of this same fire
 *   performs the real wake and deletes it for real, bounded by that
 *   engine's own next Scheduler poll.
 */
export async function resolveDiscardedTimerDisposition(
  workflowId: string,
  loadWorkflowState: (workflowId: string) => Promise<WorkflowState | null>,
): Promise<DiscardedTimerDisposition> {
  const state = await loadWorkflowState(workflowId);
  if (state === null) return 'collect';
  if (state.status === 'suspended' || isTerminalWorkflowStatus(state.status)) return 'collect';
  return 'retain';
}

/**
 * Apply {@link resolveDiscardedTimerDisposition} to a discarded claim-requiring
 * timer fire: throws when the durable key must be retained, so the
 * `Scheduler`'s `#processSelectedTimer` catch block treats this fire as
 * `'retry'` — leaving the timer key in storage instead of collecting it —
 * and resolves normally when the workflow is gone, terminal, or suspended,
 * so a genuinely orphaned timer is still collected exactly as it was before
 * this ownership check existed.
 */
export async function retainDiscardedDurableTimer(
  timerId: string,
  workflowId: string,
  loadWorkflowState: (workflowId: string) => Promise<WorkflowState | null>,
): Promise<void> {
  if ((await resolveDiscardedTimerDisposition(workflowId, loadWorkflowState)) !== 'retain') {
    return;
  }
  throw new Error(
    `Durable timer "${timerId}" for workflow "${workflowId}" was discarded by a non-owning ` +
      `engine under ownership: 'workflow-lease'; retaining it in storage for the true owner ` +
      `instead of letting the scheduler delete it.`,
  );
}

async function shouldIgnoreUnclaimedSleepTimer(
  internals: EngineInternals,
  entry: TimerEntry,
  operationId: string,
  loadWorkflowState: (workflowId: string) => Promise<WorkflowState | null>,
): Promise<boolean> {
  const resolverKey = `${entry.workflowId}:${operationId}`;
  if (internals.sleepResolvers.has(resolverKey) || internals.inlineStrategy === null) return false;

  const durableOperation = internals.durableInlineOperations.get(entry.workflowId);
  if (durableOperationBelongsToAnotherOperation(durableOperation, operationId)) return true;
  if (workflowReplayIsAdvancing(internals, entry.workflowId)) return false;

  const state = await loadWorkflowState(entry.workflowId);
  if (state?.status !== 'running') return true;
  throw new Error(
    `Sleep timer "${entry.id}" fired before workflow "${entry.workflowId}" was ready to consume it.`,
  );
}

function durableOperationBelongsToAnotherOperation(
  durableOperation: DurableInlineOperation | undefined,
  operationId: string,
): boolean {
  if (durableOperation === undefined) return false;
  if (durableOperation.type !== 'sleep') return true;
  return durableOperation.operationId !== operationId;
}

function workflowReplayIsAdvancing(internals: EngineInternals, workflowId: string): boolean {
  const inlineStrategy = internals.inlineStrategy;
  if (inlineStrategy === null) return false;
  return (
    inlineStrategy.waitForWorkflowAdvance(workflowId) !== undefined ||
    inlineStrategy.waitForWorkflowTurn(workflowId) !== undefined
  );
}

function removeWaiter(
  internals: EngineInternals,
  workflowId: string,
  waiter: SleepTimerAcknowledgementWaiter,
): void {
  const workflowWaiters = internals.sleepTimerAcknowledgementWaiters.get(workflowId);
  if (!workflowWaiters) return;
  workflowWaiters.delete(waiter);
  if (workflowWaiters.size === 0) {
    internals.sleepTimerAcknowledgementWaiters.delete(workflowId);
  }
}

export function createSleepTimerAcknowledgement(
  internals: EngineInternals,
  workflowId: string,
  operationId: string,
  fireAt: number,
): SleepTimerAcknowledgement {
  const { promise, reject, resolve } = Promise.withResolvers<void>();
  const waiter: SleepTimerAcknowledgementWaiter = { fireAt, operationId, reject, resolve };
  let workflowWaiters = internals.sleepTimerAcknowledgementWaiters.get(workflowId);
  if (!workflowWaiters) {
    workflowWaiters = new Set();
    internals.sleepTimerAcknowledgementWaiters.set(workflowId, workflowWaiters);
  }
  workflowWaiters.add(waiter);

  return {
    promise,
    cancel: () => {
      removeWaiter(internals, workflowId, waiter);
      resolve();
    },
  };
}

export function recordDurableInlineOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: ContextOperationRequest,
): void {
  const durableOperation: DurableInlineOperation = {
    operationId: operation.operationId,
    type: operation.type,
    ...(operation.type === 'sleep' && { scheduledFireAt: operation.scheduledFireAt }),
  };
  internals.durableInlineOperations.set(workflowId, durableOperation);

  const workflowWaiters = internals.sleepTimerAcknowledgementWaiters.get(workflowId);
  if (!workflowWaiters) return;
  for (const waiter of workflowWaiters) {
    const stillWaitingOnThisSleep =
      durableOperation.type === 'sleep' && durableOperation.operationId === waiter.operationId;
    const supersededByLaterDeadline =
      stillWaitingOnThisSleep &&
      durableOperation.scheduledFireAt !== undefined &&
      waiter.fireAt < durableOperation.scheduledFireAt;
    if (stillWaitingOnThisSleep && !supersededByLaterDeadline) continue;
    removeWaiter(internals, workflowId, waiter);
    waiter.resolve();
  }
}

export function settleSleepTimerAcknowledgements(
  internals: EngineInternals,
  workflowId: string,
  disposition: 'suspended' | 'terminal',
): void {
  internals.durableInlineOperations.delete(workflowId);
  if (disposition === 'suspended') {
    rejectSleepTimerAcknowledgements(
      internals,
      workflowId,
      new Error(`Workflow "${workflowId}" was suspended before its sleep timer was acknowledged.`),
    );
    return;
  }
  const workflowWaiters = internals.sleepTimerAcknowledgementWaiters.get(workflowId);
  if (!workflowWaiters) return;
  internals.sleepTimerAcknowledgementWaiters.delete(workflowId);
  for (const waiter of workflowWaiters) waiter.resolve();
}

export function acknowledgeSupersededSleepTimers(
  internals: EngineInternals,
  workflowId: string,
  currentDeadline: number,
): void {
  const workflowWaiters = internals.sleepTimerAcknowledgementWaiters.get(workflowId);
  if (!workflowWaiters) return;
  for (const waiter of workflowWaiters) {
    if (waiter.fireAt >= currentDeadline) continue;
    removeWaiter(internals, workflowId, waiter);
    waiter.resolve();
  }
}

export function rejectSleepTimerAcknowledgements(
  internals: EngineInternals,
  workflowId: string,
  error: unknown,
): void {
  const workflowWaiters = internals.sleepTimerAcknowledgementWaiters.get(workflowId);
  if (!workflowWaiters) return;
  internals.sleepTimerAcknowledgementWaiters.delete(workflowId);
  const rejection = error instanceof Error ? error : new Error(String(error));
  for (const waiter of workflowWaiters) waiter.reject(rejection);
}

export function rejectAllSleepTimerAcknowledgements(
  internals: EngineInternals,
  error: Error,
): void {
  for (const workflowId of internals.sleepTimerAcknowledgementWaiters.keys()) {
    rejectSleepTimerAcknowledgements(internals, workflowId, error);
  }
}

export function resolveSleepTimer(internals: EngineInternals, entry: TimerEntry): boolean {
  const operationId = entry.id.replace('sleep:', '');
  const resolverKey = `${entry.workflowId}:${operationId}`;
  const resolver = internals.sleepResolvers.get(resolverKey);
  if (!resolver) {
    // No resolver registered yet — the tick fired in the window between
    // schedule() completing and registerSleepResolver() running. Record the
    // fired timer's deadline so processSleepOperation can self-resolve after
    // registration (only if that deadline is this run's, not a stale earlier
    // run's) instead of parking on a promise that will never be called.
    let workflowMarkers = internals.sleepTimersFiredWithoutResolver.get(entry.workflowId);
    if (!workflowMarkers) {
      workflowMarkers = new Map();
      internals.sleepTimersFiredWithoutResolver.set(entry.workflowId, workflowMarkers);
    }
    // Keep the latest (largest) deadline seen for this operation id: only a
    // timer whose deadline reaches this run's scheduledFireAt should settle it.
    const existing = workflowMarkers.get(operationId);
    if (existing === undefined || entry.fireAt > existing) {
      workflowMarkers.set(operationId, entry.fireAt);
    }
    return true;
  }

  // Ignore a stale timer left behind by a terminated run that reused this same
  // deterministic operationId. The durable sleep timer outlives terminal cleanup
  // (cleanup only drops the in-memory resolver), so a start-new replacement at
  // the same id+step would otherwise have its sleep resolved early when the old
  // timer fires. The replacement run's own timer fires at its own (>=) deadline.
  if (entry.fireAt < resolver.fireAt) return false;

  internals.sleepResolvers.delete(resolverKey);
  untrackSleepResolver(internals, entry.workflowId, operationId);
  resolver.resolve();
  return true;
}

function untrackSleepResolver(
  internals: EngineInternals,
  workflowId: string,
  operationId: string,
): void {
  const workflowOperations = internals.sleepResolversByWorkflow.get(workflowId);
  if (!workflowOperations) return;

  workflowOperations.delete(operationId);
  if (workflowOperations.size === 0) internals.sleepResolversByWorkflow.delete(workflowId);
}
