import type { SearchAttributeSchema, SearchAttributeValue } from '../types.ts';
import type { Context, ContextOptions } from './index.ts';
import { createCheckpointLocals } from './session-state.ts';

export interface ContextInternals {
  context: Context;
  abortController: AbortController;
  stepIndex: number;
  accumulatedResults: Map<number, unknown> | undefined;
  checkpointLocals: Record<string, unknown>;
  stateSession: Record<string, unknown> | undefined;
  searchAttributes: Record<string, SearchAttributeValue>;
  searchAttributeSchema: SearchAttributeSchema | undefined;
  pendingAttributeChanges: Record<string, SearchAttributeValue> | undefined;
  updateHandlers: Map<string, (payload: unknown) => unknown> | undefined;
  queryHandlers: Map<string, (input: unknown) => unknown> | undefined;
  exposedValues: Map<string, () => unknown> | undefined;
  memoCache: Map<string, unknown> | undefined;
  deadline: number | undefined;
  getNow: () => number;
  sleepReferenceTime: number | undefined;
  explainMode: boolean;
  nestingDepth: number;
  executionStateOwnerId: string;
  resolveWorkflowType: ((target: string | Function) => string) | undefined;
}

const INTERNALS = new WeakMap<Context, ContextInternals>();

export function initializeInternals(
  context: Context,
  options: ContextOptions,
  initialSessionState: Record<string, unknown> | undefined,
): void {
  const internals: ContextInternals = {
    context,
    abortController: options.abortController,
    stepIndex: options.initialStep ?? 0,
    accumulatedResults: options.accumulatedResults,
    stateSession: initialSessionState,
    checkpointLocals: createCheckpointLocals(initialSessionState, options.locals),
    searchAttributes: options.searchAttributes ? { ...options.searchAttributes } : {},
    searchAttributeSchema: options.searchAttributeSchema,
    pendingAttributeChanges: undefined,
    updateHandlers: undefined,
    queryHandlers: undefined,
    exposedValues: undefined,
    memoCache: undefined,
    deadline: options.deadline,
    getNow: options.getNow ?? Date.now,
    sleepReferenceTime: options.sleepReferenceTime,
    explainMode: false,
    nestingDepth: options.nestingDepth ?? 0,
    executionStateOwnerId: options.executionStateOwnerId ?? options.workflowId,
    resolveWorkflowType: options.resolveWorkflowType,
  };
  INTERNALS.set(context, internals);
}

export function getInternals(context: Context): ContextInternals {
  const internals = INTERNALS.get(context);
  if (!internals) throw new Error('Context internals not initialized');
  return internals;
}
