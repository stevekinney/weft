import type { Engine } from '../engine.ts';
import type { WorkflowTeardownStatus } from '../events.ts';

export type CollectedTeardownEvent = {
  workflowId: string;
  status: WorkflowTeardownStatus;
  attempts: number;
  error?: string;
};

export function collectTeardownEvents(engine: Engine): CollectedTeardownEvent[] {
  const events: CollectedTeardownEvent[] = [];
  engine.addEventListener('workflow:teardown', (event) => {
    events.push({
      workflowId: event.workflowId,
      status: event.status,
      attempts: event.attempts,
      ...(event.error === undefined ? {} : { error: event.error }),
    });
  });
  return events;
}
