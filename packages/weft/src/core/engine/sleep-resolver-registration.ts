import { currentExecutionAttempt, type ExecutionAttempt } from './execution-attempts.ts';
import type { EngineInternals } from './internals.ts';
import { workflowExecutionTokenForWorkflow } from './strategy-helpers.ts';

/**
 * Register the in-process resolver that settles a sleep when its timer fires.
 *
 * `run` is the execution attempt the sleep started under, captured before its
 * first await (COR-1604). The registration is dropped once this engine holds a
 * different attempt for the id, or none: a cancel followed by a `start-new`
 * replacement can land while the sleep's timer write is in flight, and the
 * replacement's sleep at the same deterministic operation id must not have its
 * resolver replaced by the old run's. The attempt decides even when neither side
 * has an in-memory token, which the token comparison below cannot.
 */
export function registerSleepResolver(
  internals: EngineInternals,
  workflowId: string,
  operationId: string,
  resolve: () => void,
  scheduledFireAt: number,
  workflowExecutionToken: string | undefined,
  run: ExecutionAttempt | undefined,
): boolean {
  if (!registrationMatchesCurrentRun(internals, workflowId, workflowExecutionToken, run)) {
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

/**
 * Whether a sleep that started under `run` may still register. The attempt is
 * compared by identity first. The tokens are then compared only when both sides
 * have one: with the attempt unchanged, a missing in-memory token means the
 * engine holds no checkpoint at this moment, not that another run took the id.
 */
function registrationMatchesCurrentRun(
  internals: EngineInternals,
  workflowId: string,
  workflowExecutionToken: string | undefined,
  run: ExecutionAttempt | undefined,
): boolean {
  if (currentExecutionAttempt(internals, workflowId) !== run) return false;
  const currentToken = workflowExecutionTokenForWorkflow(internals, workflowId);
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
