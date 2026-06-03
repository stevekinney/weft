import type { ComposedWorkflowInterceptor } from '../interceptor.ts';
import type { HumanReviewOptions, HumanReviewResult } from '../review/index.ts';
import { normalizeSessionStateLocals } from '../session-state.ts';
import type {
  ActivityCallable,
  ActivityCallOptions,
  ChildWorkflowOptions,
  ChildWorkflowTarget,
  Duration,
  MessageName,
  QueryDefinition,
  RunAllResult,
  SearchAttributeHandle,
  SearchAttributeValue,
  SignalDefinition,
  UpdateDefinition,
  WorkflowContext,
  WorkflowMapOptions,
  WorkflowOperation,
  WorkflowOperationTupleResult,
  WorkflowPipeStage,
  WorkflowPipeStageDefinition,
  WorkflowReduceInput,
  WorkflowReduceOptions,
  WorkflowRunAllBranch,
  WorkflowStateNamespace,
} from '../types.ts';
import { messageName, searchAttributeName } from '../types.ts';
import * as contextAttributes from './attributes.ts';
import * as childWorkflowPipe from './child-workflow-pipe.ts';
import * as durableOperations from './durable-operations.ts';
import { getInternals, initializeInternals } from './internals.ts';
import type { ContextOperationRequest } from './operation-request.ts';
import * as parallelOperations from './parallel-operations.ts';
import { runActivityWithRetry } from './run-operation.ts';
import * as sagaHelpers from './saga.ts';
import * as speculateOperations from './speculate-operations.ts';
import {
  commitSpeculativeChild as commitSpeculativeChildState,
  createSpeculativeChild as createSpeculativeChildState,
} from './speculative-child.ts';
import * as stateNamespaceHelpers from './state-namespace.ts';
import type {
  ContextOptions,
  ErasedSagaStep,
  OffloadReference,
  StreamReference,
  StreamSink,
} from './types.ts';
import * as contextUpdates from './updates.ts';
export type { ContextOperationRequest } from './operation-request.ts';
export type {
  ContextOptions,
  OffloadReference,
  SagaStep,
  StoredStreamChunk,
  StreamReference,
  StreamSink,
} from './types.ts';

export function setContextWorkflowInterceptor(
  context: Context,
  workflowInterceptor: ComposedWorkflowInterceptor | null,
): void {
  getInternals(context).workflowInterceptor = workflowInterceptor;
}

/**
 * Concrete workflow execution context injected as the first argument of every
 * registered workflow generator. Implements durable operations such as `run`,
 * `sleep`, `waitForSignal`, `review`, `offload`, `stream`, and `saga`.
 *
 * @example
 * ```ts
 * import { Context } from '@lostgradient/weft';
 *
 * const ctx = new Context({ workflowId: 'wf-demo', workflowType: 'demo', startedAt: Date.now(), abortController: new AbortController() });
 * void ctx;
 * ```
 */
export class Context implements WorkflowContext {
  readonly workflowId: string;
  readonly workflowType: string;
  readonly startedAt: number;
  readonly signal: AbortSignal;
  constructor(options: ContextOptions) {
    this.workflowId = options.workflowId;
    this.workflowType = options.workflowType;
    this.startedAt = options.startedAt;
    this.signal = options.abortController.signal;
    const initialSessionState = normalizeSessionStateLocals(options.locals);
    initializeInternals(this, options, initialSessionState);
  }
  get executionTimeRemaining(): number {
    const internals = getInternals(this);
    if (internals.deadline === undefined) return Infinity;
    return Math.max(0, internals.deadline - internals.getNow());
  }
  get services(): unknown {
    return getInternals(this).services;
  }
  get stepIndex(): number {
    return getInternals(this).stepIndex;
  }
  get nestingDepth(): number {
    return getInternals(this).nestingDepth;
  }
  get accumulatedResults(): Map<number, unknown> {
    const internals = getInternals(this);
    internals.accumulatedResults ??= new Map();
    return internals.accumulatedResults;
  }
  get checkpointLocals(): Record<string, unknown> {
    return getInternals(this).checkpointLocals;
  }
  get pendingAttributeChanges(): Record<string, SearchAttributeValue> {
    const internals = getInternals(this);
    internals.pendingAttributeChanges ??= {};
    return internals.pendingAttributeChanges;
  }
  get exposedAccessors(): Map<string, () => unknown> {
    const internals = getInternals(this);
    internals.exposedValues ??= new Map();
    return internals.exposedValues;
  }
  get updateHandlers(): Map<string, (payload: unknown) => unknown> {
    const internals = getInternals(this);
    internals.updateHandlers ??= new Map();
    return internals.updateHandlers;
  }
  get updateValidators(): Map<string, (payload: unknown) => unknown> {
    const internals = getInternals(this);
    internals.updateValidators ??= new Map();
    return internals.updateValidators;
  }
  get queryHandlers(): Map<string, (input: unknown) => unknown> {
    const internals = getInternals(this);
    internals.queryHandlers ??= new Map();
    return internals.queryHandlers;
  }
  get explainEnabled(): boolean {
    return getInternals(this).explainMode;
  }
  get checkpointAccumulatedResults(): Array<[number, unknown]> {
    const accumulatedResults = getInternals(this).accumulatedResults;
    return accumulatedResults ? Array.from(accumulatedResults.entries()) : [];
  }
  get checkpointPendingAttributeChanges(): Record<string, SearchAttributeValue> | undefined {
    const pendingAttributeChanges = getInternals(this).pendingAttributeChanges;
    return pendingAttributeChanges ? { ...pendingAttributeChanges } : undefined;
  }
  get hasPendingAttributeChanges(): boolean {
    const pendingAttributeChanges = getInternals(this).pendingAttributeChanges;
    return pendingAttributeChanges !== undefined && Object.keys(pendingAttributeChanges).length > 0;
  }
  get hasUpdateHandlers(): boolean {
    const updateHandlers = getInternals(this).updateHandlers;
    return updateHandlers !== undefined && updateHandlers.size > 0;
  }
  get hasExposedAccessors(): boolean {
    const exposedValues = getInternals(this).exposedValues;
    return exposedValues !== undefined && exposedValues.size > 0;
  }
  createSpeculativeChild(): Context {
    return createSpeculativeChildState(this, (options) => new Context(options));
  }
  commitSpeculativeChild(child: Context): void {
    commitSpeculativeChildState(this, child);
  }
  get state(): WorkflowStateNamespace {
    return stateNamespaceHelpers.createStateNamespace(this, getInternals(this));
  }
  // Permissive string-name fallback. The concrete Context class is the
  // runtime engine view, so any registered workflow can be dispatched by
  // name; inputs are `unknown` at this boundary.
  run<TName extends string>(
    name: TName,
    input?: unknown,
    options?: ActivityCallOptions,
  ): Generator<ContextOperationRequest, unknown, unknown>;
  run<TResult>(
    fn: ActivityCallable<void, TResult>,
    options?: ActivityCallOptions,
  ): Generator<ContextOperationRequest, TResult, unknown>;
  run<TResult>(
    fn: (() => Promise<TResult> | TResult) & { execute?: never },
    options?: ActivityCallOptions,
  ): Generator<ContextOperationRequest, TResult, unknown>;
  run<TInput, TResult>(
    fn: ActivityCallable<TInput, TResult>,
    input: TInput,
    options?: ActivityCallOptions,
  ): Generator<ContextOperationRequest, TResult, unknown>;
  run<TInput, TResult>(
    fn: ((input: TInput) => Promise<TResult> | TResult) & { execute?: never },
    input: TInput,
    options?: ActivityCallOptions,
  ): Generator<ContextOperationRequest, TResult, unknown>;
  *run<TInput, TResult>(
    activity:
      | string
      | ActivityCallable<void, TResult>
      | ((() => Promise<TResult> | TResult) & { execute?: never })
      | ActivityCallable<TInput, TResult>
      | (((input: TInput) => Promise<TResult> | TResult) & { execute?: never }),
    ...rest: unknown[]
  ): Generator<ContextOperationRequest, TResult, unknown> {
    return yield* runActivityWithRetry(this, activity, rest);
  }
  *sleep(duration: Duration): Generator<ContextOperationRequest, void, unknown> {
    const internals = getInternals(this);
    const prepared = durableOperations.prepareSleepOperation(internals, duration);
    if (prepared.cached) return;
    const execute = () => durableOperations.completePreparedSleepOperation(this, prepared);
    if (!internals.workflowInterceptor) {
      return yield* execute();
    }
    return yield* internals.workflowInterceptor.sleep(
      {
        workflowId: this.workflowId,
        duration: prepared.milliseconds,
        headers: new Map<string, string>(),
      },
      execute,
    ) as Generator<ContextOperationRequest, void, unknown>;
  }
  *suspendUntil<T = unknown>(resumeToken: string): Generator<ContextOperationRequest, T, unknown> {
    return yield* this.waitForSignal<T>(resumeToken);
  }
  waitForSignal<TInput>(
    definition: SignalDefinition<TInput>,
  ): Generator<ContextOperationRequest, TInput, unknown>;
  waitForSignal<T = unknown>(name: string): Generator<ContextOperationRequest, T, unknown>;
  *waitForSignal<T = unknown>(
    nameOrDefinition: MessageName,
  ): Generator<ContextOperationRequest, T, unknown> {
    const internals = getInternals(this);
    const signalName = messageName(nameOrDefinition);
    const execute = () => durableOperations.waitForSignal<T>(this, internals, signalName);
    if (internals.accumulatedResults?.has(internals.stepIndex)) {
      return yield* execute();
    }
    if (!internals.workflowInterceptor) {
      return yield* execute();
    }
    return (yield* internals.workflowInterceptor.waitForSignal(
      {
        workflowId: this.workflowId,
        signalName,
        payload: undefined,
        headers: new Map<string, string>(),
      },
      execute,
    ) as Generator<ContextOperationRequest, unknown, unknown>) as T;
  }
  waitForUpdate<TInput, TOutput>(
    definition: UpdateDefinition<TInput, TOutput>,
  ): Generator<
    ContextOperationRequest,
    { payload: TInput; respond: (result: TOutput) => void },
    unknown
  >;
  waitForUpdate<T = unknown>(
    name: string,
  ): Generator<
    ContextOperationRequest,
    { payload: T; respond: (result: unknown) => void },
    unknown
  >;
  *waitForUpdate<T = unknown>(
    nameOrDefinition: MessageName,
  ): Generator<
    ContextOperationRequest,
    { payload: T; respond: (result: unknown) => void },
    unknown
  > {
    return yield* durableOperations.waitForUpdate<T>(
      this,
      getInternals(this),
      messageName(nameOrDefinition),
    );
  }
  *review(
    options: HumanReviewOptions,
  ): Generator<ContextOperationRequest, HumanReviewResult, unknown> {
    return yield* durableOperations.review(this, getInternals(this), options);
  }
  *all<const TOperations extends readonly WorkflowOperation<unknown>[]>(
    operations: TOperations,
  ): Generator<ContextOperationRequest, WorkflowOperationTupleResult<TOperations>, unknown> {
    return (yield* parallelOperations.all(this, getInternals(this), [...operations] as Generator<
      ContextOperationRequest,
      unknown,
      unknown
    >[])) as WorkflowOperationTupleResult<TOperations>;
  }
  *race<const TOperations extends readonly WorkflowOperation<unknown>[]>(
    operations: TOperations,
  ): Generator<
    ContextOperationRequest,
    WorkflowOperationTupleResult<TOperations>[number],
    unknown
  > {
    return (yield* parallelOperations.race(this, getInternals(this), [...operations] as Generator<
      ContextOperationRequest,
      unknown,
      unknown
    >[])) as WorkflowOperationTupleResult<TOperations>[number];
  }
  *memo<T>(key: string, fn: () => T | Promise<T>): Generator<ContextOperationRequest, T, unknown> {
    return yield* parallelOperations.memo(this, getInternals(this), key, fn);
  }
  *offload<T>(
    key: string,
    fn: () => Promise<T>,
  ): Generator<ContextOperationRequest, OffloadReference, unknown> {
    return yield* durableOperations.offload(this, getInternals(this), key, fn);
  }
  *stream(
    key: string,
    fn: (sink: StreamSink) => AsyncGenerator<unknown, void, unknown>,
  ): Generator<ContextOperationRequest, StreamReference, unknown> {
    return yield* durableOperations.stream(this, getInternals(this), key, fn);
  }
  *load<T>(reference: OffloadReference): Generator<ContextOperationRequest, T, unknown> {
    return yield* durableOperations.load<T>(this, getInternals(this), reference);
  }
  *archive(key: string, data: unknown): Generator<ContextOperationRequest, void, unknown> {
    return yield* durableOperations.archive(this, getInternals(this), key, data);
  }
  *runAll<const TBranches extends Record<string, WorkflowRunAllBranch>>(
    branches: TBranches,
  ): Generator<ContextOperationRequest, RunAllResult<TBranches>, unknown> {
    return (yield* parallelOperations.runAll(
      this,
      getInternals(this),
      branches as Record<string, readonly [Function] | readonly [Function, unknown]>,
    )) as RunAllResult<TBranches>;
  }
  *saga<TFinalOutput = unknown>(
    steps: ErasedSagaStep[],
  ): Generator<ContextOperationRequest, TFinalOutput, unknown> {
    return yield* sagaHelpers.saga<TFinalOutput>(this, steps);
  }
  *startChild<TResult = unknown>(
    workflowType: string,
    input: unknown,
    options?: ChildWorkflowOptions,
  ): Generator<ContextOperationRequest, TResult, unknown> {
    return yield* childWorkflowPipe.startChild<TResult>(
      this,
      getInternals(this),
      workflowType,
      input,
      options,
    );
  }
  pipe<TInput, TOutput>(
    stages: [WorkflowPipeStageDefinition<TInput, TOutput>],
    input: TInput,
  ): Generator<ContextOperationRequest, TOutput, unknown>;
  pipe<TInput, TIntermediate, TOutput>(
    stages: [
      WorkflowPipeStageDefinition<TInput, TIntermediate>,
      WorkflowPipeStageDefinition<TIntermediate, TOutput>,
    ],
    input: TInput,
  ): Generator<ContextOperationRequest, TOutput, unknown>;
  pipe<TInput, TFirst, TSecond, TOutput>(
    stages: [
      WorkflowPipeStageDefinition<TInput, TFirst>,
      WorkflowPipeStageDefinition<TFirst, TSecond>,
      WorkflowPipeStageDefinition<TSecond, TOutput>,
    ],
    input: TInput,
  ): Generator<ContextOperationRequest, TOutput, unknown>;
  pipe<TInput, TFirst, TSecond, TThird, TOutput>(
    stages: [
      WorkflowPipeStageDefinition<TInput, TFirst>,
      WorkflowPipeStageDefinition<TFirst, TSecond>,
      WorkflowPipeStageDefinition<TSecond, TThird>,
      WorkflowPipeStageDefinition<TThird, TOutput>,
    ],
    input: TInput,
  ): Generator<ContextOperationRequest, TOutput, unknown>;
  *pipe<TResult = unknown>(
    stages: Array<WorkflowPipeStage | ChildWorkflowTarget>,
    input: unknown,
  ): Generator<ContextOperationRequest, TResult, unknown> {
    return yield* childWorkflowPipe.pipe<TResult>(this, getInternals(this), stages, input);
  }
  *map<TItem, TResult>(
    items: readonly TItem[],
    workflowType: ChildWorkflowTarget<TItem, TResult>,
    options?: WorkflowMapOptions,
  ): Generator<ContextOperationRequest, TResult[], unknown> {
    return yield* childWorkflowPipe.map(this, getInternals(this), items, workflowType, options);
  }
  *reduce<TItem, TAccumulator>(
    items: readonly TItem[],
    workflowType: ChildWorkflowTarget<WorkflowReduceInput<TAccumulator, TItem>, TAccumulator>,
    initialValue: TAccumulator,
    options?: WorkflowReduceOptions,
  ): Generator<ContextOperationRequest, TAccumulator, unknown> {
    return yield* childWorkflowPipe.reduce(
      this,
      getInternals(this),
      items,
      workflowType,
      initialValue,
      options,
    );
  }
  explain(enabled: boolean = true): void {
    getInternals(this).explainMode = enabled;
  }
  *speculate<TResult>(
    execute: (
      context: Context,
    ) =>
      | Generator<ContextOperationRequest, TResult, unknown>
      | AsyncGenerator<unknown, TResult, unknown>,
  ): Generator<ContextOperationRequest, TResult, unknown> {
    return yield* speculateOperations.speculate<TResult>(this, getInternals(this), execute);
  }
  setAttribute<TValue extends SearchAttributeValue>(
    key: SearchAttributeHandle<TValue>,
    value: TValue,
  ): void;
  setAttribute(key: string, value: SearchAttributeValue): void;
  setAttribute(key: string | SearchAttributeHandle, value: SearchAttributeValue): void {
    contextAttributes.setAttribute(getInternals(this), searchAttributeName(key), value);
  }
  setAttributes(attributes: Record<string, SearchAttributeValue>): void {
    contextAttributes.setAttributes(getInternals(this), attributes);
  }
  getAttribute<T extends SearchAttributeValue>(key: SearchAttributeHandle<T>): T | undefined;
  getAttribute<T extends SearchAttributeValue = SearchAttributeValue>(key: string): T | undefined;
  getAttribute<T extends SearchAttributeValue = SearchAttributeValue>(
    key: string | SearchAttributeHandle<T>,
  ): T | undefined {
    return contextAttributes.getAttribute<T>(getInternals(this), searchAttributeName(key));
  }
  getAttributes(): Readonly<Record<string, SearchAttributeValue>> {
    return contextAttributes.getAttributes(getInternals(this));
  }
  onUpdate<TInput, TOutput>(
    definition: UpdateDefinition<TInput, TOutput>,
    handler: (payload: TInput) => TOutput | Promise<TOutput>,
    options?: contextUpdates.UpdateHandlerOptions,
  ): void;
  onUpdate(
    name: string,
    handler: (payload: unknown) => unknown,
    options?: contextUpdates.UpdateHandlerOptions,
  ): void;
  onUpdate(
    nameOrDefinition: MessageName,
    handler: (payload: unknown) => unknown,
    options?: contextUpdates.UpdateHandlerOptions,
  ): void {
    contextUpdates.onUpdate(getInternals(this), messageName(nameOrDefinition), handler, options);
  }
  onQuery<TInput, TOutput>(
    definition: QueryDefinition<TInput, TOutput>,
    handler: (input: TInput) => TOutput | Promise<TOutput>,
  ): void;
  onQuery<TOutput>(
    definition: QueryDefinition<void, TOutput>,
    handler: () => TOutput | Promise<TOutput>,
  ): void;
  onQuery(name: string, handler: (input: unknown) => unknown): void;
  onQuery(nameOrDefinition: MessageName, handler: (input: unknown) => unknown): void {
    contextUpdates.onQuery(getInternals(this), messageName(nameOrDefinition), handler);
  }
  expose(accessors: Record<string, () => unknown>): void {
    contextUpdates.expose(getInternals(this), accessors);
  }
  onCancel(handler: () => Promise<void> | void): void {
    const internals = getInternals(this);
    if (internals.registerCancelHandler === undefined) {
      throw new Error('ctx.onCancel() is only supported for inline workflow execution');
    }
    internals.registerCancelHandler(handler);
  }
  streamUrl(reference: StreamReference): string {
    return `/v1/workflows/${encodeURIComponent(reference.workflowId)}/streams/${encodeURIComponent(reference.key)}`;
  }
}
