/**
 * The timeline of a run as a fork of it would inherit it (COR-2536). A fork copies no timeline: it
 * records only the steps it runs itself, and the steps before its fork point live on its source. So
 * the timeline of a run that is itself a fork is its own entries after the steps it kept from its
 * source, resolved through the source's lineage up to the first run that is not a fork.
 *
 * Preview and compare both read a source through this, so a fork of a fork sees every step.
 *
 * @module core/engine/fork-effective-timeline
 */
import type { WorkflowTimelineEntry } from '../types.ts';
import { getTimeline } from './checkpoint-reads.ts';
import { entriesKeptAtForkPoint } from './fork-timeline-alignment.ts';
import type { EngineInternals } from './internals.ts';
import { loadWorkflowState } from './storage-io.ts';

/**
 * The steps recorded for `workflowId` plus the ones it inherited. An ancestor that is gone, or that
 * is another run under the same id since the fork (its execution token no longer matches the
 * lineage's), contributes nothing: its timeline is not the one the fork kept.
 */
export async function getEffectiveTimeline(
  internals: EngineInternals,
  workflowId: string,
): Promise<WorkflowTimelineEntry[]> {
  const [own, state] = await Promise.all([
    getTimeline(internals, workflowId),
    loadWorkflowState(internals, workflowId),
  ]);
  const lineage = state?.forkedFrom;
  if (lineage === undefined) return own;
  const parentState = await loadWorkflowState(internals, lineage.workflowId);
  if (
    parentState === null ||
    (lineage.workflowExecutionToken !== undefined &&
      parentState.workflowExecutionToken !== lineage.workflowExecutionToken)
  ) {
    return own;
  }
  const inherited = await getEffectiveTimeline(internals, lineage.workflowId);
  return [...entriesKeptAtForkPoint(inherited, lineage.step), ...own];
}
