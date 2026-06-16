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
  AwaitChildWorkflowOptions,
  ChildWorkflowHandle,
  ChildWorkflowOptions,
  ChildWorkflowTarget,
  DetachedChildWorkflowOptions,
  WorkflowMapOptions,
  WorkflowOperation,
  WorkflowPipeStage,
  WorkflowPipeStageDefinition,
  WorkflowReduceInput,
  WorkflowReduceOptions,
} from './workflow-function.ts';
import type { WorkflowLogger } from './workflow-log.ts';

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
  TServices = unknown,
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
   * generator advances. `undefined` only when no services were supplied; a
   * services-marked run fails before resume if the fresh engine cannot
   * re-provide them. Inline execution mode only — passing `services` under
   * `workflowExecutionMode: 'worker'` throws at `engine.start()`, since a
   * non-serializable value cannot cross to a Worker.
   *
   * Typed by the workflow definition when the builder declares
   * `.services<MyServices>()`, and `unknown` otherwise. Optional so existing
   * structural `WorkflowContext` implementors are not source-broken and so
   * workflows still handle no-services launches explicitly.
   *
   * Separate child *workflows* started from within a workflow (`ctx.startChild()`)
   * do **not** inherit the parent's `services` — each run is its own workflow with
   * its own services, configured the same way (and re-provided on recovery by the
   * engine's `resolveWorkflowServices`). This is distinct from a *speculative
   * child context*, which is the same run advanced in-memory for speculative
   * replay (same `workflowId`) and therefore does carry the run's `services`
   * across.
   */
  readonly services?: TServices;
  /**
   * Structured logger scoped to this run, auto-carrying `workflowId` and
   * `workflowType`. Replay-safe in both inline and worker execution modes: log
   * calls in the already-committed replay window are suppressed so a recovered
   * run does not re-emit logs. See {@link WorkflowLogger} for the full contract
   * (method set, the after-last-step caveat, and parallel-branch semantics).
   *
   * Optional on the interface so existing structural `WorkflowContext`
   * implementors (test stubs and the like) are not source-broken — the same
   * precedent as {@link WorkflowContext.services}. The engine always populates it
   * at runtime, so within a real workflow body `ctx.log` is always present; the
   * `?` only affects callers typed against the bare interface (use `ctx.log?.`).
   */
  readonly log?: WorkflowLogger;
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
  /**
   * Wait until `predicate` returns `true`, re-evaluated by the engine each time
   * the workflow is driven forward — when an `onUpdate` handler mutates
   * workflow-local state, or when the optional `timeout` elapses. This is the
   * condition-variable primitive (Temporal's `condition()`): a `waitUntil` whose
   * predicate reads state mutated by `onUpdate` handlers re-checks in-process
   * without polling. (Weft signals are pull-only via `ctx.waitForSignal`; they
   * run no state-mutating handler, so signal delivery does not re-drive a
   * `waitUntil` — use `onUpdate` to push state a predicate observes.)
   *
   * The predicate must be PURE — it may read only checkpoint-restored
   * workflow-local state (`ctx.state`, locals, search attributes) and must not
   * perform I/O, generate randomness, or read wall-clock time. It is a
   * non-serializable closure (like `ctx.memo`'s function), held in-process and
   * never checkpointed. Once the wait outcome has been checkpointed, replay
   * returns the cached outcome and does not re-invoke the predicate. A predicate
   * that throws fails the workflow at the `yield* ctx.waitUntil` call site (like
   * a throwing activity), so the workflow body can `try`/`catch` it.
   *
   * Inline execution only — worker execution does not expose this operation (it
   * is omitted from the worker context type), because the predicate closure
   * cannot cross to a worker process. It also cannot be a branch of `ctx.race`,
   * `ctx.all`, or `ctx.speculate`; used there it throws an actionable error.
   *
   * Without `timeout` it resolves `void` once the predicate is met (waits
   * forever). With `timeout` it resolves `true` when the predicate was met or
   * `false` when the deadline elapsed first; if both happen on the same tick the
   * predicate wins (resolves `true`). `timeout` is milliseconds (`number`) or a
   * duration string (`'30s'`, `'5m'` — see {@link Duration}).
   */
  waitUntil(predicate: () => boolean): WorkflowOperation<void>;
  waitUntil(predicate: () => boolean, timeout: Duration): WorkflowOperation<boolean>;
  /**
   * Pin a named workflow patch to a deterministic numeric version. The first
   * execution stores `maxSupported` under `version:${changeId}` in checkpoint
   * locals; replay and recovery return that stored value so in-flight workflows
   * can keep taking their original branch while new runs pin the newer version.
   * Raise `minSupported` only after every in-flight run pinned below that version
   * has completed.
   */
  getVersion(
    changeId: string,
    minSupported: number,
    maxSupported: number,
  ): WorkflowOperation<number>;
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
    options: DetachedChildWorkflowOptions,
  ): WorkflowOperation<ChildWorkflowHandle<TResult>>;
  startChild<TResult = unknown>(
    workflowType: string,
    input: unknown,
    options?: AwaitChildWorkflowOptions,
  ): WorkflowOperation<TResult>;
  startChild<TResult = unknown>(
    workflowType: string,
    input: unknown,
    options?: ChildWorkflowOptions,
  ): WorkflowOperation<TResult | ChildWorkflowHandle<TResult>>;
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
   * handlers are not restored after an engine restart. A hard cancel or an
   * engine crash that evicts the workflow before the handler runs loses it.
   *
   * **Prefer a durable `finalizer` for resource teardown.** To tear down a paid
   * external resource (a sandbox, a leased VM) so it is destroyed even across a
   * hard cancel or a crash, record the resource with
   * {@link WorkflowContext.setFinalizerState} and declare a definition-level
   * `finalizer` activity — the engine drives it durably post-terminal. `onCancel`
   * remains the right tool for in-process, best-effort cleanup (releasing an
   * in-memory lock, flushing a buffer) where durability is not required.
   * Registering a `finalizer` works in both inline and worker mode; only the
   * in-generator `ctx.setFinalizerState` call requires inline execution (see
   * `setFinalizerState`).
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
  /**
   * Durably record the payload the engine passes to this workflow's
   * definition-level `finalizer` activity when it drives teardown after a
   * `cancelled` or `timed-out` terminal (issue #446).
   *
   * Call this immediately after acquiring a paid external resource, passing
   * whatever the finalizer needs to destroy it (e.g. a sandbox id). The value is
   * durably staged — as a pending atomic side-effect committed with the next
   * checkpoint or the terminal transition, fenced under lease ownership — so the
   * finalizer can run even across a hard cancel or an engine crash. Recording is
   * the engine's signal that there is something to tear down: if the workflow
   * never calls this, the engine skips the finalizer entirely. Recording `null`
   * is different — it still counts as recorded, so the finalizer runs with a
   * `null` payload. The value is last-write-wins, so a later call replaces the
   * earlier one — record the id of the resource that is currently live.
   *
   * **The finalizer runs at least once and must be idempotent.** The engine
   * drives it with bounded retries and re-drives a stale claim after a crash, so
   * the same payload can reach the finalizer more than once (the same contract as
   * keying a destroy by `sandboxId`). Make the teardown safe to repeat —
   * destroying an already-destroyed resource must succeed (or no-op), not throw.
   *
   * Calling this after the workflow is already terminalizing is a no-op (a
   * development warning is logged); finalizer state is recordable only while the
   * workflow is live.
   *
   * **Worker-generator caveat**: this method type-checks in any workflow
   * generator — the generator's `ctx` is typed as {@link WorkflowContext}, which
   * declares `setFinalizerState` — but the limitation is at runtime. Only inline
   * execution wires up the engine callback this method delegates to; in worker
   * execution mode and inside `ctx.speculate()` branches that callback is absent,
   * so the call throws a guard error rather than recording state. A workflow that
   * must record finalizer state has to run in inline execution mode. Durable
   * finalizer *registration* works in worker mode since #564; only the in-generator
   * `setFinalizerState` call requires inline execution. For in-process, best-effort
   * cleanup that does not need to survive a crash, use {@link WorkflowContext.onCancel}.
   *
   * @example
   * ```ts
   * import { workflow, type WorkflowContext } from '@lostgradient/weft';
   *
   * const provision = workflow({ name: 'provision' })
   *   .execute(async function* (ctx: WorkflowContext) {
   *     const sandbox = yield* ctx.run(createSandbox);
   *     ctx.setFinalizerState({ sandboxId: sandbox.id });
   *     yield* ctx.run(doWork, sandbox.id);
   *   });
   * void provision;
   * ```
   */
  setFinalizerState(value: unknown): void;
}
