/**
 * Extract a `workflowId` from a DOM `Event` when the concrete event carries
 * one. Every workflow-scoped event the engine dispatches (workflow, activity,
 * signal, attribute, update, review, task, and warning events tied to a run)
 * exposes a `workflowId: string` field, but the `Event` base type does not know
 * about it — so a runtime structural check narrows the value before it is used
 * to route the event or key bookkeeping maps. Returns `undefined` for events
 * without a string `workflowId` property.
 */
export function getWorkflowIdFromEvent(event: Event): string | undefined {
  if (!('workflowId' in event)) return undefined;
  const candidate = (event as { workflowId: unknown }).workflowId;
  return typeof candidate === 'string' ? candidate : undefined;
}
