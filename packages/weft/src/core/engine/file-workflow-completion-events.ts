/**
 * The completion half of a file workflow's lifecycle history: the `activity-completed`,
 * `signal-received` and `step-completed` events a settled timeline entry makes durable. A step at
 * the top level, a branch of `ctx.all`, and a branch of a keyed `ctx.raceKeyed` (alone, or nested in
 * a branch of `ctx.all`) all record the events a plain top-level step would.
 */

import type { ContextOperationRequest } from '../context.ts';
import { branchDriversOf } from '../context/branch-driver.ts';
import { getTimelineOperationLabel } from './state-utilities.ts';

export type FileWorkflowEvent = Readonly<{ type: string; payload: Record<string, unknown> }>;

/** The `stepAddress` field of an event, absent when the address is the step's own index. */
export function addressPayload(address: string, step: number): Record<string, unknown> {
  return address === String(step) ? {} : { stepAddress: address };
}

type StepKind = 'activity' | 'await-signal' | 'sleep';

function stepCompleted(
  step: number,
  addressFields: Record<string, unknown>,
  kind: StepKind,
): FileWorkflowEvent {
  return { type: 'file-workflow:step-completed', payload: { step, ...addressFields, kind } };
}

/**
 * A signal wait's completion: `signal-received` and `step-completed`, or `step-completed` alone
 * for a wait that lost a race to its timeout, which received no signal.
 */
function waitCompletionEvents(
  step: number,
  addressFields: Record<string, unknown>,
  signal: string,
  received: boolean,
): FileWorkflowEvent[] {
  return [
    ...(received
      ? [{ type: 'file-workflow:signal-received', payload: { step, ...addressFields, signal } }]
      : []),
    stepCompleted(step, addressFields, 'await-signal'),
  ];
}

type SettledStep = {
  operationType: string;
  operationLabel: string;
  stepIndex?: number;
  documentStep?: number;
  documentStepAddress?: string;
  status: string;
};

function activityCompletionEvents(
  step: number,
  addressFields: Record<string, unknown>,
  handler: string,
): FileWorkflowEvent[] {
  return [
    { type: 'file-workflow:activity-completed', payload: { step, ...addressFields, handler } },
    stepCompleted(step, addressFields, 'activity'),
  ];
}

/** The document step index and the `stepAddress` field a settled step's events carry. */
function stepIdentity(pending: SettledStep): [number, Record<string, unknown>] {
  const step = pending.documentStep ?? pending.stepIndex ?? 0;
  return [step, addressPayload(String(pending.documentStepAddress ?? step), step)];
}

function completionEvents(pending: SettledStep | undefined): FileWorkflowEvent[] {
  if (pending?.status !== 'completed') return [];
  if (pending.documentStep === undefined && pending.operationType !== 'activity') return [];
  const [step, addressFields] = stepIdentity(pending);
  switch (pending.operationType) {
    case 'activity':
      return activityCompletionEvents(step, addressFields, pending.operationLabel);
    case 'wait-signal':
      return waitCompletionEvents(step, addressFields, pending.operationLabel, true);
    case 'sleep':
      return [stepCompleted(step, addressFields, 'sleep')];
    default:
      return [];
  }
}

type BranchDetail = Omit<SettledStep, 'status'> & {
  outcome: string;
  /** A keyed race that ran as a branch of `ctx.all` carries its own branches. */
  branches?: readonly BranchDetail[];
};

/** A document wait that lost its race lost to its timeout: it completes with no signal received. */
function lostWaitEvents(branch: BranchDetail): FileWorkflowEvent[] {
  const step = branch.documentStep;
  if (branch.operationType !== 'wait-signal' || step === undefined) return [];
  const addressFields = addressPayload(String(branch.documentStepAddress ?? step), step);
  return waitCompletionEvents(step, addressFields, branch.operationLabel, false);
}

/**
 * What a settled coordinator's branches complete. A fulfilled or winning step branch completes as
 * the same step would at the top level; a race inside a branch reports through its own branches.
 */
function branchCompletionEvents(
  branches: readonly BranchDetail[],
  inRace: boolean,
): FileWorkflowEvent[] {
  return branches.flatMap((branch) => {
    if (branch.operationType === 'race') {
      return branch.outcome === 'fulfilled'
        ? branchCompletionEvents(branch.branches ?? [], true)
        : [];
    }
    if (inRace && branch.outcome === 'lost') return lostWaitEvents(branch);
    if (branch.outcome !== 'fulfilled' && branch.outcome !== 'won') return [];
    return completionEvents({ ...branch, status: 'completed' });
  });
}

/**
 * What a settled request completed: the file-workflow events its document steps record, and the
 * operation ids of the activities that ran under it, whose completion receipts the engine reports.
 */
export type SettledRequestCompletion = {
  events: FileWorkflowEvent[];
  activityOperationIds: string[];
};

function settledStepOf(request: ContextOperationRequest): SettledStep {
  const { documentStep, documentStepAddress } = request as ContextOperationRequest & {
    documentStep?: number;
    documentStepAddress?: string;
  };
  return {
    operationType: request.type,
    operationLabel: getTimelineOperationLabel(request),
    ...(documentStep === undefined ? {} : { documentStep }),
    ...(documentStepAddress === undefined ? {} : { documentStepAddress }),
    status: 'completed',
  };
}

function isFulfilledOutcome(outcome: unknown): outcome is { status: 'fulfilled'; value: unknown } {
  return (
    typeof outcome === 'object' &&
    outcome !== null &&
    Reflect.get(outcome, 'status') === 'fulfilled'
  );
}

/** The index of the branch a settled keyed race took, from the key its value carries. */
function keyedWinnerIndex(
  request: Extract<ContextOperationRequest, { type: 'race' }>,
  value: unknown,
): number | undefined {
  if (request.branchNames === undefined || typeof value !== 'object' || value === null) {
    return undefined;
  }
  const index = request.branchNames.indexOf(Reflect.get(value, 'key') as string);
  return index < 0 ? undefined : index;
}

/** The branches of a settled `ctx.all` or `ctx.allSettled` that fulfilled, with their values. */
function fulfilledChildren(
  request: Extract<ContextOperationRequest, { type: 'parallel' }>,
  value: unknown,
): [ContextOperationRequest, unknown][] {
  const results = Array.isArray(value) ? (value as unknown[]) : [];
  return request.operations.flatMap((child, index): [ContextOperationRequest, unknown][] => {
    if (request.settle !== 'settled')
      return index < results.length ? [[child, results[index]]] : [];
    const outcome = results[index];
    return isFulfilledOutcome(outcome) ? [[child, outcome.value]] : [];
  });
}

function collectRaceCompletion(
  request: Extract<ContextOperationRequest, { type: 'race' }>,
  value: unknown,
  completion: SettledRequestCompletion,
): void {
  const winner = keyedWinnerIndex(request, value);
  if (winner === undefined) return;
  for (const [index, child] of request.operations.entries()) {
    if (index === winner) {
      collectCompletion(child, Reflect.get(value as object, 'value'), completion);
    } else {
      completion.events.push(...lostWaitEvents({ ...settledStepOf(child), outcome: 'lost' }));
    }
  }
}

function collectCompletion(
  request: ContextOperationRequest,
  value: unknown,
  completion: SettledRequestCompletion,
): void {
  if (request.type === 'activity') completion.activityOperationIds.push(request.operationId);
  if (['activity', 'sleep', 'wait-signal'].includes(request.type)) {
    completion.events.push(...completionEvents(settledStepOf(request)));
  } else if (request.type === 'race') {
    collectRaceCompletion(request, value, completion);
  } else if (request.type === 'parallel' && branchDriversOf(request) === undefined) {
    // An advancing parallel step reports each of its steps as it settles it, so it is skipped here.
    for (const [child, childValue] of fulfilledChildren(request, value)) {
      collectCompletion(child, childValue, completion);
    }
  }
}

/**
 * What a request that settled with `value` completed, at any depth: a step of a document completes
 * as it would at the top level, a nested `ctx.all` or `ctx.allSettled` through the branches that
 * fulfilled, and a keyed race through the branch that won, with a wait that lost to its timeout
 * completing without a signal received.
 */
export function requestCompletion(
  request: ContextOperationRequest,
  value: unknown,
): SettledRequestCompletion {
  const completion: SettledRequestCompletion = { events: [], activityOperationIds: [] };
  collectCompletion(request, value, completion);
  return completion;
}

/**
 * The completion a coordinator derived from its requests, held with its pending timeline entry:
 * what the commit that settles the entry reports in its place. It lives and dies with the entry, in
 * memory, because the requests it came from do not survive a restart either.
 */
const STAGED_COMPLETIONS = new WeakMap<object, SettledRequestCompletion>();

export function stageCoordinatorCompletion(
  entry: object,
  completion: SettledRequestCompletion,
): void {
  STAGED_COMPLETIONS.set(entry, completion);
}

export function stagedCoordinatorCompletion(entry: object): SettledRequestCompletion | undefined {
  return STAGED_COMPLETIONS.get(entry);
}

/**
 * The completion events a pending timeline entry makes durable, on the checkpoint path and the
 * terminal path alike: a settled step's own, or a settled `ctx.all` or `ctx.race`'s branches'.
 */
export function pendingCompletionEvents(
  pending: (SettledStep & { branches?: readonly BranchDetail[] }) | undefined,
): FileWorkflowEvent[] {
  if (pending === undefined) return [];
  const staged = STAGED_COMPLETIONS.get(pending);
  if (staged !== undefined) return pending.status === 'completed' ? staged.events : [];
  if (pending.operationType === 'parallel' || pending.operationType === 'race') {
    return pending.status === 'completed'
      ? branchCompletionEvents(pending.branches ?? [], pending.operationType === 'race')
      : [];
  }
  return completionEvents(pending);
}
