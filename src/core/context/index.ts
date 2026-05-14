/* oxlint-disable max-lines -- ID:core-context-public-workflow-surface */
import type { HumanReviewOptions, HumanReviewResult } from '../review/index.ts';
import { cloneSessionStateStore, normalizeSessionStateLocals } from '../session-state.ts';
import type {
  ActivityArguments,
  ActivityCallable,
  ActivityCallOptions,
  ActivityResult,
  ActivityTypes,
  ChildWorkflowOptions,
  ChildWorkflowTarget,
  Duration,
  MessageName,
  QueryDefinition,
  RunAllResult,
  SearchAttributeHandle,
  SearchAttributeValue,
  SignalDefinition,
  UnregisteredName,
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
import * as sagaHelpers from './saga.ts';
import * as stateSessionHelpers from './session-state.ts';
import * as speculateOperations from './speculate-operations.ts';
import * as stateNamespaceHelpers from './state-namespace.ts';
import type {
  ContextOptions,
  ErasedSagaStep,
  OffloadReference,
  StreamReference,
  StreamSink,
} from './types.ts';
import * as contextUpdates from './updates.ts';
import * as contextValidation from './validation.ts';
export type { ContextOperationRequest } from './operation-request.ts';
export type {
  ContextOptions,
  OffloadReference,
  SagaStep,
  StoredStreamChunk,
  StreamReference,
  StreamSink,
} from './types.ts';

function acceptsNoActivityInput(fn: unknown): boolean {
  if (typeof fn !== 'function') return false;
  if (fn.length === 0) return true;
  const execute = (fn as { execute?: unknown }).execute;
  return typeof execute === 'function' && execute.length === 0;
}

/**
 * Concrete workflow execution context injected as the first argument of every
 * registered workflow generator. Implements durable operations such as `run`,
 * `sleep`, `waitForSignal`, `review`, `offload`, `stream`, and `saga`.
 *
 * @example
 * ```ts
 * import { Context } from 'weft';
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
  get tenant(): import('../tenant.ts').TenantContext | undefined {
    return getInternals(this).tenant;
  }
  get executionTimeRemaining(): number {
    const internals = getInternals(this);
    if (internals.deadline === undefined) return Infinity;
    return Math.max(0, internals.deadline - internals.getNow());
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
  // oxlint-disable-next-line complexity -- ID:core-context-create-speculative-child-complexity
  createSpeculativeChild(): Context {
    const internals = getInternals(this);
    const childOptions: ContextOptions = {
      workflowId: this.workflowId,
      workflowType: this.workflowType,
      startedAt: this.startedAt,
      abortController: internals.abortController,
      getNow: internals.getNow,
      initialStep: internals.stepIndex,
      ...(internals.accumulatedResults !== undefined
        ? { accumulatedResults: new Map(internals.accumulatedResults) }
        : {}),
      locals: internals.checkpointLocals,
      searchAttributes: internals.searchAttributes,
      nestingDepth: internals.nestingDepth,
      ...(internals.deadline !== undefined ? { deadline: internals.deadline } : {}),
      ...(internals.searchAttributeSchema !== undefined
        ? { searchAttributeSchema: internals.searchAttributeSchema }
        : {}),
      ...(internals.tenant !== undefined ? { tenant: internals.tenant } : {}),
      executionStateOwnerId: internals.executionStateOwnerId,
      ...(internals.sleepReferenceTime !== undefined
        ? { sleepReferenceTime: internals.sleepReferenceTime }
        : {}),
      ...(internals.resolveWorkflowType !== undefined
        ? { resolveWorkflowType: internals.resolveWorkflowType }
        : {}),
    };
    const child = new Context(childOptions);
    const childInternals = getInternals(child);
    childInternals.pendingAttributeChanges =
      internals.pendingAttributeChanges !== undefined
        ? { ...internals.pendingAttributeChanges }
        : undefined;
    childInternals.updateHandlers =
      internals.updateHandlers !== undefined ? new Map(internals.updateHandlers) : undefined;
    childInternals.queryHandlers =
      internals.queryHandlers !== undefined ? new Map(internals.queryHandlers) : undefined;
    childInternals.exposedValues =
      internals.exposedValues !== undefined ? new Map(internals.exposedValues) : undefined;
    childInternals.memoCache =
      internals.memoCache !== undefined ? new Map(internals.memoCache) : undefined;
    childInternals.explainMode = internals.explainMode;
    return child;
  }
  commitSpeculativeChild(child: Context): void {
    const internals = getInternals(this);
    const childInternals = getInternals(child);
    internals.stepIndex = childInternals.stepIndex;
    internals.accumulatedResults =
      childInternals.accumulatedResults !== undefined
        ? new Map(childInternals.accumulatedResults)
        : undefined;
    internals.stateSession = cloneSessionStateStore(childInternals.stateSession);
    internals.checkpointLocals = stateSessionHelpers.createCheckpointLocals(
      internals.stateSession,
      childInternals.checkpointLocals,
    );
    internals.searchAttributes = { ...childInternals.searchAttributes };
    internals.pendingAttributeChanges =
      childInternals.pendingAttributeChanges !== undefined
        ? { ...childInternals.pendingAttributeChanges }
        : undefined;
    internals.updateHandlers =
      childInternals.updateHandlers !== undefined
        ? new Map(childInternals.updateHandlers)
        : undefined;
    internals.queryHandlers =
      childInternals.queryHandlers !== undefined
        ? new Map(childInternals.queryHandlers)
        : undefined;
    internals.exposedValues =
      childInternals.exposedValues !== undefined
        ? new Map(childInternals.exposedValues)
        : undefined;
    internals.memoCache =
      childInternals.memoCache !== undefined ? new Map(childInternals.memoCache) : undefined;
    internals.sleepReferenceTime = childInternals.sleepReferenceTime;
  }
  get state(): WorkflowStateNamespace {
    return stateNamespaceHelpers.createStateNamespace(this, getInternals(this));
  }
  run<TName extends Extract<keyof ActivityTypes, string>>(
    name: TName,
    ...rest: ActivityArguments<ActivityTypes, TName>
  ): Generator<ContextOperationRequest, ActivityResult<ActivityTypes, TName>, unknown>;
  run<TName extends Extract<keyof ActivityTypes, string>>(
    name: TName,
    ...rest: [...ActivityArguments<ActivityTypes, TName>, ActivityCallOptions]
  ): Generator<ContextOperationRequest, ActivityResult<ActivityTypes, TName>, unknown>;
  run<TName extends string>(
    name: UnregisteredName<TName, Extract<keyof ActivityTypes, string>>,
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
  // oxlint-disable-next-line complexity -- ID:core-context-fn-complexity
  *run<TInput, TResult>(
    activity:
      | string
      | ActivityCallable<void, TResult>
      | ((() => Promise<TResult> | TResult) & { execute?: never })
      | ActivityCallable<TInput, TResult>
      | (((input: TInput) => Promise<TResult> | TResult) & { execute?: never }),
    ...rest: unknown[]
  ): Generator<ContextOperationRequest, TResult, unknown> {
    let options: ActivityCallOptions | undefined;
    if (
      rest.length > 0 &&
      stateSessionHelpers.isActivityCallOptions(rest[rest.length - 1]) &&
      (rest.length > 1 || (typeof activity !== 'string' && acceptsNoActivityInput(activity)))
    ) {
      options = rest.pop() as ActivityCallOptions;
    }
    if (rest.length > 1) {
      throw new Error(
        'ctx.run() accepts one activity input value plus optional ActivityCallOptions.',
      );
    }
    const input = rest[0];
    const activityName = typeof activity === 'string' ? activity : activity.name || 'anonymous';
    const activityFunction = typeof activity === 'function' ? activity : undefined;
    const internals = getInternals(this);
    const step = internals.stepIndex++;
    if (internals.accumulatedResults?.has(step)) {
      if (internals.explainMode) {
        console.log(`[weft] ctx.run(${activityName}) → Returning cached result from step ${step}`);
      }
      return internals.accumulatedResults.get(step) as TResult;
    }
    const queue = options?.queue ?? 'default';
    if (internals.explainMode) {
      console.log(`[weft] ctx.run(${activityName}, ${JSON.stringify(input)})`);
      console.log(`  → Creating checkpoint at step ${step}`);
      console.log(`  → Dispatching activity "${activityName}" to queue "${queue}"`);
    }
    const operationId = crypto.randomUUID();
    const callerStack = contextValidation.captureCallerStack();
    const executeActivity = activityFunction as
      | ((input: unknown, context?: unknown) => unknown)
      | undefined;
    const result = yield {
      type: 'activity',
      operationId,
      activityName,
      ...(executeActivity !== undefined ? { fn: executeActivity } : {}),
      input,
      callerStack,
      ...(options !== undefined ? { options: options as Record<string, unknown> } : {}),
    };
    this.accumulatedResults.set(step, result);
    return result as TResult;
  }
  *sleep(duration: Duration): Generator<ContextOperationRequest, void, unknown> {
    return yield* durableOperations.sleep(this, getInternals(this), duration);
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
    return yield* durableOperations.waitForSignal<T>(
      this,
      getInternals(this),
      messageName(nameOrDefinition),
    );
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
  ): void;
  onUpdate(name: string, handler: (payload: unknown) => unknown): void;
  onUpdate(nameOrDefinition: MessageName, handler: (payload: unknown) => unknown): void {
    contextUpdates.onUpdate(getInternals(this), messageName(nameOrDefinition), handler);
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
  streamUrl(reference: StreamReference): string {
    return `/v1/workflows/${encodeURIComponent(reference.workflowId)}/streams/${encodeURIComponent(reference.key)}`;
  }
}
