import type { EngineInternals } from './internals.ts';

/** Resolve a workflow query from built-in progress state or exposed inline accessors. */
export async function query(
  internals: EngineInternals,
  workflowId: string,
  name: string,
  input?: unknown,
): Promise<unknown> {
  // Built-in query: return latest heartbeat details for this workflow
  if (name === 'activityProgress') {
    return internals.heartbeatDetails.get(workflowId);
  }

  const inlineStrategy = internals.inlineStrategy;
  if (!inlineStrategy) {
    throw new Error('Workflow queries are not supported when using the worker execution strategy.');
  }
  // When the inline waitForSignal parking optimization evicts a run's live
  // generator (parkWorkflow with retainContext), it retains the run's Context in
  // parkedContexts so query handlers registered via ctx.onQuery stay callable.
  // (A waitForSignal yield that kept a live context — e.g. one with update
  // handlers or exposed accessors that inline-parking does not park — is served
  // by getContext below.) Check the live context first so a query racing with a
  // resume always sees the freshly installed context.
  const context =
    inlineStrategy.getContext(workflowId) ?? inlineStrategy.getParkedContext(workflowId);
  if (!context) {
    return undefined;
  }
  const queryHandler = context.queryHandlers.get(name);
  if (queryHandler) return queryHandler(input);
  const accessor = context.exposedAccessors.get(name);
  if (!accessor) return undefined;
  return accessor();
}
