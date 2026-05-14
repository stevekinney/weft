import type {
  ErasedSagaStep,
  OffloadReference,
  StreamReference,
  StreamSink,
} from '../context/types.ts';
import type { HumanReviewOptions, HumanReviewResult } from '../review/index.ts';
import type { TenantContext } from '../tenant.ts';
import type { ActivityCallable, ActivityCallOptions } from './activity.ts';
import type { WorkflowId } from './identity.ts';
import type { QueryDefinition, SignalDefinition, UpdateDefinition } from './message-handles.ts';
import type { Duration } from './retry-retention.ts';
import type { SearchAttributeHandle, SearchAttributeValue } from './search-attributes.ts';
import type { WorkflowStateNamespace } from './state.ts';
import type {
  ChildWorkflowOptions,
  ChildWorkflowTarget,
  WorkflowMapOptions,
  WorkflowOperation,
  WorkflowPipeStage,
  WorkflowPipeStageDefinition,
  WorkflowReduceInput,
  WorkflowReduceOptions,
} from './workflow-function.ts';
import type {
  ActivityArguments,
  ActivityResult,
  ActivityTypes,
  UnregisteredName,
} from './workflow-registries.ts';

export type WorkflowOperationResult<TOperation> =
  TOperation extends Generator<unknown, infer TResult, unknown> ? TResult : never;

export type WorkflowOperationTupleResult<
  TOperations extends readonly WorkflowOperation<unknown>[],
> = {
  -readonly [TIndex in keyof TOperations]: WorkflowOperationResult<TOperations[TIndex]>;
};

type RunAllBranchResult<TBranch> = TBranch extends readonly [
  execute: infer TExecute,
  ...rest: unknown[],
]
  ? TExecute extends (...arguments_: never[]) => infer TResult
    ? Awaited<TResult>
    : unknown
  : never;

export type WorkflowRunAllBranch =
  | readonly [execute: (...arguments_: never[]) => unknown]
  | readonly [execute: (...arguments_: never[]) => unknown, input: unknown]
  | readonly [execute: Function]
  | readonly [execute: Function, input: unknown];

export type RunAllResult<TBranches extends Record<string, WorkflowRunAllBranch>> = {
  [TKey in keyof TBranches]: [RunAllBranchResult<TBranches[TKey]>] extends [never]
    ? unknown
    : RunAllBranchResult<TBranches[TKey]>;
};

/**
 * The durable workflow authoring surface passed to every
 * {@link WorkflowFunction}. Workflow handlers can call `ctx.run`,
 * `ctx.sleep`, `ctx.waitForSignal`, `ctx.startChild`, composition helpers,
 * search-attribute helpers, update registration, and review helpers directly.
 *
 * @example
 * ```ts
 * import { Engine, activity, type WorkflowContext } from 'weft';
 *
 * interface GreetingInput {
 *   name: string;
 * }
 *
 * const engine = new Engine();
 * const greet = activity({
 *   name: 'greet',
 *   execute: async (input: GreetingInput) => `Hello, ${input.name}`,
 * });
 *
 * engine.register('myWorkflow', async function* (ctx: WorkflowContext, input: GreetingInput) {
 *   ctx.setAttribute('customer', input.name);
 *   return yield* ctx.run(greet, input);
 * });
 * void engine;
 * ```
 */
export interface WorkflowContext {
  readonly workflowId: WorkflowId;
  readonly signal: AbortSignal;
  readonly executionTimeRemaining: number;
  readonly startedAt: number;
  /**
   * The {@link TenantContext} this workflow is running
   * on behalf of, populated from the engine's `tenantResolver` at start time
   * and restored from persisted state on recovery. `undefined` when the
   * engine has no resolver configured or the resolver returned `undefined`.
   *
   * Declared as `T | undefined` rather than `tenant?: T` so the field is
   * always present on the type — the `Context` class implementation has a
   * getter that returns `undefined` when absent, and under
   * `exactOptionalPropertyTypes` the optional-key form would be a stricter
   * contract that the getter can't satisfy.
   */
  readonly tenant: TenantContext | undefined;
  readonly state: WorkflowStateNamespace;
  run<TName extends Extract<keyof ActivityTypes, string>>(
    name: TName,
    ...rest: ActivityArguments<ActivityTypes, TName>
  ): WorkflowOperation<ActivityResult<ActivityTypes, TName>>;
  run<TName extends Extract<keyof ActivityTypes, string>>(
    name: TName,
    ...rest: [...ActivityArguments<ActivityTypes, TName>, ActivityCallOptions]
  ): WorkflowOperation<ActivityResult<ActivityTypes, TName>>;
  run<TName extends string>(
    name: UnregisteredName<TName, Extract<keyof ActivityTypes, string>>,
    input?: unknown,
    options?: ActivityCallOptions,
  ): WorkflowOperation<unknown>;
  run<TResult>(
    fn: ActivityCallable<void, TResult>,
    options?: ActivityCallOptions,
  ): WorkflowOperation<TResult>;
  run<TResult>(
    fn: (() => Promise<TResult> | TResult) & { execute?: never },
    options?: ActivityCallOptions,
  ): WorkflowOperation<TResult>;
  run<TInput, TResult>(
    fn: ActivityCallable<TInput, TResult>,
    input: TInput,
    options?: ActivityCallOptions,
  ): WorkflowOperation<TResult>;
  run<TInput, TResult>(
    fn: ((input: TInput) => Promise<TResult> | TResult) & { execute?: never },
    input: TInput,
    options?: ActivityCallOptions,
  ): WorkflowOperation<TResult>;
  sleep(duration: Duration): WorkflowOperation<void>;
  suspendUntil<T = unknown>(resumeToken: string): WorkflowOperation<T>;
  waitForSignal<TInput>(definition: SignalDefinition<TInput>): WorkflowOperation<TInput>;
  waitForSignal<T = unknown>(name: string): WorkflowOperation<T>;
  waitForUpdate<TInput, TOutput>(
    definition: UpdateDefinition<TInput, TOutput>,
  ): WorkflowOperation<{ payload: TInput; respond: (result: TOutput) => void }>;
  waitForUpdate<T = unknown>(
    name: string,
  ): WorkflowOperation<{ payload: T; respond: (result: unknown) => void }>;
  review(options: HumanReviewOptions): WorkflowOperation<HumanReviewResult>;
  all<const TOperations extends readonly WorkflowOperation<unknown>[]>(
    operations: TOperations,
  ): WorkflowOperation<WorkflowOperationTupleResult<TOperations>>;
  race<const TOperations extends readonly WorkflowOperation<unknown>[]>(
    operations: TOperations,
  ): WorkflowOperation<WorkflowOperationTupleResult<TOperations>[number]>;
  memo<T>(key: string, fn: () => T | Promise<T>): WorkflowOperation<T>;
  offload<T>(key: string, fn: () => Promise<T>): WorkflowOperation<OffloadReference>;
  stream(
    key: string,
    fn: (sink: StreamSink) => AsyncGenerator<unknown, void, unknown>,
  ): WorkflowOperation<StreamReference>;
  load<T>(reference: OffloadReference): WorkflowOperation<T>;
  archive(key: string, data: unknown): WorkflowOperation<void>;
  runAll<const TBranches extends Record<string, WorkflowRunAllBranch>>(
    branches: TBranches,
  ): WorkflowOperation<RunAllResult<TBranches>>;
  saga<TFinalOutput = unknown>(steps: ErasedSagaStep[]): WorkflowOperation<TFinalOutput>;
  startChild<TResult = unknown>(
    workflowType: string,
    input: unknown,
    options?: ChildWorkflowOptions,
  ): WorkflowOperation<TResult>;
  pipe<TInput, TOutput>(
    stages: [WorkflowPipeStageDefinition<TInput, TOutput>],
    input: TInput,
  ): WorkflowOperation<TOutput>;
  pipe<TInput, TIntermediate, TOutput>(
    stages: [
      WorkflowPipeStageDefinition<TInput, TIntermediate>,
      WorkflowPipeStageDefinition<TIntermediate, TOutput>,
    ],
    input: TInput,
  ): WorkflowOperation<TOutput>;
  pipe<TInput, TFirst, TSecond, TOutput>(
    stages: [
      WorkflowPipeStageDefinition<TInput, TFirst>,
      WorkflowPipeStageDefinition<TFirst, TSecond>,
      WorkflowPipeStageDefinition<TSecond, TOutput>,
    ],
    input: TInput,
  ): WorkflowOperation<TOutput>;
  pipe<TInput, TFirst, TSecond, TThird, TOutput>(
    stages: [
      WorkflowPipeStageDefinition<TInput, TFirst>,
      WorkflowPipeStageDefinition<TFirst, TSecond>,
      WorkflowPipeStageDefinition<TSecond, TThird>,
      WorkflowPipeStageDefinition<TThird, TOutput>,
    ],
    input: TInput,
  ): WorkflowOperation<TOutput>;
  pipe<TResult = unknown>(
    stages: Array<WorkflowPipeStage | ChildWorkflowTarget>,
    input: unknown,
  ): WorkflowOperation<TResult>;
  map<TItem, TResult>(
    items: readonly TItem[],
    workflowType: ChildWorkflowTarget<TItem, TResult>,
    options?: WorkflowMapOptions,
  ): WorkflowOperation<TResult[]>;
  reduce<TItem, TAccumulator>(
    items: readonly TItem[],
    workflowType: ChildWorkflowTarget<WorkflowReduceInput<TAccumulator, TItem>, TAccumulator>,
    initialValue: TAccumulator,
    options?: WorkflowReduceOptions,
  ): WorkflowOperation<TAccumulator>;
  explain(enabled?: boolean): void;
  speculate<TResult>(
    execute: (
      context: WorkflowContext,
    ) => WorkflowOperation<TResult> | AsyncGenerator<unknown, TResult, unknown>,
  ): WorkflowOperation<TResult>;
  setAttribute<TValue extends SearchAttributeValue>(
    key: SearchAttributeHandle<TValue>,
    value: TValue,
  ): void;
  setAttribute(key: string, value: SearchAttributeValue): void;
  setAttributes(attributes: Record<string, SearchAttributeValue>): void;
  getAttribute<T extends SearchAttributeValue>(key: SearchAttributeHandle<T>): T | undefined;
  getAttribute<T extends SearchAttributeValue = SearchAttributeValue>(key: string): T | undefined;
  getAttributes(): Readonly<Record<string, SearchAttributeValue>>;
  onUpdate<TInput, TOutput>(
    definition: UpdateDefinition<TInput, TOutput>,
    handler: (payload: TInput) => TOutput | Promise<TOutput>,
  ): void;
  onUpdate(name: string, handler: (payload: unknown) => unknown): void;
  onQuery<TInput, TOutput>(
    definition: QueryDefinition<TInput, TOutput>,
    handler: (input: TInput) => TOutput | Promise<TOutput>,
  ): void;
  onQuery<TOutput>(
    definition: QueryDefinition<void, TOutput>,
    handler: () => TOutput | Promise<TOutput>,
  ): void;
  onQuery(name: string, handler: (input: unknown) => unknown): void;
  expose(accessors: Record<string, () => unknown>): void;
  streamUrl(reference: StreamReference): string;
}
