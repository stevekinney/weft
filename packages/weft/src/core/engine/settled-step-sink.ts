/**
 * Where the steps a coordinator settles report what they completed, until a commit makes it
 * durable. An advancing parallel step settles its branches' steps one by one, and one nested in
 * another coordinator's branch settles them where only the outermost coordinator can commit, so each
 * records here and the coordinator that owns the pending timeline entry takes what is there when it
 * commits or settles. Held in memory per engine, like the branch activity receipts beside it.
 */

import type { SettledRequestCompletion } from './file-workflow-completion-events.ts';

const SINKS = new WeakMap<object, Map<string, SettledRequestCompletion>>();

/** Add what a settled step completed to the workflow's record. */
export function recordSettledStep(
  owner: object,
  workflowId: string,
  completion: SettledRequestCompletion,
): void {
  if (completion.events.length === 0 && completion.activityOperationIds.length === 0) return;
  let byWorkflow = SINKS.get(owner);
  if (byWorkflow === undefined) {
    byWorkflow = new Map();
    SINKS.set(owner, byWorkflow);
  }
  const held = byWorkflow.get(workflowId) ?? { events: [], activityOperationIds: [] };
  held.events.push(...completion.events);
  held.activityOperationIds.push(...completion.activityOperationIds);
  byWorkflow.set(workflowId, held);
}

/** Take, and clear, everything recorded for the workflow since the last take. */
export function takeSettledSteps(owner: object, workflowId: string): SettledRequestCompletion {
  const byWorkflow = SINKS.get(owner);
  const held = byWorkflow?.get(workflowId);
  byWorkflow?.delete(workflowId);
  return held ?? { events: [], activityOperationIds: [] };
}
