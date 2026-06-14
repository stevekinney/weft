import type {
  AnyActivityDefinition,
  AnyWorkflowDefinition,
  DefaultWorkflowRegistry,
  InferWorkflowEntries,
  IsDefaultWorkflowRegistry,
  WorkflowServicesUnion,
} from '../types.ts';
import type { UnknownNameWhenRegistryHasNoKnownNames } from '../types/registry-type-helpers.ts';
import type { KnownWorkflowNames } from './construction.ts';
import type { EngineConstructorOptions } from './engine-internal-types.ts';

/**
 * Options accepted by `Engine.create`. Definition maps are used for type
 * inference, then each map key is checked against the definition's runtime
 * `name` before registration.
 *
 * @example
 * ```ts
 * import { activity, Engine, workflow, type EngineCreateOptions } from '@lostgradient/weft';
 *
 * const greet = activity({ name: 'greet', execute: async (name: string) => `Hello, ${name}` });
 * const welcome = workflow({ name: 'welcome' }).execute(async function* (ctx, input: string) {
 *   return yield* ctx.run(greet, input);
 * });
 *
 * const options = {
 *   workflows: { welcome },
 *   activities: { greet },
 * } satisfies EngineCreateOptions<{ welcome: typeof welcome }, { greet: typeof greet }>;
 * const engine = await Engine.create(options);
 * void engine;
 * ```
 */
export type EngineCreateOptions<
  TWorkflowDefinitions extends Record<string, AnyWorkflowDefinition> = {},
  TActivityDefinitions extends Record<string, AnyActivityDefinition> = {},
> = EngineConstructorOptions<
  WorkflowServicesUnion<EngineCreateWorkflowRegistry<TWorkflowDefinitions>>
> & {
  /** Workflow definitions to register before recovery. */
  workflows?: TWorkflowDefinitions;
  /** Activity definitions to register before workflows. */
  activities?: TActivityDefinitions;
} & (
    | {
        /**
         * Recover stored running workflows after registration. Defaults to
         * `true`: a fresh engine booting against durable storage resumes any
         * workflows left in flight by a previous process. Pass `recover: false`
         * to opt out (tests, `ScopedStorage` isolation, explicit operator
         * inspection).
         */
        recover?: true | undefined;
        /**
         * Forwarded to `Engine.recoverAll`. Only use this during rolling
         * deploys or explicit operator storage repair.
         */
        acknowledgeUnknownWorkflowTypes?: boolean;
      }
    | {
        /** Opt out of recovering stored running workflows after registration. */
        recover: false;
        /** Only valid when recovery is enabled (the default). Invalid with `recover: false`. */
        acknowledgeUnknownWorkflowTypes?: never;
      }
  );

/**
 * Resolves the workflow registry type for `Engine.create` return values.
 *
 * When the provided workflow definition map is empty (`{}`), the resulting
 * engine carries the same `DefaultWorkflowRegistry` brand as an engine
 * constructed without a `workflows` map at all — the two are semantically
 * identical. A non-empty map routes to `InferWorkflowEntries` so literal
 * workflow-name inference is preserved.
 */
export type EngineCreateWorkflowRegistry<
  TWorkflowDefinitions extends Record<string, AnyWorkflowDefinition>,
  // The tuple wrap mirrors the guard inside `InferWorkflowEntries` and avoids the
  // naked-`extends`-never distributive-conditional pitfall (which would collapse
  // to `never` and silently drop the brand).
> = [keyof TWorkflowDefinitions & string] extends [never]
  ? DefaultWorkflowRegistry
  : InferWorkflowEntries<TWorkflowDefinitions>;

export type UnknownWorkflowNameWhenDefaultRegistryIsEmpty<
  TWorkflows extends object,
  TName extends string,
> =
  IsDefaultWorkflowRegistry<TWorkflows> extends true
    ? UnknownNameWhenRegistryHasNoKnownNames<TName, KnownWorkflowNames<TWorkflows>>
    : never;

export type ActivityDefinitionName<TDefinition extends AnyActivityDefinition> =
  TDefinition extends {
    readonly name: infer TName extends string;
  }
    ? TName
    : string;

export type RegisteredActivityDefinitionExecute<
  TActivities extends object,
  TName extends Extract<keyof TActivities, string>,
> = TActivities[TName] extends (...arguments_: infer TArguments) => infer TResult
  ? (...arguments_: TArguments) => Awaited<TResult> | Promise<Awaited<TResult>>
  : never;
