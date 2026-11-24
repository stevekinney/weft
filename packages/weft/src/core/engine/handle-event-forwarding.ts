import { getWorkflowIdFromEvent } from '../events/workflow-event-id.ts';
import {
  WORKFLOW_TERMINAL_EVENT_TYPES,
  WorkflowSuspendedEvent,
} from '../events/workflow-events.ts';
import type { EngineInternals } from './internals.ts';

/**
 * Event types that termination forwards to the workflow's handle itself, after
 * deciding whether the run that ended is still the current one: `complete.ts`
 * forwards the four terminal events only when the run was not superseded, and
 * `suspend.ts` forwards `workflow:suspended`. The engine-wide forwarding in
 * {@link forwardWorkflowEventToHandle} skips them so a handle never receives
 * one twice or receives a superseded run's terminal event.
 */
const TYPES_FORWARDED_BY_TERMINATION: ReadonlySet<string> = new Set([
  ...WORKFLOW_TERMINAL_EVENT_TYPES,
  WorkflowSuspendedEvent.type,
]);

/**
 * Forward an event the engine just dispatched to the cached handle of the
 * workflow it names, so the handle's listeners and event iterator observe every
 * workflow-scoped event (`signal:waiting`, `signal:received`, `activity:*`,
 * `update:*`, and the rest) in the order the engine dispatched them. Events
 * without a string `workflowId` are engine-scoped and stay on the engine; an
 * event for one workflow only ever reaches that workflow's handle. Nothing is
 * buffered for a handle that does not exist yet, so a handle created later
 * does not replay earlier non-terminal events.
 */
export function forwardWorkflowEventToHandle(internals: EngineInternals, event: Event): void {
  if (TYPES_FORWARDED_BY_TERMINATION.has(event.type)) return;
  const workflowId = getWorkflowIdFromEvent(event);
  if (workflowId === undefined) return;
  const handle = internals.handleCache.get(workflowId)?.ref.deref();
  handle?.dispatchEvent(event);
}
