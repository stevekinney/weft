import type { WorkflowId } from './identity.ts';
import type { WorkflowTimelineStatus } from './state.ts';

/**
 * One durable step of a run as a fork preview or comparison describes it: the step's index (the
 * timeline entry's `stepIndex`), the kind of operation and its label (an activity's name, for
 * one).
 */
export interface ForkPreviewStep {
  /** The durable step index. */
  index: number;
  /** The operation kind, such as `activity`, `sleep` or `wait-signal`. */
  operationType: string;
  /** The operation's label: an activity's name, a signal's name, and so on. */
  label: string;
  /** How the source run's step ended, or `running` when it had not. */
  status: WorkflowTimelineStatus;
}

/**
 * What `engine.previewFork(workflowId, options)` and `weft.workflows.fork` with `dryRun: true`
 * answer: what forking the run would do, with nothing written.
 *
 * A fork keeps the steps recorded before its starting checkpoint and runs every later step again;
 * the step the starting checkpoint was waiting on is the first of those. `keptSteps` and
 * `rerunSteps` read the source run's timeline: a step the source has not reached yet is in
 * neither.
 *
 * @example
 * ```ts
 * import type { ForkPreview } from '@lostgradient/weft';
 *
 * function describePreview(preview: ForkPreview): string {
 *   return `${preview.keptSteps.length} kept, ${preview.rerunSteps.length} run again`;
 * }
 * void describePreview;
 * ```
 */
export interface ForkPreview {
  /** Identifies a preview that did not create a workflow. */
  dryRun: true;
  /** The run that would be forked. */
  workflowId: WorkflowId;
  /** The checkpoint step the fork would start from. */
  forkPoint: number;
  /** Steps recorded before the fork point: the fork keeps their results and does not run them again. */
  keptSteps: ForkPreviewStep[];
  /** Steps from the fork point on: the fork runs them again. */
  rerunSteps: ForkPreviewStep[];
  /** Whether the fork would run on a different revision than the source run's. */
  revisionWouldChange: boolean;
  /** The revision the source run is pinned to; absent on a run recorded before revisions were pinned. */
  sourceRevision?: string;
  /** The revision the fork would be pinned to. */
  forkRevision?: string;
}

/**
 * Options for `engine.compare(workflowId, options)`.
 */
export interface CompareOptions {
  /** Steps per page. Defaults to 100 and is at most 1000. */
  limit?: number;
  /** The `nextCursor` of the previous page; omit it for the first page. */
  cursor?: string;
}

/**
 * One side of a compared step: what a run's timeline holds for that step.
 */
export interface ForkComparisonSide {
  /** The operation kind, such as `activity`, `sleep` or `wait-signal`. */
  operationType: string;
  /** The operation's label: an activity's name, a signal's name, and so on. */
  label: string;
  /** How the step ended, or `running` when it had not. */
  status: WorkflowTimelineStatus;
  /** The step's input, summarized and redacted exactly as the timeline read does. */
  input: string;
  /** The step's output or error, summarized and redacted as the timeline read does; absent while the step runs. */
  output?: string;
}

/**
 * One durable step of a fork compared with the same step of its source.
 *
 * A step before the fork point is `shared`: the fork has no timeline of its own for it and kept the
 * source's result, so both sides carry the source's entry. Any later step has each run's own entry
 * on its side, and a side is absent when that run has no entry for the step (the fork has not
 * reached it, or the source never did). A step an activity retried is one step: its side is the
 * entry of the last attempt.
 */
export interface ForkComparisonStep {
  /** The durable step index both sides share. */
  index: number;
  /** Whether the step is before the fork point, so both sides are the source's entry. */
  shared: boolean;
  /** The source run's entry for the step. */
  source?: ForkComparisonSide;
  /** The fork's entry for the step. */
  fork?: ForkComparisonSide;
}

/**
 * What `engine.compare(forkId)` and `weft.workflows.compare` answer: a fork and its source aligned
 * step by step, one page at a time.
 *
 * @example
 * ```ts
 * import type { ForkComparison } from '@lostgradient/weft';
 *
 * function changedSteps(page: ForkComparison): number[] {
 *   return page.steps
 *     .filter((step) => !step.shared && step.source?.output !== step.fork?.output)
 *     .map((step) => step.index);
 * }
 * void changedSteps;
 * ```
 */
export interface ForkComparison {
  /** The fork that was compared. */
  workflowId: WorkflowId;
  /** The run the fork was made from. */
  sourceWorkflowId: WorkflowId;
  /** The source checkpoint step the fork started from (`forkedFrom.step`). */
  forkPoint: number;
  /** This page's steps, by ascending step index. */
  steps: ForkComparisonStep[];
  /** Pass as `cursor` for the next page; absent on the last page. */
  nextCursor?: string;
}
