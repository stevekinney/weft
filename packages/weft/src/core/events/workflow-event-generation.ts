/**
 * The execution generation that emitted a workflow-scoped event, kept in a
 * side table rather than on the event object (COR-1608).
 *
 * Weft events name their run only by `workflowId`, and a `start-new`
 * replacement reuses that id, so an event a displaced run emits late (a
 * delayed remote task result, say) is indistinguishable by its fields from one
 * the replacement emits. An emitter that knows the run's
 * `workflowExecutionToken` tags the event here, and `Engine.dispatchEvent`
 * drops a tagged event whose token is no longer the id's current generation
 * before any listener, handle, or watch channel sees it.
 *
 * The token deliberately stays off the event: event classes are public, and
 * the server serializes events onto the watch channel and the REST event log,
 * so a field would become part of the published event shape. A `WeakMap`
 * keyed by the event instance adds nothing to that surface and holds no event
 * alive. An untagged event is never fenced.
 */
const eventGenerations = new WeakMap<Event, string>();

/**
 * Record that `event` was emitted by the run whose execution token is
 * `workflowExecutionToken`, and return the event. An `undefined` token (a
 * record written before tokens existed) leaves the event untagged.
 */
export function tagWorkflowEventGeneration<TEvent extends Event>(
  event: TEvent,
  workflowExecutionToken: string | undefined,
): TEvent {
  if (workflowExecutionToken !== undefined) eventGenerations.set(event, workflowExecutionToken);
  return event;
}

/** The execution token `event` was tagged with, or `undefined` when untagged. */
export function getWorkflowEventGeneration(event: Event): string | undefined {
  return eventGenerations.get(event);
}
