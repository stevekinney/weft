import type { EngineInternals } from './internals.ts';

export function registerSleepResolver(
  internals: EngineInternals,
  workflowId: string,
  operationId: string,
  resolve: () => void,
  scheduledFireAt: number,
  workflowExecutionToken?: string,
): boolean {
  if (!registrationMatchesCurrentRun(internals, workflowId, workflowExecutionToken)) {
    return false;
  }
  // Store the deadline so resolveSleepTimer ignores a stale timer reused by an old run.
  const resolverKey = `${workflowId}:${operationId}`;
  internals.sleepResolvers.set(resolverKey, {
    resolve,
    fireAt: scheduledFireAt,
    ...(workflowExecutionToken === undefined ? {} : { workflowExecutionToken }),
  });

  let workflowOperations = internals.sleepResolversByWorkflow.get(workflowId);
  if (!workflowOperations) {
    workflowOperations = new Set();
    internals.sleepResolversByWorkflow.set(workflowId, workflowOperations);
  }
  workflowOperations.add(operationId);
  notifySleepResolverReadyWaiters(internals, workflowId);
  return true;
}

function registrationMatchesCurrentRun(
  internals: EngineInternals,
  workflowId: string,
  workflowExecutionToken: string | undefined,
): boolean {
  const currentToken =
    internals.durableInlineOperations?.get(workflowId)?.workflowExecutionToken ??
    internals.checkpoints?.get(workflowId)?.workflowExecutionToken;
  return (
    workflowExecutionToken === undefined ||
    currentToken === undefined ||
    currentToken === workflowExecutionToken
  );
}

function notifySleepResolverReadyWaiters(internals: EngineInternals, workflowId: string): void {
  const readinessWaiters = internals.sleepResolverReadyWaitersForTesting?.get(workflowId);
  if (readinessWaiters !== undefined) {
    internals.sleepResolverReadyWaitersForTesting?.delete(workflowId);
    for (const notifyReady of readinessWaiters) notifyReady();
  }
}
