import type { ContextOperationRequest } from '../context.ts';
import type { ParallelBranchSlot } from '../context/parallel-operations.ts';
import type { WorkflowTimelineOperationDetail } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { getTimelineOperationLabel, summarizeTimelineValue } from './state-utilities.ts';
import {
  MAX_TIMELINE_COORDINATOR_DETAILS,
  MAX_TIMELINE_DETAIL_STRING_LENGTH,
} from './timeline-coordinator-constants.ts';

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
    return operationTimelineDetail(
      operation,
      index,
      slot?.status === 'fulfilled' ? 'fulfilled' : 'rejected',
      {
        ...(branchNames?.[index] === undefined ? {} : { key: branchNames[index] }),
        ...(slot?.status === 'rejected' ? { error: slot.reason } : {}),
      },
    );
  });
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
