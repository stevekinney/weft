/**
 * `engine.compare` (COR-2536): a fork and its source laid side by side, one durable step at a time,
 * with each step's operation, label, status, input and output.
 *
 * Both timelines are read through `getTimeline`, the read that redacts a payload field the way
 * `weft.workflows.timeline.get` does, and the alignment is made here, in the engine, so every
 * client, Weft's own CLI and a browser included, reads one answer. A fork copies no timeline, so a
 * step before the fork point is read from the source and shown on both sides; a source that is
 * itself a fork is read with the steps it inherited (`getEffectiveTimeline`).
 *
 * @module core/engine/compare-fork
 */
import type { CompareOptions, ForkComparison } from '../types.ts';
import { WeftError } from '../weft-error.ts';
import { getTimeline } from './checkpoint-reads.ts';
import { WorkflowNotFoundError } from './errors.ts';
import { getEffectiveTimeline } from './fork-effective-timeline.ts';
import {
  alignForkTimelines,
  parseCompareCursor,
  resolveComparePageSize,
} from './fork-timeline-alignment.ts';
import type { EngineInternals } from './internals.ts';
import { loadWorkflowState } from './storage-io.ts';

/**
 * Thrown by `engine.compare` for a run that is not a fork: there is no source to compare it with.
 * `remediation` says what to do instead, and is also the last sentence of the message, so a caller
 * that shows only the message still tells the operator.
 */
export class CompareRequiresForkError extends WeftError<'CompareRequiresForkError'> {
  readonly workflowId: string;
  readonly remediation: string;

  constructor(workflowId: string) {
    const remediation =
      'Compare a run made by fork: pass the id that weft.workflows.fork (or engine.fork) returned.';
    super(
      'CompareRequiresForkError',
      `Workflow "${workflowId}" is not a fork, so it has no source run to compare with. ${remediation}`,
    );
    this.workflowId = workflowId;
    this.remediation = remediation;
  }
}

export async function compareFork(
  internals: EngineInternals,
  forkWorkflowId: string,
  options: CompareOptions | undefined,
): Promise<ForkComparison> {
  // Validate the window before any read, so a bad cursor never costs two timeline scans.
  const limit = resolveComparePageSize(options?.limit);
  const after = parseCompareCursor(options?.cursor);

  const forkState = await loadWorkflowState(internals, forkWorkflowId);
  if (forkState === null) throw new WorkflowNotFoundError(forkWorkflowId);
  const lineage = forkState.forkedFrom;
  if (lineage === undefined) throw new CompareRequiresForkError(forkWorkflowId);
  const sourceState = await loadWorkflowState(internals, lineage.workflowId);
  if (sourceState === null) throw new WorkflowNotFoundError(lineage.workflowId);
  // The id is stable and a `start-new` reuses it, so a source replaced after the fork is a
  // different run whose timeline the fork never read: the original source is gone.
  if (
    lineage.workflowExecutionToken !== undefined &&
    sourceState.workflowExecutionToken !== lineage.workflowExecutionToken
  ) {
    throw new WorkflowNotFoundError(lineage.workflowId);
  }

  const [sourceEntries, forkEntries] = await Promise.all([
    getEffectiveTimeline(internals, lineage.workflowId),
    getTimeline(internals, forkWorkflowId),
  ]);
  const { steps, nextCursor } = alignForkTimelines(sourceEntries, forkEntries, lineage.step, {
    after,
    limit,
  });
  return {
    workflowId: forkWorkflowId,
    sourceWorkflowId: lineage.workflowId,
    forkPoint: lineage.step,
    steps,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}
