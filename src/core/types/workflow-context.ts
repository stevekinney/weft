import type {
  ErasedSagaStep,
  OffloadReference,
  StreamReference,
  StreamSink,
} from '../context/types.ts';
import type { UpdateHandlerOptions } from '../context/updates.ts';
import type { HumanReviewOptions, HumanReviewResult } from '../review/index.ts';
import type { ActivityCallable, ActivityCallOptions } from './activity.ts';
import type { WorkflowId } from './identity.ts';
import type { QueryDefinition, SignalDefinition, UpdateDefinition } from './message-handles.ts';
import type { UnknownNameWhenRegistryHasNoKnownNames } from './registry-type-helpers.ts';
import type { Duration } from './retry-retention.ts';
import type {
  SearchAttributeHandle,
  SearchAttributeSchema,
  SearchAttributeValue,
  SearchAttributeValueForDefinition,
} from './search-attributes.ts';
import type { WorkflowStateNamespace } from './state.ts';
import type {
  ActivityArgsFor,
  ActivityMap,
  ActivityResultFor,
  QueryMap,
  QueryShape,
  SignalMap,
  SignalPayload,
  UpdateMap,
  UpdatePayload,
} from './workflow-builder-helpers.ts';
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
 * import { workflow, Engine, activity, type WorkflowContext } from '@lostgradient/weft';
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
 * engine.register(
 *   workflow({ name: 'myWorkflow' }).execute(async function* (ctx: WorkflowContext, input: GreetingInput) {
 *     ctx.setAttribute('customer', input.name);
 *     return yield* ctx.run(greet, input);
 *   }),
 * );
 * void engine;
 * ```
 */
export interface WorkflowContext<
  TActivities extends ActivityMap = {},
  TSignals extends SignalMap = {},
  TUpdates extends UpdateMap = {},
  TQueries extends QueryMap = {},
  TSearchAttributes extends SearchAttributeSchema = {},
> {
  readonly workflowId: WorkflowId;
  /**
   * The registered workflow type name for this run (the `name` field from
   * `workflow({ name: '...' })`). Useful for logging and self-inspection
   * without capturing the name at the workflow definition site.
   */
  readonly workflowType: string;
  readonly signal: AbortSignal;
  readonly executionTimeRemaining: number;
  readonly startedAt: number;
  readonly state: WorkflowStateNamespace;
  /**
   * Host-supplied, per-run capabilities passed at launch via
   * `engine.start(type, input, { services })` (or `ctx.run`-free closures, live
   * clients, tool registries). The value is **never checkpointed**: it is held
   * only in engine memory for this run, and on a fresh-process recovery it is
   * re-provided by the engine's `resolveWorkflowServices` resolver before the
   * generator advances. `undefined` when no services were supplied (and not yet
   * re-provided on recovery). Inline execution mode only — passing `services`
   * under `workflowExecutionMode: 'worker'` throws at `engine.start()`, since a
   * non-serializable value cannot cross to a Worker.
   *
   * Typed `unknown`: narrow or cast at the call site
   * (`const { db } = ctx.services as MyServices`). A threaded generic is a
   * deliberate follow-on, not part of this surface yet. Optional so existing
   * structural `WorkflowContext` implementors are not source-broken.
   *
   * Separate child *workflows* started from within a workflow (`ctx.startChild()`)
   * do **not** inherit the parent's `services` — each run is its own workflow with
   * its own services, configured the same way (and re-provided on recovery by the
   * engine's `resolveWorkflowServices`). This is distinct from a *speculative
   * child context*, which is the same run advanced in-memory for speculative
   * replay (same `workflowId`) and therefore does carry the run's `services`
   * across.
   */
  readonly services?: unknown;
  // ---------------------------------------------------------------------
  // Workflow-scoped typed-key overloads. These fire first when the workflow
  // was built with the chained builder (`.activities({...})`, `.signals({...})`
  // etc.) and the corresponding map has known keys. When the maps default to
  // `{}` (bare-`WorkflowContext` callers without an activity map), `keyof
  // TActivities & string` collapses to `never`, the overload silently
  // de-prioritises, and TypeScript falls through to the empty-registry
  // helper overload below.
  // ---------------------------------------------------------------------
  run<TName extends keyof TActivities & string>(
    name: TName,
    ...rest: ActivityArgsFor<TActivities[TName]>
  ): WorkflowOperation<ActivityResultFor<TActivities[TName]>>;
  run<TName extends keyof TActivities & string>(
    name: TName,
    ...rest: [...ActivityArgsFor<TActivities[TName]>, ActivityCallOptions]
  ): WorkflowOperation<ActivityResultFor<TActivities[TName]>>;
  // String-name fallback for workflows that declare no `.activities()` map.
  // When `TActivities` is the default `{}`, the typed overloads collapse to
  // `never` and TypeScript falls through here. Returns `unknown` because the
  // input/output types are unknown at the type level — runtime registration
  // is the source of truth.
  run<TName extends string>(
    name: UnknownNameWhenRegistryHasNoKnownNames<TName, keyof TActivities & string>,
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
  // Workflow-scoped typed-key overload for declared signals.
  waitForSignal<TName extends keyof TSignals & string>(
    name: TName,
  ): WorkflowOperation<SignalPayload<TSignals[TName]>>;
  waitForSignal<TInput>(definition: SignalDefinition<TInput>): WorkflowOperation<TInput>;
  waitForSignal<T = unknown>(name: string): WorkflowOperation<T>;
  // Workflow-scoped typed-key overload for declared updates.
  waitForUpdate<TName extends keyof TUpdates & string>(
    name: TName,
  ): WorkflowOperation<UpdatePayload<TUpdates[TName]>>;
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
  /**
   * Run a compensating transaction. In inline execution, if cancellation
   * interrupts an active saga, completed steps compensate in reverse order on a
   * best-effort, in-memory path. Cancellation compensation runs outside the
   * durable activity pipeline and is not replayed after engine restart.
   */
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
  // Workflow-scoped typed-key setAttribute overload — uses the declared schema's
  // value type for each known attribute name.
  setAttribute<TName extends keyof TSearchAttributes & string>(
    key: TName,
    value: SearchAttributeValueForDefinition<TSearchAttributes[TName]>,
  ): void;
  setAttribute<TValue extends SearchAttributeValue>(
    key: SearchAttributeHandle<TValue>,
    value: TValue,
  ): void;
  setAttribute(key: string, value: SearchAttributeValue): void;
  setAttributes(attributes: Record<string, SearchAttributeValue>): void;
  // Workflow-scoped typed-key getAttribute overload.
  getAttribute<TName extends keyof TSearchAttributes & string>(
    key: TName,
  ): SearchAttributeValueForDefinition<TSearchAttributes[TName]> | undefined;
  getAttribute<T extends SearchAttributeValue>(key: SearchAttributeHandle<T>): T | undefined;
  getAttribute<T extends SearchAttributeValue = SearchAttributeValue>(key: string): T | undefined;
  getAttributes(): Readonly<Record<string, SearchAttributeValue>>;
  // Workflow-scoped typed-key onUpdate overload.
  onUpdate<TName extends keyof TUpdates & string>(
    name: TName,
    handler: (
      payload: UpdatePayload<TUpdates[TName]>['payload'],
    ) =>
      | Parameters<UpdatePayload<TUpdates[TName]>['respond']>[0]
      | Promise<Parameters<UpdatePayload<TUpdates[TName]>['respond']>[0]>,
    options?: UpdateHandlerOptions,
  ): void;
  onUpdate<TInput, TOutput>(
    definition: UpdateDefinition<TInput, TOutput>,
    handler: (payload: TInput) => TOutput | Promise<TOutput>,
    options?: UpdateHandlerOptions,
  ): void;
  onUpdate(
    name: string,
    handler: (payload: unknown) => unknown,
    options?: UpdateHandlerOptions,
  ): void;
  // Workflow-scoped typed-key onQuery overload.
  onQuery<TName extends keyof TQueries & string>(
    name: TName,
    handler: (
      input: QueryShape<TQueries[TName]>['input'],
    ) => QueryShape<TQueries[TName]>['output'] | Promise<QueryShape<TQueries[TName]>['output']>,
  ): void;
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
  /**
   * Register a best-effort teardown handler that runs when this workflow is
   * cancelled, before the workflow is finalized.
   * Handlers run in registration order; async handlers are awaited; failures
   * are swallowed — the workflow still finalizes as cancelled.
   *
   * **Best-effort only**: handlers run outside the durable effect log and are
   * not retried. Side effects in handlers are not replay-safe, and registered
   * handlers are not restored after an engine restart.
   *
   * **Worker-pool mode**: this method throws when the engine uses a remote
   * worker pool so teardown does not silently drop.
   *
   * @example
   * ```ts
   * import { workflow, type WorkflowContext } from '@lostgradient/weft';
   *
   * const myWorkflow = workflow({ name: 'my-workflow' }).execute(async function* (ctx: WorkflowContext) {
   *   ctx.onCancel(async () => {
   *     await releaseLocks();
   *   });
   *   yield* ctx.run(longRunningActivity);
   * });
   * void myWorkflow;
   * ```
   */
  onCancel(handler: () => Promise<void> | void): void;
}
