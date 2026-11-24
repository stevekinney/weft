import { getWorkflowEventGeneration } from '../events/workflow-event-generation.ts';
import { getWorkflowIdFromEvent } from '../events/workflow-event-id.ts';
import type { EngineInternals } from './internals.ts';

/**
 * Whether a same-engine `onTerminalConflict: 'start-new'` replacement has
 * taken over this id since the run that holds `capturedToken`. The state
 * teardown protects is this engine's in-memory state, so supersession is
 * judged by local generation: the cached checkpoint's `workflowExecutionToken`
 * differs from the captured one. A replacement started by a different engine
 * purges only that engine's memory, so this engine's state still belongs to
 * the old run and the check correctly reads as not superseded. It is
 * synchronous and reads no storage, so it adds no post-commit failure point.
 * A missing checkpoint reads as not superseded (the pre-fix behavior).
 */
export function isSupersededBySameIdRun(
  internals: EngineInternals,
  workflowId: string,
  capturedToken: string | undefined,
): boolean {
  const current = internals.checkpoints.get(workflowId);
  if (current === undefined) return false;
  return current.workflowExecutionToken !== capturedToken;
}

/**
 * Whether `event` was emitted by a generation of its workflow id that a
 * `start-new` replacement has since superseded (COR-1608). Only an event its
 * emitter tagged with `tagWorkflowEventGeneration` can be judged; an untagged
 * event, or one without a `workflowId`, never reads as superseded.
 */
export function isEventFromSupersededGeneration(internals: EngineInternals, event: Event): boolean {
  const token = getWorkflowEventGeneration(event);
  if (token === undefined) return false;
  const workflowId = getWorkflowIdFromEvent(event);
  if (workflowId === undefined) return false;
  return isSupersededBySameIdRun(internals, workflowId, token);
}
