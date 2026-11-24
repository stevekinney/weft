/**
 * Pure alignment of a fork's timeline with its source's (COR-2536): which steps a fork keeps and
 * which it runs again, and the two timelines laid side by side one durable step at a time. The
 * engine reads the timelines and calls these, so every client reads the one alignment the server
 * made.
 *
 * Alignment is by durable step index (`WorkflowTimelineEntry.stepIndex`), because a fork's
 * checkpoint steps are its own: the source runs its third step at checkpoint step 3 and the fork
 * runs it at step 4. A fork starts at a checkpoint of the source and keeps what that checkpoint
 * holds, which is every step recorded at a checkpoint step before it; the step the checkpoint was
 * waiting on, and everything after, runs again.
 *
 * @module core/engine/fork-timeline-alignment
 */
import type {
  ForkComparisonSide,
  ForkComparisonStep,
  ForkPreviewStep,
  WorkflowTimelineEntry,
} from '../types.ts';

/** Default and largest number of steps one comparison page holds. */
export const DEFAULT_COMPARE_PAGE_SIZE = 100;
export const MAX_COMPARE_PAGE_SIZE = 1000;

const CURSOR_PATTERN = /^step:(\d{1,15})$/;

/**
 * The durable step index of an entry: its `stepIndex`, or, for an entry persisted before that field
 * existed, the step before its checkpoint step (the closest index it can have).
 */
function stepIndexOf(entry: WorkflowTimelineEntry): number {
  return entry.stepIndex ?? Math.max(0, entry.step - 1);
}

/** The entries of one run grouped by durable step index, each group in the order the run recorded it. */
function groupByStepIndex(
  entries: readonly WorkflowTimelineEntry[],
): Map<number, WorkflowTimelineEntry[]> {
  const groups = new Map<number, WorkflowTimelineEntry[]>();
  for (const entry of entries.toSorted((left, right) => left.step - right.step)) {
    const index = stepIndexOf(entry);
    const group = groups.get(index);
    if (group === undefined) groups.set(index, [entry]);
    else group.push(entry);
  }
  return groups;
}

function lastOf(group: readonly WorkflowTimelineEntry[]): WorkflowTimelineEntry {
  const entry = group.at(-1);
  if (entry === undefined) throw new Error('A timeline step group is never empty');
  return entry;
}

/** Whether every entry of the group was recorded before the fork point, so the fork keeps the step. */
function isBeforeForkPoint(group: readonly WorkflowTimelineEntry[], forkPoint: number): boolean {
  return group.every((entry) => entry.step < forkPoint);
}

function sideOf(entry: WorkflowTimelineEntry): ForkComparisonSide {
  return {
    operationType: entry.operationType,
    label: entry.operationLabel,
    status: entry.status,
    input: entry.inputSummary,
    ...(entry.outputSummary === undefined ? {} : { output: entry.outputSummary }),
  };
}

/** The entries of the steps a fork made at `forkPoint` keeps: every step recorded before it. */
export function entriesKeptAtForkPoint(
  entries: readonly WorkflowTimelineEntry[],
  forkPoint: number,
): WorkflowTimelineEntry[] {
  return [...groupByStepIndex(entries).values()]
    .filter((group) => isBeforeForkPoint(group, forkPoint))
    .flat();
}

/**
 * Split the source run's steps at `forkPoint` into those a fork keeps and those it runs again.
 * A step the source has not reached is in neither.
 */
export function splitStepsAtForkPoint(
  sourceEntries: readonly WorkflowTimelineEntry[],
  forkPoint: number,
): { keptSteps: ForkPreviewStep[]; rerunSteps: ForkPreviewStep[] } {
  const keptSteps: ForkPreviewStep[] = [];
  const rerunSteps: ForkPreviewStep[] = [];
  const groups = groupByStepIndex(sourceEntries);
  for (const index of [...groups.keys()].toSorted((left, right) => left - right)) {
    const group = groups.get(index) ?? [];
    const last = lastOf(group);
    const step: ForkPreviewStep = {
      index,
      operationType: last.operationType,
      label: last.operationLabel,
      status: last.status,
    };
    (isBeforeForkPoint(group, forkPoint) ? keptSteps : rerunSteps).push(step);
  }
  return { keptSteps, rerunSteps };
}

/** A cursor that is not one this module issued, or a limit that is not a usable page size. */
export class CompareWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompareWindowError';
  }
}

/** Validate a page size, defaulting it. */
export function resolveComparePageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_COMPARE_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_COMPARE_PAGE_SIZE) {
    throw new CompareWindowError(
      `Field "limit" must be an integer from 1 to ${String(MAX_COMPARE_PAGE_SIZE)}`,
    );
  }
  return limit;
}

/** The step index a cursor resumes after, or `undefined` for the first page. */
export function parseCompareCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return undefined;
  const match = CURSOR_PATTERN.exec(cursor);
  if (match?.[1] === undefined)
    throw new CompareWindowError('Field "cursor" is not a valid cursor');
  return Number(match[1]);
}

/**
 * The fork and its source aligned by durable step index: one {@link ForkComparisonStep} per index
 * either run recorded, ascending, from the first index after `after` (or the first, for `undefined`)
 * for at most `limit` steps, and the cursor for the page after it when more remain.
 */
export function alignForkTimelines(
  sourceEntries: readonly WorkflowTimelineEntry[],
  forkEntries: readonly WorkflowTimelineEntry[],
  forkPoint: number,
  window: { after: number | undefined; limit: number },
): { steps: ForkComparisonStep[]; nextCursor?: string } {
  const sourceGroups = groupByStepIndex(sourceEntries);
  const forkGroups = groupByStepIndex(forkEntries);
  const indexes = [...new Set([...sourceGroups.keys(), ...forkGroups.keys()])]
    .filter((index) => window.after === undefined || index > window.after)
    .toSorted((left, right) => left - right);

  const page = indexes.slice(0, window.limit);
  const steps = page.map((index): ForkComparisonStep => {
    const sourceGroup = sourceGroups.get(index);
    const forkGroup = forkGroups.get(index);
    // The fork keeps the source's result for a step before the fork point and records no entry of
    // its own for it, so both sides are the source's.
    if (sourceGroup !== undefined && isBeforeForkPoint(sourceGroup, forkPoint)) {
      const shared = sideOf(lastOf(sourceGroup));
      return { index, shared: true, source: shared, fork: { ...shared } };
    }
    return {
      index,
      shared: false,
      ...(sourceGroup === undefined ? {} : { source: sideOf(lastOf(sourceGroup)) }),
      ...(forkGroup === undefined ? {} : { fork: sideOf(lastOf(forkGroup)) }),
    };
  });

  const last = page.at(-1);
  const hasMore = indexes.length > page.length;
  return {
    steps,
    ...(hasMore && last !== undefined ? { nextCursor: `step:${String(last)}` } : {}),
  };
}
