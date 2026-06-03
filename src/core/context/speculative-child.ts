import { cloneSessionStateStore } from '../session-state.ts';
import type { SearchAttributeValue } from '../types.ts';
import type { Context } from './index.ts';
import { getInternals, type ContextInternals } from './internals.ts';
import { createCheckpointLocals } from './session-state.ts';
import type { ContextOptions } from './types.ts';

type CreateContext = (options: ContextOptions) => Context;

function cloneMap<TKey, TValue>(
  value: Map<TKey, TValue> | undefined,
): Map<TKey, TValue> | undefined {
  return value === undefined ? undefined : new Map(value);
}

function cloneRecord<TValue>(
  value: Record<string, TValue> | undefined,
): Record<string, TValue> | undefined {
  return value === undefined ? undefined : { ...value };
}

function assignOptionalContextOptions(options: ContextOptions, internals: ContextInternals): void {
  if (internals.deadline !== undefined) options.deadline = internals.deadline;
  if (internals.searchAttributeSchema !== undefined) {
    options.searchAttributeSchema = internals.searchAttributeSchema;
  }
  if (internals.sleepReferenceTime !== undefined) {
    options.sleepReferenceTime = internals.sleepReferenceTime;
  }
  if (internals.resolveWorkflowType !== undefined) {
    options.resolveWorkflowType = internals.resolveWorkflowType;
  }
  if (internals.services !== undefined) {
    options.services = internals.services;
  }
}

function createSpeculativeChildOptions(
  parent: Context,
  internals: ContextInternals,
): ContextOptions {
  const options: ContextOptions = {
    workflowId: parent.workflowId,
    workflowType: parent.workflowType,
    startedAt: parent.startedAt,
    abortController: internals.abortController,
    getNow: internals.getNow,
    initialStep: internals.stepIndex,
    locals: internals.checkpointLocals,
    searchAttributes: internals.searchAttributes,
    nestingDepth: internals.nestingDepth,
    executionStateOwnerId: internals.executionStateOwnerId,
  };
  const accumulatedResults = cloneMap(internals.accumulatedResults);
  if (accumulatedResults !== undefined) options.accumulatedResults = accumulatedResults;
  assignOptionalContextOptions(options, internals);
  return options;
}

function cloneSpeculativeRuntimeState(
  childInternals: ContextInternals,
  parentInternals: ContextInternals,
): void {
  childInternals.pendingAttributeChanges = cloneRecord<SearchAttributeValue>(
    parentInternals.pendingAttributeChanges,
  );
  childInternals.updateHandlers = cloneMap(parentInternals.updateHandlers);
  childInternals.updateValidators = cloneMap(parentInternals.updateValidators);
  childInternals.queryHandlers = cloneMap(parentInternals.queryHandlers);
  childInternals.exposedValues = cloneMap(parentInternals.exposedValues);
  childInternals.memoCache = cloneMap(parentInternals.memoCache);
  childInternals.explainMode = parentInternals.explainMode;
  childInternals.workflowInterceptor = parentInternals.workflowInterceptor;
}

export function createSpeculativeChild(parent: Context, createContext: CreateContext): Context {
  const internals = getInternals(parent);
  const child = createContext(createSpeculativeChildOptions(parent, internals));
  cloneSpeculativeRuntimeState(getInternals(child), internals);
  return child;
}

export function commitSpeculativeChild(parent: Context, child: Context): void {
  const internals = getInternals(parent);
  const childInternals = getInternals(child);
  internals.stepIndex = childInternals.stepIndex;
  internals.accumulatedResults = cloneMap(childInternals.accumulatedResults);
  internals.stateSession = cloneSessionStateStore(childInternals.stateSession);
  internals.checkpointLocals = createCheckpointLocals(
    internals.stateSession,
    childInternals.checkpointLocals,
  );
  internals.searchAttributes = { ...childInternals.searchAttributes };
  internals.pendingAttributeChanges = cloneRecord<SearchAttributeValue>(
    childInternals.pendingAttributeChanges,
  );
  internals.updateHandlers = cloneMap(childInternals.updateHandlers);
  internals.updateValidators = cloneMap(childInternals.updateValidators);
  internals.queryHandlers = cloneMap(childInternals.queryHandlers);
  internals.exposedValues = cloneMap(childInternals.exposedValues);
  internals.memoCache = cloneMap(childInternals.memoCache);
  internals.sleepReferenceTime = childInternals.sleepReferenceTime;
}
