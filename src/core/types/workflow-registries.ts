import type { ActivityContext, ActivityDefinition, ActivityFunction } from './activity.ts';
import type {
  StepWorkflowFunction,
  WorkflowDefinition,
  WorkflowFunction,
} from './workflow-function.ts';

/**
 * Module-augmentation target for typed workflow names. Add entries with
 * `input` and `output` fields to make `engine.register`, `engine.start`, and
 * `WorkflowHandle.result()` type-safe for string workflow names.
 *
 * @example
 * ```ts
 * import type { WorkflowRegistry } from 'weft';
 *
 * interface WelcomeInput {
 *   name: string;
 * }
 *
 * interface WelcomeOutput {
 *   greeting: string;
 * }
 *
 * declare module 'weft' {
 *   interface WorkflowRegistry {
 *     welcome: { input: WelcomeInput; output: WelcomeOutput };
 *   }
 * }
 *
 * const welcomeInput: WorkflowRegistry['welcome']['input'] = { name: 'Ada' };
 * void welcomeInput;
 * ```
 */
export interface WorkflowRegistry {}

/**
 * Module-augmentation target for typed activity names. This intentionally uses
 * `ActivityTypes` instead of `ActivityRegistry` so it does not collide with
 * the public runtime {@link ActivityRegistry} class.
 *
 * @example
 * ```ts
 * import type { ActivityTypes } from 'weft';
 *
 * interface FormatGreetingInput {
 *   name: string;
 * }
 *
 * declare module 'weft' {
 *   interface ActivityTypes {
 *     formatGreeting: (input: FormatGreetingInput) => Promise<string>;
 *   }
 * }
 *
 * const formatGreeting: ActivityTypes['formatGreeting'] = async (input) =>
 *   `Hello, ${input.name}`;
 * void formatGreeting;
 * ```
 */
export interface ActivityTypes {}

export type WorkflowRegistryEntry = { input: unknown; output: unknown };

declare const dynamicWorkflowRegistryFallback: unique symbol;

type DynamicWorkflowRegistryFallback = {
  readonly [dynamicWorkflowRegistryFallback]: true;
};

/**
 * Default workflow registry carried by `new Engine()` when no local registry
 * type parameters are supplied. It preserves module-augmented workflow names
 * and the legacy dynamic-name fallback.
 */
export type DefaultWorkflowRegistry = WorkflowRegistry & DynamicWorkflowRegistryFallback;

/**
 * Resolve whether an engine registry type should keep the legacy dynamic
 * workflow-name overloads. `new Engine<{}, {}>()` omits the marker and becomes
 * strict after builder registration.
 */
export type AllowsDynamicWorkflowNames<TRegistry extends object> =
  TRegistry extends DynamicWorkflowRegistryFallback ? true : false;

/**
 * Broad workflow-definition constraint used by {@link Engine.create} and the
 * typed builder methods. `never` in the input position lets concrete
 * definitions such as `WorkflowDefinition<string, string>` satisfy the
 * constraint under strict function variance.
 *
 * @example
 * ```ts
 * import { workflow, type AnyWorkflowDefinition } from 'weft';
 *
 * const greet = workflow({
 *   name: 'greet',
 *   handler: async function* (_ctx, input: string) {
 *     return `Hello, ${input}`;
 *   },
 * });
 * const definition: AnyWorkflowDefinition = greet;
 * void definition;
 * ```
 */
export type AnyWorkflowDefinition = {
  readonly name: string;
  readonly handler: WorkflowFunction<never> | StepWorkflowFunction<never>;
};

/**
 * Broad activity-definition constraint used by {@link Engine.create} and
 * `Engine.register`. It models the callable values returned by
 * {@link activity} so registration keeps colocated retry, timeout, schema,
 * and middleware metadata attached to the function object.
 *
 * @example
 * ```ts
 * import { activity, type AnyActivityDefinition } from 'weft';
 *
 * const greet = activity({ name: 'greet', execute: async (name: string) => `Hello, ${name}` });
 * const definition: AnyActivityDefinition = greet;
 * void definition;
 * ```
 */
export type AnyActivityDefinition = {
  readonly name: string;
  readonly execute: ActivityFunction<never>;
} & ((input: never, context?: ActivityContext) => Promise<unknown>);

export type WorkflowInput<
  TRegistry extends object,
  TName extends string,
> = TName extends keyof TRegistry
  ? TRegistry[TName] extends { input: infer TInput }
    ? TInput
    : unknown
  : unknown;

export type WorkflowOutput<
  TRegistry extends object,
  TName extends string,
> = TName extends keyof TRegistry
  ? TRegistry[TName] extends { output: infer TOutput }
    ? TOutput
    : unknown
  : unknown;

export type ActivityArguments<
  TActivities extends object,
  TName extends string,
> = TName extends keyof TActivities
  ? TActivities[TName] extends () => unknown
    ? []
    : TActivities[TName] extends (input: infer TInput) => unknown
      ? [input: TInput]
      : [input: unknown]
  : [input?: unknown];

export type ActivityResult<
  TActivities extends object,
  TName extends string,
> = TName extends keyof TActivities
  ? TActivities[TName] extends (...arguments_: infer _TArguments) => infer TResult
    ? Awaited<TResult>
    : unknown
  : unknown;

export type RegisteredActivityFunction<
  TActivities extends object,
  TName extends string,
> = TName extends keyof TActivities
  ? TActivities[TName] extends () => infer TResult
    ? () => TResult
    : TActivities[TName] extends (input: infer TInput) => infer TResult
      ? (input: TInput) => TResult
      : never
  : never;

export type UnregisteredName<TName extends string, TKnownNames extends string> = TName &
  (TName extends TKnownNames ? never : unknown);

type UnionToIntersection<TUnion> = (
  TUnion extends unknown ? (value: TUnion) => void : never
) extends (value: infer TIntersection) => void
  ? TIntersection
  : never;

type MergeDefinitionEntries<TUnion> = [TUnion] extends [never]
  ? {}
  : UnionToIntersection<TUnion> extends infer TIntersection
    ? TIntersection extends object
      ? TIntersection
      : {}
    : {};

/**
 * Infer a workflow registry entry from one concrete workflow definition. This
 * is used by `Engine.register`, where the definition's literal `name`
 * carries the registry key.
 *
 * @example
 * ```ts
 * import { workflow, type InferWorkflowEntry } from 'weft';
 *
 * const greet = workflow({
 *   name: 'greet',
 *   handler: async function* (_ctx, input: string) {
 *     return `Hello, ${input}`;
 *   },
 * });
 * type GreetWorkflow = InferWorkflowEntry<typeof greet>;
 * const input: GreetWorkflow['greet']['input'] = 'Ada';
 * void input;
 * ```
 */
export type InferWorkflowEntry<TDefinition extends AnyWorkflowDefinition> =
  TDefinition extends WorkflowDefinition<infer TInput, infer TOutput, infer TName extends string>
    ? { [Name in TName]: { input: TInput; output: TOutput } }
    : never;

type InferWorkflowEntryForKey<TName extends string, TDefinition extends AnyWorkflowDefinition> =
  TDefinition extends WorkflowDefinition<infer TInput, infer TOutput>
    ? { [Name in TName]: { input: TInput; output: TOutput } }
    : never;

/**
 * Infer a workflow registry from a definition map. Map keys are the source of
 * truth for `Engine.create`, and runtime creation validates each key against
 * `definition.name` before registration.
 *
 * @example
 * ```ts
 * import { workflow, type InferWorkflowEntries } from 'weft';
 *
 * const greet = workflow({
 *   name: 'greet',
 *   handler: async function* (_ctx, input: string) {
 *     return `Hello, ${input}`;
 *   },
 * });
 * type Workflows = InferWorkflowEntries<{ greet: typeof greet }>;
 * const output: Workflows['greet']['output'] = 'Hello, Ada';
 * void output;
 * ```
 */
export type InferWorkflowEntries<TDefinitions extends Record<string, AnyWorkflowDefinition>> = [
  keyof TDefinitions & string,
] extends [never]
  ? {}
  : MergeDefinitionEntries<
      {
        [Name in keyof TDefinitions & string]: InferWorkflowEntryForKey<Name, TDefinitions[Name]>;
      }[keyof TDefinitions & string]
    >;

type ActivityDefinitionFunction<TInput, TOutput> = [TInput] extends [void]
  ? () => Promise<Awaited<TOutput>>
  : (input: TInput) => Promise<Awaited<TOutput>>;

type ActivityEntryForDefinition<TName extends string, TInput, TOutput> = Record<
  TName,
  ActivityDefinitionFunction<TInput, TOutput>
>;

/**
 * Infer an activity registry entry from one concrete activity definition.
 * The signature intentionally routes through {@link ActivityArguments} and
 * {@link ActivityResult} so zero-input activities remain zero-argument
 * entries instead of widening to optional-input functions.
 *
 * @example
 * ```ts
 * import { activity, type InferActivityEntry } from 'weft';
 *
 * const ping = activity({ name: 'ping', execute: async () => 'pong' });
 * type PingActivity = InferActivityEntry<typeof ping>;
 * const run: PingActivity['ping'] = async () => 'pong';
 * void run;
 * ```
 */
export type InferActivityEntry<TDefinition extends AnyActivityDefinition> =
  TDefinition extends ActivityDefinition<infer TInput, infer TOutput, infer TName extends string>
    ? {
        [Name in TName]: (
          ...arguments_: ActivityArguments<ActivityEntryForDefinition<Name, TInput, TOutput>, Name>
        ) => Promise<
          Awaited<ActivityResult<ActivityEntryForDefinition<Name, TInput, TOutput>, Name>>
        >;
      }
    : never;

type InferActivityEntryForKey<TName extends string, TDefinition extends AnyActivityDefinition> =
  TDefinition extends ActivityDefinition<infer TInput, infer TOutput>
    ? {
        [Name in TName]: (
          ...arguments_: ActivityArguments<ActivityEntryForDefinition<Name, TInput, TOutput>, Name>
        ) => Promise<
          Awaited<ActivityResult<ActivityEntryForDefinition<Name, TInput, TOutput>, Name>>
        >;
      }
    : never;

/**
 * Infer an activity registry from a definition map. Map keys are the source of
 * truth for `Engine.create`, and runtime creation validates each key against
 * `definition.name` before registration.
 *
 * @example
 * ```ts
 * import { activity, type InferActivityEntries } from 'weft';
 *
 * const greet = activity({ name: 'greet', execute: async (name: string) => `Hello, ${name}` });
 * type Activities = InferActivityEntries<{ greet: typeof greet }>;
 * const run: Activities['greet'] = async (name) => `Hello, ${name}`;
 * void run;
 * ```
 */
export type InferActivityEntries<TDefinitions extends Record<string, AnyActivityDefinition>> = [
  keyof TDefinitions & string,
] extends [never]
  ? {}
  : MergeDefinitionEntries<
      {
        [Name in keyof TDefinitions & string]: InferActivityEntryForKey<Name, TDefinitions[Name]>;
      }[keyof TDefinitions & string]
    >;
