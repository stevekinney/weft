import type { ContextOperationRequest } from '../context.ts';
import type { TimerEntry, WorkflowState } from '../types.ts';
import type {
  DurableInlineOperation,
  EngineInternals,
  SleepTimerAcknowledgementWaiter,
} from './internals.ts';

export type SleepTimerAcknowledgement = {
  cancel: () => void;
  promise: Promise<void>;
};

export async function handleSleepTimerWithAcknowledgement(
  internals: EngineInternals,
  entry: TimerEntry,
  loadWorkflowState: (workflowId: string) => Promise<WorkflowState | null>,
): Promise<void> {
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
