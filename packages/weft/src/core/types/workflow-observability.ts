/**
 * The recurring schedule occurrence that launched a workflow run.
 *
 * @example
 * ```ts
 * import { type WorkflowScheduleProvenance } from '@lostgradient/weft';
 *
 * const provenance: WorkflowScheduleProvenance = {
 *   scheduleId: 'nightly-cleanup',
 *   occurrence: Date.UTC(2026, 0, 1),
 * };
 * void provenance;
 * ```
 */
export interface WorkflowScheduleProvenance {
  scheduleId: string;
  occurrence?: number;
}

/**
 * Durable progress and outcome of a workflow's post-terminal finalizer.
 *
 * @example
 * ```ts
 * import { type WorkflowFinalizerStatus } from '@lostgradient/weft';
 *
 * const finalizer: WorkflowFinalizerStatus = {
 *   status: 'succeeded',
 *   attempts: 1,
 *   completedAt: Date.now(),
 * };
 * void finalizer;
 * ```
 */
export type WorkflowFinalizerStatus =
  | { status: 'pending'; attempts: number }
  | { status: 'running'; attempts: number; startedAt: number }
  | { status: 'succeeded'; attempts: number; completedAt: number }
  | { status: 'failed'; attempts: number; failedAt: number; error: string };
