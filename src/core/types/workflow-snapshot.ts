import type { WorkflowStatus } from './identity.ts';

/**
 * A point-in-time view of a workflow's progress, returned by
 * {@link WorkflowHandle.snapshot}. Combines the persisted status with the
 * current checkpoint step (the run's cursor), so a caller — typically after
 * `engine.recoverAll()` — can rebuild its own progress adapter for a recovered
 * run and re-register it on a live surface, without awaiting the run's final
 * result.
 *
 * `step` is the run's current checkpoint step: the number of generator turns it
 * has advanced. For a run live in this engine it reflects the latest in-memory
 * checkpoint (which may be one step ahead of the last durable commit); for a
 * run inspected or recovered in a fresh process it reflects the durably
 * persisted checkpoint. It is `0` for a run that has its initial checkpoint but
 * has not yet advanced, and increases as the run makes progress.
 *
 * @example
 * ```ts
 * import { type WorkflowSnapshot } from '@lostgradient/weft';
 *
 * function describe(snapshot: WorkflowSnapshot): string {
 *   return `${snapshot.status} @ step ${snapshot.step}`;
 * }
 * ```
 */
export interface WorkflowSnapshot {
  status: WorkflowStatus;
  step: number;
}
