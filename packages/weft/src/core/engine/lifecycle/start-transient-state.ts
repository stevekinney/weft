import { forgetCommittedCheckpointBytes } from '../checkpoint-commit-snapshots.ts';
import type { EngineInternals } from '../internals.ts';

export function rollbackTransientStartState(internals: EngineInternals, workflowId: string): void {
  forgetCommittedCheckpointBytes(internals, workflowId);
  internals.checkpoints.delete(workflowId);
  internals.workflowHeaders.delete(workflowId);
  internals.workflowVersionTuples.delete(workflowId);
  internals.workflowServices.delete(workflowId);
  internals.workflowsNeedingTerminalCleanup.delete(workflowId);
}
