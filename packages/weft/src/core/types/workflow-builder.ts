/**
 * Type-only foundation for the chained workflow builder API
 * (`workflow({ name }).activities({...}).signals({...}).execute(generator)`).
 *
 * The builder co-locates a workflow with its activity table, signal/update/query
 * maps, and search-attribute schema so that `ctx.run('activityName', input)`,
 * `ctx.waitForSignal('signalName')`, and `engine.start('workflowName', input)`
 * are all type-safe end-to-end without relying on global module augmentation.
 *
 * Helpers (`NormalizeActivities`, `ActivityArgsFor`, `SignalMap`, etc.) live
 * in `./workflow-builder-helpers.ts` so each file stays under the 500-line
 * lint guideline. The runtime constructor for `workflow()` lives in
 * `./workflow-function.ts`; the `WorkflowContext` generic in `./workflow-context.ts`
 * uses the helpers here to type `run`, `waitForSignal`, etc.
 */

import type { ActivityCallOptions, ActivityDefinition, ActivityFunction } from './activity.ts';
import type { QueryDefinition, SignalDefinition, UpdateDefinition } from './message-handles.ts';
import type { SearchAttributeSchema } from './search-attributes.ts';
import type {
  ActivityMap,
  ActivityMapInput,
  NormalizeActivities,
  QueryMap,
  SignalMap,
  UpdateMap,
} from './workflow-builder-helpers.ts';
import type { WorkflowContext } from './workflow-context.ts';
import type { WorkflowDefinition, WorkflowOperation } from './workflow-function.ts';

// ---------------------------------------------------------------------------
// Workflow generator function consumed by `.execute(...)`
// ---------------------------------------------------------------------------

/**
 * The generator function accepted by `.execute(fn)`. It receives a
 * `WorkflowContext` parameterised by the workflow's normalised activity,
 * signal, update, query, and search-attribute maps, plus the workflow's input,
 * and yields workflow operations until it returns the workflow's output.
 *
 * Both `TInput` and `TOutput` are re-inferred from the generator's signature
 * inside `.execute(fn)`; the workflow's final `WorkflowDefinition` carries the
 * generator-derived types, not whatever placeholders the initial
 * `workflow({ name })` call provided.
 *
 * @example
 * ```ts
 * import { workflow, type WorkflowGenerator } from '@lostgradient/weft';
 * const fn: WorkflowGenerator<{ id: string }, string, {}, {}, {}, {}, {}> =
 *   async function* (_ctx, input) { return input.id; };
 * const job = workflow({ name: 'job' }).execute(fn);
 * void job;
 * ```
 */
export type WorkflowGenerator<
  TInput,
  TOutput,
  TActivities extends ActivityMap,
  TSignals extends SignalMap,
  TUpdates extends UpdateMap,
  TQueries extends QueryMap,
  TSearchAttributes extends SearchAttributeSchema,
  TServices = unknown,
> = (
  context: WorkflowContextOf<
    TActivities,
    TSignals,
    TUpdates,
    TQueries,
    TSearchAttributes,
    TServices
  >,
  input: TInput,
) => AsyncGenerator<unknown, TOutput, unknown>;

/**
 * Convenience alias for the workflow-scoped `WorkflowContext` projection. The
 * underlying `WorkflowContext` interface accepts the same five generic
 * parameters (`TActivities`, `TSignals`, `TUpdates`, `TQueries`,
 * `TSearchAttributes`), and the builder threads its normalised maps through
 * this alias so `.execute(fn)` sees the right `ctx` shape inside `fn`.
 *
 * Bare-`WorkflowContext` callers (no declared activity/signal/etc. maps)
 * typecheck because the interface's generics all default to permissive shapes:
 * the typed overloads de-prioritise to `never` and the dynamic string-name /
 * callable overloads match instead. This permissive path is the current API for
 * untyped, ad-hoc-name authoring.
 */
export type WorkflowContextOf<
  TActivities extends ActivityMap = ActivityMap,
  TSignals extends SignalMap = SignalMap,
  TUpdates extends UpdateMap = UpdateMap,
  TQueries extends QueryMap = QueryMap,
  TSearchAttributes extends SearchAttributeSchema = SearchAttributeSchema,
  TServices = unknown,
> = WorkflowContext<TActivities, TSignals, TUpdates, TQueries, TSearchAttributes, TServices>;

// ---------------------------------------------------------------------------
// Builder state — phantom flag set tracking which chain methods have run
// ---------------------------------------------------------------------------

/**
 * Tracks which `WorkflowBuilder` chain methods have already been called. Each
 * call flips its flag from `false` to `true`; the method's type becomes `never`
 * when its flag is already true, so duplicate calls fail to typecheck. The
 * runtime mirrors this with a state flag set that throws `WorkflowBuilderError`
 * on duplicate invocation.
 *
 * @example
 * ```ts
 * import type { BuilderState } from '@lostgradient/weft';
 *
 * // A fresh builder starts with every flag `false`.
 * const initial: BuilderState = {
 *   activities: false,
 *   signals: false,
 *   updates: false,
 *   queries: false,
 *   searchAttributes: false,
 * };
 * void initial;
 * ```
 */
export interface BuilderState {
  readonly activities: boolean;
  readonly signals: boolean;
  readonly updates: boolean;
  readonly queries: boolean;
  readonly searchAttributes: boolean;
  readonly services?: boolean | undefined;
}

/**
 * Initial builder state — every chain method is still available. A fresh
 * `workflow({ name })` call returns a `WorkflowBuilder<..., InitialBuilderState>`.
 *
 * @example
 * ```ts
 * import { workflow, type InitialBuilderState, type WorkflowBuilder } from '@lostgradient/weft';
 *
 * const fresh: WorkflowBuilder<'demo', {}, {}, {}, {}, {}, InitialBuilderState> =
 *   workflow({ name: 'demo' });
 * void fresh;
 * ```
 */
export interface InitialBuilderState {
  readonly activities: false;
  readonly signals: false;
  readonly updates: false;
  readonly queries: false;
  readonly searchAttributes: false;
  readonly services?: false | undefined;
}

/**
 * Flip one builder-state flag from `false` to `true`. Each chain method on
 * `WorkflowBuilder` uses this to mark its slot as used; the next call to the
 * same method sees `true` and resolves to `never`.
 *
 * @example
 * ```ts
 * import type { InitialBuilderState, MarkBuilderState } from '@lostgradient/weft';
 *
 * type AfterActivities = MarkBuilderState<InitialBuilderState, 'activities'>;
 * // AfterActivities['activities'] is true; the rest stay false.
 * const _check: AfterActivities['activities'] = true;
 * void _check;
 * ```
 */
export type MarkBuilderState<
  S extends BuilderState,
  K extends keyof BuilderState,
> = K extends 'services'
  ? Omit<S, 'services'> & { readonly services: true }
  : {
      readonly [P in keyof S]: P extends K ? true : S[P];
    };

// ---------------------------------------------------------------------------
// Engine name-conflict guard (used by Engine.register's type signature)
// ---------------------------------------------------------------------------

declare const workflowAlreadyRegisteredBrand: unique symbol;

/**
 * Branded diagnostic type intersected with the parameter of
 * `engine.register(workflow)` when the workflow's `name` is already present in
 * the engine's typed workflow registry. No real `WorkflowDefinition` satisfies
 * the brand, so the call fails to compile on the bare expression form — not
 * just when the return value is used.
 *
 * Runtime is more lenient: registering the same `WorkflowDefinition` object
 * reference is idempotent; same-name-different-object throws. TypeScript
 * cannot distinguish the two at the type level. Callers needing the runtime
 * idempotent path from TypeScript use a documented escape hatch.
 *
 * @example
 * ```ts
 * import { Engine, workflow, type WorkflowAlreadyRegistered } from '@lostgradient/weft';
 * const greet = workflow({ name: 'greet' }).execute(async function* () { return 'hi'; });
 * const engine = new Engine().register(greet);
 * engine.register(greet as never); // runtime idempotent escape hatch
 * const brand: WorkflowAlreadyRegistered<'greet'> | undefined = undefined;
 * void brand;
 * ```
 */
export interface WorkflowAlreadyRegistered<TName extends string> {
  readonly [workflowAlreadyRegisteredBrand]: TName;
}

// ---------------------------------------------------------------------------
// The builder itself
// ---------------------------------------------------------------------------

/**
 * Chained builder returned by `workflow({ name })`. Each chain method
 * (`activities`, `signals`, `updates`, `queries`, `searchAttributes`) is
 * callable at most once before the terminal `.execute()`. The phantom-flag
 * generic `S` makes a method's type `never` once its flag is true, so
 * duplicate calls fail to typecheck.
 *
 * `.execute(fn)` re-infers the workflow's input and output from the generator
 * signature and returns a frozen `WorkflowDefinition` that carries the
 * normalised activity/signal/update/query maps and search-attribute schema.
 *
 * @example
 * ```ts
 * import { workflow, signal, type InitialBuilderState, type WorkflowBuilder } from '@lostgradient/weft';
 *
 * const builder: WorkflowBuilder<'welcome', {}, {}, {}, {}, {}, InitialBuilderState> =
 *   workflow({ name: 'welcome' });
 *
 * const welcome = builder
 *   .activities({ formatGreeting: async ({ name }: { name: string }) => `Hello, ${name}` })
 *   .signals({ approve: signal<{ approverId: string }>('approve') })
 *   .execute(async function* (ctx, input: { name: string }) {
 *     const greeting = yield* ctx.run('formatGreeting', input);
 *     const { approverId } = yield* ctx.waitForSignal('approve');
 *     return { greeting, approverId };
 *   });
 * void welcome;
 * ```
 */
export interface WorkflowBuilder<
  TName extends string,
  TActivities extends ActivityMap,
  TSignals extends SignalMap,
  TUpdates extends UpdateMap,
  TQueries extends QueryMap,
  TSearchAttributes extends SearchAttributeSchema,
  TState extends BuilderState,
  TServices = unknown,
> {
  /**
   * Declare the activity table this workflow can dispatch with
   * `ctx.run('name', input)`. The outer object key is the canonical activity
   * name; each value can be a bare async function, an `activity()` callable,
   * or an `{ execute, retry?, timeout?, ... }` options object. Calling
   * `.activities` twice before `.execute()` is a type error and throws
   * `WorkflowBuilderError` at runtime.
   *
   * @example
   * ```ts
   * import { workflow } from '@lostgradient/weft';
   * const welcome = workflow({ name: 'welcome' })
   *   .activities({ format: async ({ name }: { name: string }) => `Hello, ${name}!` })
   *   .execute(async function* (ctx, input: { name: string }) {
   *     return yield* ctx.run('format', input);
   *   });
   * void welcome;
   * ```
   */
  activities: TState['activities'] extends true
    ? never
    : <TInput extends ActivityMapInput>(
        map: TInput,
      ) => WorkflowBuilder<
        TName,
        NormalizeActivities<TInput>,
        TSignals,
        TUpdates,
        TQueries,
        TSearchAttributes,
        MarkBuilderState<TState, 'activities'>,
        TServices
      >;

  /**
   * Declare the signals this workflow accepts so `ctx.waitForSignal('name')`
   * autocompletes and types the payload. Type-safety and introspection
   * metadata only — `.signals` does not introduce new runtime gating on top
   * of the existing dispatch path. Calling `.signals` twice before
   * `.execute()` is a type error and throws `WorkflowBuilderError` at runtime.
   *
   * @example
   * ```ts
   * import { signal, workflow } from '@lostgradient/weft';
   * const approval = workflow({ name: 'approval' })
   *   .signals({ approve: signal<{ approverId: string }>('approve') })
   *   .execute(async function* (ctx) {
   *     return yield* ctx.waitForSignal('approve');
   *   });
   * void approval;
   * ```
   */
  signals: TState['signals'] extends true
    ? never
    : <TInput extends SignalMap>(
        map: TInput,
      ) => WorkflowBuilder<
        TName,
        TActivities,
        TInput,
        TUpdates,
        TQueries,
        TSearchAttributes,
        MarkBuilderState<TState, 'signals'>,
        TServices
      >;

  /**
   * Declare the request-response update handlers this workflow accepts.
   * Type-safety and introspection metadata only — the update-dispatch path
   * is unchanged. Calling `.updates` twice before `.execute()` is a type
   * error and throws `WorkflowBuilderError` at runtime.
   *
   * @example
   * ```ts
   * import { update, workflow } from '@lostgradient/weft';
   * const order = workflow({ name: 'order' })
   *   .updates({ check: update<{ id: string }, { ok: boolean }>('check') })
   *   .execute(async function* () { return { ok: true }; });
   * void order;
   * ```
   */
  updates: TState['updates'] extends true
    ? never
    : <TInput extends UpdateMap>(
        map: TInput,
      ) => WorkflowBuilder<
        TName,
        TActivities,
        TSignals,
        TInput,
        TQueries,
        TSearchAttributes,
        MarkBuilderState<TState, 'updates'>,
        TServices
      >;

  /**
   * Declare the read-only query handlers this workflow accepts. Type-safety
   * and introspection metadata only — `.queries` does not introduce new
   * runtime gating. Calling `.queries` twice before `.execute()` is a type
   * error and throws `WorkflowBuilderError` at runtime.
   *
   * @example
   * ```ts
   * import { query, workflow } from '@lostgradient/weft';
   * const job = workflow({ name: 'job' })
   *   .queries({ getProgress: query<void, number>('getProgress') })
   *   .execute(async function* () { return { done: true }; });
   * void job;
   * ```
   */
  queries: TState['queries'] extends true
    ? never
    : <TInput extends QueryMap>(
        map: TInput,
      ) => WorkflowBuilder<
        TName,
        TActivities,
        TSignals,
        TUpdates,
        TInput,
        TSearchAttributes,
        MarkBuilderState<TState, 'queries'>,
        TServices
      >;

  /**
   * Declare the search-attribute schema this workflow populates via
   * `ctx.setAttribute('key', value)`. Each entry pins the attribute's value
   * type so `setAttribute` typechecks both the key and the value. The schema
   * surfaces in the existing visibility/indexing path — no new runtime
   * gating. Calling `.searchAttributes` twice before `.execute()` is a type
   * error and throws `WorkflowBuilderError` at runtime.
   *
   * @example
   * ```ts
   * import { workflow } from '@lostgradient/weft';
   * const order = workflow({ name: 'order' })
   *   .searchAttributes({ customerId: { type: 'string' } })
   *   .execute(async function* (ctx, input: { customerId: string }) {
   *     ctx.setAttribute('customerId', input.customerId);
   *   });
   * void order;
   * ```
   */
  searchAttributes: TState['searchAttributes'] extends true
    ? never
    : <TInput extends SearchAttributeSchema>(
        schema: TInput,
      ) => WorkflowBuilder<
        TName,
        TActivities,
        TSignals,
        TUpdates,
        TQueries,
        TInput,
        MarkBuilderState<TState, 'searchAttributes'>,
        TServices
      >;

  /**
   * Declare the per-run services type exposed at `ctx.services`. This is a
   * type-only marker: services remain supplied at launch through
   * `engine.start(type, input, { services })` and re-provided on recovery by
   * `EngineOptions.resolveWorkflowServices`. Calling `.services` twice before
   * `.execute()` is a type error and throws `WorkflowBuilderError` at runtime.
   *
   * @example
   * ```ts
   * import { workflow } from '@lostgradient/weft';
   *
   * interface Services {
   *   repository: { load(id: string): Promise<string> };
   * }
   *
   * const job = workflow({ name: 'job' })
   *   .services<Services>()
   *   .execute(async function* (ctx, id: string) {
   *     const services = ctx.services;
   *     return services === undefined ? id : yield* ctx.run(() => services.repository.load(id));
   *   });
   * void job;
   * ```
   */
  services: TState['services'] extends true
    ? never
    : <TInput>() => WorkflowBuilder<
        TName,
        TActivities,
        TSignals,
        TUpdates,
        TQueries,
        TSearchAttributes,
        MarkBuilderState<TState, 'services'>,
        TInput
      >;

  /**
   * Seal the builder and produce a `BuiltWorkflowDefinition`. The generator's
   * `input` and `output` types are re-inferred from `fn`'s signature, so the
   * returned definition carries the generator-derived input/output. After
   * `.execute(fn)` runs once, the builder is sealed: every subsequent call
   * (including a second `.execute()`) throws `WorkflowBuilderError`. Nested
   * activity/signal/update/query/search-attribute definitions are
   * deep-frozen so post-build mutation cannot affect engine-side behaviour.
   *
   * @example
   * ```ts
   * import { workflow } from '@lostgradient/weft';
   * const welcome = workflow({ name: 'welcome' })
   *   .activities({ format: async ({ name }: { name: string }) => `Hi ${name}` })
   *   .execute(async function* (ctx, input: { name: string }) {
   *     return yield* ctx.run('format', input);
   *   });
   * void welcome;
   * ```
   */
  execute<TInput, TOutput>(
    fn: WorkflowGenerator<
      TInput,
      TOutput,
      TActivities,
      TSignals,
      TUpdates,
      TQueries,
      TSearchAttributes,
      TServices
    >,
  ): BuiltWorkflowDefinition<
    TInput,
    Awaited<TOutput>,
    TName,
    TActivities,
    TSignals,
    TUpdates,
    TQueries,
    TSearchAttributes,
    TServices
  >;
}

/**
 * The `WorkflowDefinition` returned by `.execute(fn)`. Carries the normalised
 * activity/signal/update/query maps and search-attribute schema alongside the
 * usual `WorkflowDefinition` fields. The runtime objects on these fields are
 * deep-frozen so post-definition mutation cannot affect registered runtime
 * behaviour.
 *
 * The five trailing generic parameters are phantom — they exist so the
 * `Engine.register` type signature can read the workflow's per-message-kind
 * maps off the definition and propagate them to the engine's typed registries
 * without a separate side channel.
 *
 * @example
 * ```ts
 * import { workflow, type BuiltWorkflowDefinition } from '@lostgradient/weft';
 *
 * // `.execute(fn)` returns a `BuiltWorkflowDefinition`. Its `activities`,
 * // `signals`, `updates`, `queries`, and `searchAttributes` containers are
 * // deep-frozen so post-build mutation has no effect on what the engine sees.
 * const welcome = workflow({ name: 'welcome' })
 *   .activities({ format: async ({ name }: { name: string }) => `Hello, ${name}` })
 *   .execute(async function* (ctx, input: { name: string }) {
 *     return { greeting: yield* ctx.run('format', input) };
 *   });
 * const built: BuiltWorkflowDefinition<unknown, unknown, 'welcome', {}, {}, {}, {}, {}> =
 *   welcome as never;
 * void built;
 * ```
 */
export interface BuiltWorkflowDefinition<
  TInput,
  TOutput,
  TName extends string,
  TActivities extends ActivityMap,
  TSignals extends SignalMap,
  TUpdates extends UpdateMap,
  TQueries extends QueryMap,
  TSearchAttributes extends SearchAttributeSchema,
  TServices = unknown,
> extends WorkflowDefinition<TInput, TOutput, TName, TServices> {
  readonly activities: Readonly<Record<string, Readonly<ActivityDefinition>>>;
  readonly signals: Readonly<Record<string, Readonly<SignalDefinition<unknown>>>>;
  readonly updates: Readonly<Record<string, Readonly<UpdateDefinition>>>;
  readonly queries: Readonly<Record<string, Readonly<QueryDefinition>>>;
  readonly searchAttributes: Readonly<SearchAttributeSchema>;
  /** Phantom marker for the normalised activity map. Not present at runtime. */
  readonly _activities?: TActivities;
  /** Phantom marker for the signal map. Not present at runtime. */
  readonly _signals?: TSignals;
  /** Phantom marker for the update map. Not present at runtime. */
  readonly _updates?: TUpdates;
  /** Phantom marker for the query map. Not present at runtime. */
  readonly _queries?: TQueries;
  /** Phantom marker for the search-attribute schema. Not present at runtime. */
  readonly _searchAttributes?: TSearchAttributes;
  /** Phantom marker for the per-run services type. Not present at runtime. */
  readonly _services?: TServices;
}

// ---------------------------------------------------------------------------
// Re-exports for downstream phases
// ---------------------------------------------------------------------------

/**
 * Re-exported so Phase 2 (`workflow()` runtime rewrite) and Phase 3 (engine
 * plumbing) can import everything from a single barrel without picking apart
 * the cross-references.
 */
export type { ActivityCallOptions, ActivityFunction, WorkflowOperation };
