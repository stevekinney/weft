import type { WorkflowStatus } from './identity.ts';

/**
 * A point-in-time view of a workflow's progress, returned by
 * {@link WorkflowHandle.snapshot}. Combines the persisted status with the
 * current checkpoint step (the run's cursor), so a caller — typically after
 * `engine.recoverAll()` — can rebuild its own progress adapter for a recovered
 * run and re-register it on a live surface, without awaiting the run's final
 * result.
 *
 * `step` is the highest committed checkpoint step: the number of generator
 * turns the run has durably advanced. It is `0` for a run that has persisted
 * its initial checkpoint but not yet advanced, and increases as the run makes
 * progress.
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
