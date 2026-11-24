import type { ComposedWorkflowInterceptor } from '../interceptor.ts';
import type { SearchAttributeSchema, SearchAttributeValue } from '../types.ts';
import type { WorkflowLogRecord } from '../types/workflow-log.ts';
import type { Context, ContextOptions } from './index.ts';
import type { ContextOperationRequest } from './operation-request.ts';
import { createCheckpointLocals } from './session-state.ts';

export interface ContextInternals {
  context: Context;
  abortController: AbortController;
  stepIndex: number;
  /**
   * Names the branch of an advancing parallel step whose operations are running, or `undefined` at
   * the workflow's top level. A branch counts its steps from zero and keeps its own results, so the
   * state a step keeps under its number in the checkpoint's locals is qualified by this name; see
   * {@link stepStateKey}.
   */
  branchNamespace: string | undefined;
  /**
   * How many lockstep parallel steps enclose the operations running now: a parallel step a run
   * began before branches advanced on their own, which every parallel step nested in it follows.
   */
  lockstepDepth: number;
  /** See {@link ContextOptions.logStep}; `undefined` stamps `ctx.log` records with `stepIndex`. */
  logStep: number | undefined;
  accumulatedResults: Map<number, unknown> | undefined;
  /**
   * True from the moment a relaunched run's body starts until it first yields an operation (or
   * ends): everything it logs in that stretch was logged by the execution it continues. See
   * {@link ContextOptions.resumed}.
   */
  replayingToPark: boolean;
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
  /**
   * Engine callback that durably records `ctx.setFinalizerState(value)` payloads
   * (#446); `undefined` in speculative branches, where the branch reuses this
   * inline {@link Context} but the engine leaves the callback unset, so
   * `ctx.setFinalizerState` throws a descriptive guard error. (Worker-mode
   * generators never reach this field at all — they receive a reduced worker-side
   * context that does not carry `setFinalizerState`, so the call fails there with a
   * `TypeError`.) Finalizer *registration* and teardown are unaffected — those run
   * on the engine host in every mode (#564). Injected at context construction,
   * mirroring {@link registerCancelHandler}.
   */
  recordFinalizerState: ((value: unknown) => void) | undefined;
}

const INTERNALS = new WeakMap<Context, ContextInternals>();

/**
 * The key under which a step keeps its own state in the checkpoint's locals (a retry's attempt, a
 * sleep's deadline) and in the heartbeat and async-completion identity of its activity: the step
 * number at the workflow's top level, so a run persisted before branches counted their own steps
 * keeps every key, and the number qualified by the branch's name inside one, where two branches
 * each have a step 0.
 */
export function stepStateKey(
  internals: Pick<ContextInternals, 'branchNamespace'>,
  step: number,
): number | string {
  return internals.branchNamespace === undefined ? step : `${internals.branchNamespace}:${step}`;
}

export function initializeInternals(
  context: Context,
  options: ContextOptions,
  initialSessionState: Record<string, unknown> | undefined,
): void {
  const internals: ContextInternals = {
    context,
    abortController: options.abortController,
    stepIndex: options.initialStep ?? 0,
    branchNamespace: undefined,
    lockstepDepth: 0,
    logStep: options.logStep,
    accumulatedResults: options.accumulatedResults,
    replayingToPark: options.resumed === true,
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
    recordFinalizerState: options.recordFinalizerState,
  };
  INTERNALS.set(context, internals);
}

export function getInternals(context: Context): ContextInternals {
  const internals = INTERNALS.get(context);
  if (!internals) throw new Error('Context internals not initialized');
  return internals;
}

/**
 * Yield an uncached operation request and, however it settles, retire the
 * resumed checkpoint's `sleepReferenceTime`. That anchor stands for "now" only
 * at the parked moment the run resumed from; once the engine hands back a result
 * (or throws in) time has moved on, so a later `ctx.sleep` or `ctx.waitUntil`
 * deadline must read the clock. Clearing after the yield rather than before keeps
 * the anchor for every operation issued at that moment, including sibling
 * branches that `ctx.all`/`ctx.race` prime before their own yield.
 */
export function* yieldOperation(
  internals: ContextInternals,
  request: ContextOperationRequest,
): Generator<ContextOperationRequest, unknown, unknown> {
  try {
    return yield request;
  } finally {
    internals.sleepReferenceTime = undefined;
  }
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
