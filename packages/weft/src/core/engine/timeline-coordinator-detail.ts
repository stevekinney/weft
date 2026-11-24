import type { ContextOperationRequest } from '../context.ts';
import type { ParallelBranchSlot } from '../context/parallel-cache-entry.ts';
import type { WorkflowTimelineEntry, WorkflowTimelineOperationDetail } from '../types.ts';
import { stagedCoordinatorCompletion } from './file-workflow-completion-events.ts';
import type { EngineInternals } from './internals.ts';
import { takeSettledSteps } from './settled-step-sink.ts';
import { getTimelineOperationLabel, summarizeTimelineValue } from './state-utilities.ts';
import {
  MAX_TIMELINE_COORDINATOR_DETAILS,
  MAX_TIMELINE_DETAIL_STRING_LENGTH,
} from './timeline-coordinator-constants.ts';

export type ActivityCompletionReceipt = {
  operationId: string;
  workflowExecutionToken: string | undefined;
  activityName: string;
  duration: number;
};

/**
 * Completion receipts for `ctx.all`/`ctx.race`/run-all branch activities that
 * succeeded locally, keyed `workflowId -> operationId`, per engine. The
 * enclosing coordinator's result commit reports the branches its timeline
 * entry records as fulfilled or won and drops the rest (race losers, failed
 * siblings). Held only in memory, collected with the engine, and dropped per
 * workflow by {@link forgetBranchActivityReceipts} on terminal cleanup and purge.
 */
const branchActivityReceipts = new WeakMap<
  EngineInternals,
  Map<string, Map<string, ActivityCompletionReceipt>>
>();

/** Drop a workflow's held branch receipts when its run ends or is purged. */
export function forgetBranchActivityReceipts(internals: EngineInternals, workflowId: string): void {
  branchActivityReceipts.get(internals)?.delete(workflowId);
  // What the workflow's settled branch steps reported dies with its receipts.
  takeSettledSteps(internals, workflowId);
}

const COORDINATOR_OPERATION_TYPES: ReadonlySet<string> = new Set(['parallel', 'race', 'run-all']);

/**
 * Which lifecycle evidence an activity attempt reports, decided by the
 * workflow's current durable operation. A `'top-level'` activity is that
 * operation; a `'branch'` runs under an enclosing `ctx.all`/`ctx.race`/run-all
 * whose result commit reports it. Anything else, such as a `durableActivity()`
 * helper under `ctx.memo`, reports neither event rather than a start that
 * never completes.
 */
export function activityLifecycleScope(
  internals: EngineInternals,
  workflowId: string,
  operationId: string,
): 'top-level' | 'branch' | undefined {
  const operation = internals.durableInlineOperations?.get(workflowId);
  if (operation === undefined) return undefined;
  if (operation.type === 'activity') {
    return operation.operationId === operationId ? 'top-level' : undefined;
  }
  return COORDINATOR_OPERATION_TYPES.has(operation.type) ? 'branch' : undefined;
}

/**
 * Hold a succeeded branch activity's receipt until its coordinator commits. A
 * race loser that finishes after its workflow moved on or ended has no
 * coordinator left to report it, so it is not held.
 */
export function recordBranchActivityReceipt(
  internals: EngineInternals,
  workflowId: string,
  receipt: ActivityCompletionReceipt,
): void {
  const operation = internals.durableInlineOperations?.get(workflowId);
  if (
    activityLifecycleScope(internals, workflowId, receipt.operationId) !== 'branch' ||
    operation?.workflowExecutionToken !== receipt.workflowExecutionToken
  ) {
    return;
  }
  let byWorkflow = branchActivityReceipts.get(internals);
  if (byWorkflow === undefined) {
    byWorkflow = new Map();
    branchActivityReceipts.set(internals, byWorkflow);
  }
  let receipts = byWorkflow.get(workflowId);
  if (receipts === undefined) {
    receipts = new Map();
    byWorkflow.set(workflowId, receipts);
  }
  receipts.set(receipt.operationId, receipt);
}

/**
 * The activity completions the commit about to run makes durable: the
 * top-level activity's, or each branch the coordinator's timeline entry
 * records as fulfilled or won. Branch receipts the commit does not report
 * (race losers, failed siblings) are dropped with it.
 */
export function captureActivityCompletionReceipts(
  internals: EngineInternals,
  workflowId: string,
): ActivityCompletionReceipt[] {
  const operation = internals.durableInlineOperations?.get(workflowId);
  if (operation === undefined) return [];
  if (COORDINATOR_OPERATION_TYPES.has(operation.type)) {
    return captureBranchCompletionReceipts(internals, workflowId);
  }
  // A remote-mode engine dispatches every activity to a worker, and
  // `task-result-application.ts` reports its completion under the task
  // ledger's operation id, the one its `activity:started` carried. Reporting
  // the committed checkpoint here too would publish a second completion.
  if (internals.remoteActivityBroker || operation.type !== 'activity') return [];
  const pending = internals.pendingTimelineEntries.get(workflowId);
  if (
    pending?.entry.operationType !== 'activity' ||
    pending.entry.status !== 'completed' ||
    pending.entry.duration === undefined
  ) {
    return [];
  }
  return [
    {
      operationId: operation.operationId,
      workflowExecutionToken: operation.workflowExecutionToken,
      activityName: pending.entry.operationLabel,
      duration: Math.max(0, pending.entry.duration),
    },
  ];
}

/**
 * The activity completions the commit about to run reports: every held receipt, or, for a commit
 * that keeps the pending entry (made while its operation still runs), only those of the branch
 * activities it names.
 */
export function captureCommitReceipts(
  internals: EngineInternals,
  workflowId: string,
  timeline: 'record-operation' | 'preserve-pending' | undefined,
  settledBranchOperationIds: readonly string[] | undefined,
): ActivityCompletionReceipt[] {
  return timeline === 'preserve-pending'
    ? captureSettledBranchReceipts(internals, workflowId, settledBranchOperationIds ?? [])
    : captureActivityCompletionReceipts(internals, workflowId);
}

/**
 * The completion receipts of the named branch activities, taken out of the held set. A commit made
 * while its coordinator is still running (a settled slot, before its siblings) reports only the
 * branches it made durable: the rest stay held for the commit that settles the coordinator.
 */
export function captureSettledBranchReceipts(
  internals: EngineInternals,
  workflowId: string,
  operationIds: readonly string[],
): ActivityCompletionReceipt[] {
  const receipts = branchActivityReceipts.get(internals)?.get(workflowId);
  if (receipts === undefined) return [];
  const settled: ActivityCompletionReceipt[] = [];
  for (const operationId of operationIds) {
    const receipt = receipts.get(operationId);
    if (receipt === undefined) continue;
    receipts.delete(operationId);
    settled.push(receipt);
  }
  return settled;
}

function captureBranchCompletionReceipts(
  internals: EngineInternals,
  workflowId: string,
): ActivityCompletionReceipt[] {
  const receipts = branchActivityReceipts.get(internals)?.get(workflowId);
  branchActivityReceipts.get(internals)?.delete(workflowId);
  const pending = internals.pendingTimelineEntries.get(workflowId);
  if (receipts === undefined || pending?.entry.status !== 'completed') return [];
  const committed = new Set<ActivityCompletionReceipt>();
  for (const operationId of reportedActivityIds(pending.entry)) {
    const receipt = receipts.get(operationId);
    if (receipt !== undefined) committed.add(receipt);
  }
  return [...committed];
}

/**
 * The activities a settled coordinator's entry reports: its fulfilled or won branches, and what an
 * advancing parallel step staged, since its entry names only the last operation of each branch.
 */
function reportedActivityIds(entry: WorkflowTimelineEntry): string[] {
  const fulfilled = (entry.branches ?? []).filter(
    (branch) => branch.outcome === 'fulfilled' || branch.outcome === 'won',
  );
  return [
    ...fulfilled.map((branch) => branch.operationId),
    ...(stagedCoordinatorCompletion(entry)?.activityOperationIds ?? []),
  ];
}

function boundedString(value: string): string {
  return value.length <= MAX_TIMELINE_DETAIL_STRING_LENGTH
    ? value
    : `${value.slice(0, MAX_TIMELINE_DETAIL_STRING_LENGTH - 1)}…`;
}

function boundedErrorSummary(error: unknown): string {
  return boundedString(summarizeTimelineValue(error));
}

export function operationTimelineDetail(
  operation: ContextOperationRequest,
  index: number,
  outcome: WorkflowTimelineOperationDetail['outcome'],
  options: { error?: unknown; key?: string } = {},
): WorkflowTimelineOperationDetail {
  return {
    index,
    ...(options.key === undefined ? {} : { key: boundedString(options.key) }),
    operationId: boundedString(operation.operationId),
    operationType: operation.type,
    operationLabel: boundedString(getTimelineOperationLabel(operation)),
    outcome,
    ...((operation as ContextOperationRequest & { documentStep?: number }).documentStep ===
    undefined
      ? {}
      : {
          documentStep: (operation as ContextOperationRequest & { documentStep: number })
            .documentStep,
        }),
    ...((operation as ContextOperationRequest & { documentStepAddress?: string })
      .documentStepAddress === undefined
      ? {}
      : {
          documentStepAddress: (
            operation as ContextOperationRequest & { documentStepAddress: string }
          ).documentStepAddress,
        }),
    ...(options.error === undefined ? {} : { errorSummary: boundedErrorSummary(options.error) }),
  };
}

export function parallelTimelineDetails(
  operations: readonly ContextOperationRequest[],
  slots: readonly ParallelBranchSlot[],
  branchNames?: readonly string[],
): WorkflowTimelineOperationDetail[] {
  return operations.map((operation, index) => {
    const slot = slots[index];
    const detail = operationTimelineDetail(
      operation,
      index,
      slot?.status === 'fulfilled' ? 'fulfilled' : 'rejected',
      {
        ...(branchNames?.[index] === undefined ? {} : { key: branchNames[index] }),
        ...(slot?.status === 'rejected' ? { error: slot.reason } : {}),
      },
    );
    const nested = keyedRaceBranchDetails(operation, slot);
    return nested === undefined ? detail : { ...detail, branches: nested };
  });
}

/**
 * The branches of a keyed `ctx.raceKeyed` that ran as a branch of `ctx.all`, with the winner the
 * slot recorded, so file-workflow history can tell which side of the race settled a document step.
 * Only a race with a document step in it records them: a code workflow's timeline is unchanged. A
 * positional race records no winner key, and a rejected slot no winner, so neither has any.
 */
function keyedRaceBranchDetails(
  operation: ContextOperationRequest,
  slot: ParallelBranchSlot | undefined,
): WorkflowTimelineOperationDetail[] | undefined {
  if (
    operation.type !== 'race' ||
    operation.branchNames === undefined ||
    !operation.operations.some(
      (child) =>
        (child as ContextOperationRequest & { documentStep?: number }).documentStep !== undefined,
    ) ||
    slot?.status !== 'fulfilled' ||
    typeof slot.value !== 'object' ||
    slot.value === null
  ) {
    return undefined;
  }
  const winnerIndex = operation.branchNames.indexOf(Reflect.get(slot.value, 'key') as string);
  if (winnerIndex < 0) return undefined;
  return raceTimelineDetails(operation.operations, winnerIndex, operation.branchNames).slice(
    0,
    MAX_TIMELINE_COORDINATOR_DETAILS,
  );
}

export function raceTimelineDetails(
  operations: readonly ContextOperationRequest[],
  winnerIndex: number,
  branchNames?: readonly string[],
  winnerError?: unknown,
): WorkflowTimelineOperationDetail[] {
  return operations.map((operation, index) =>
    operationTimelineDetail(operation, index, index === winnerIndex ? 'won' : 'lost', {
      ...(branchNames?.[index] === undefined ? {} : { key: branchNames[index] }),
      ...(index === winnerIndex && winnerError !== undefined ? { error: winnerError } : {}),
    }),
  );
}

export function runAllTimelineDetails(
  branchNames: readonly string[],
  slots: readonly ParallelBranchSlot[],
  branches: Record<string, readonly [Function] | readonly [Function, unknown]>,
): WorkflowTimelineOperationDetail[] {
  return branchNames.map((key, index) => {
    const slot = slots[index];
    const branchFunction = branches[key]?.[0];
    return {
      index,
      key: boundedString(key),
      operationId: boundedString(slot?.operationId ?? `run-all:${String(index)}:${key}`),
      operationType: 'activity',
      operationLabel: boundedString(branchFunction?.name || key),
      outcome: slot?.status === 'fulfilled' ? 'fulfilled' : 'rejected',
      ...(slot?.status === 'rejected' ? { errorSummary: boundedErrorSummary(slot.reason) } : {}),
    };
  });
}

function boundedDetails(details: readonly WorkflowTimelineOperationDetail[]): {
  details: WorkflowTimelineOperationDetail[];
  omitted: number;
} {
  return {
    details: details.slice(0, MAX_TIMELINE_COORDINATOR_DETAILS),
    omitted: Math.max(0, details.length - MAX_TIMELINE_COORDINATOR_DETAILS),
  };
}

export function recordTimelineBranches(
  internals: EngineInternals,
  workflowId: string,
  details: readonly WorkflowTimelineOperationDetail[],
): void {
  const entry = internals.pendingTimelineEntries?.get(workflowId)?.entry;
  if (entry === undefined) return;
  const bounded = boundedDetails(details);
  entry.branches = bounded.details;
  if (bounded.omitted > 0) entry.branchesOmitted = bounded.omitted;
}

export function recordTimelineSpeculation(
  internals: EngineInternals,
  workflowId: string,
  details: readonly WorkflowTimelineOperationDetail[],
  outcome: 'committed' | 'rolled-back',
): void {
  const entry = internals.pendingTimelineEntries?.get(workflowId)?.entry;
  if (entry === undefined) return;
  const bounded = boundedDetails(details);
  entry.children = bounded.details;
  if (bounded.omitted > 0) entry.childrenOmitted = bounded.omitted;
  entry.speculationOutcome = outcome;
}

/**
 * Record the task ledger operation id a remote-mode activity was just enqueued under on its
 * pending timeline entry, so `WorkflowTimelineEntry.taskOperationId` names the real ledger key.
 * Only an `activity` entry takes it: while a coordinator (`ctx.all`, `ctx.race`) is the pending
 * entry, its branches' tasks belong to no single entry.
 */
export function recordTimelineTaskIdentity(
  internals: EngineInternals,
  workflowId: string,
  taskOperationId: string,
): void {
  const entry = internals.pendingTimelineEntries?.get(workflowId)?.entry;
  if (entry === undefined || entry.operationType !== 'activity') return;
  entry.taskOperationId = taskOperationId;
}
