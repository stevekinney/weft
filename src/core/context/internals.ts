import type { ComposedWorkflowInterceptor } from '../interceptor.ts';
import type { SearchAttributeSchema, SearchAttributeValue } from '../types.ts';
import type { WorkflowLogRecord } from '../types/workflow-log.ts';
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
  workflowInterceptor: ComposedWorkflowInterceptor | null | undefined;
  pendingAttributeChanges: Record<string, SearchAttributeValue> | undefined;
  updateHandlers: Map<string, (payload: unknown) => unknown> | undefined;
  updateValidators: Map<string, (payload: unknown) => unknown> | undefined;
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
  registerCancelHandler: ((handler: () => Promise<void> | void) => () => void) | undefined;
  services: unknown;
  /**
   * Host sink for `ctx.log` records (`EngineOptions.onLog`), or `undefined` for the
   * default console behavior. Captured by value when the `ctx.log` getter first
   * builds its logger; `onLog` is fixed at engine construction, so there is nothing
   * to re-read per emit.
   */
  logSink: ((record: WorkflowLogRecord) => void) | undefined;
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
    workflowInterceptor: undefined,
    pendingAttributeChanges: undefined,
    updateHandlers: undefined,
    updateValidators: undefined,
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
    registerCancelHandler: options.registerCancelHandler,
    services: options.services,
    logSink: options.logSink,
  };
  INTERNALS.set(context, internals);
}

export function getInternals(context: Context): ContextInternals {
  const internals = INTERNALS.get(context);
  if (!internals) throw new Error('Context internals not initialized');
  return internals;
}

/**
 * Non-throwing probe: is `value` a concrete {@link Context} with initialized
 * internals? Used to distinguish the inline-mode `Context` (which carries the
 * `stepIndex`/`accumulatedResults` replay machinery) from the minimal
 * worker-mode `WorkerWorkflowContext`, which is a different shape. WeakMap
 * `.has` accepts any object key and returns `false` for non-`Context` objects,
 * so this is safe to call on any context-shaped value.
 */
export function hasContextInternals(value: object): value is Context {
  return INTERNALS.has(value as Context);
}
