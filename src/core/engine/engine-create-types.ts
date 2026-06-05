import type {
  AnyActivityDefinition,
  AnyWorkflowDefinition,
  IsDefaultWorkflowRegistry,
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
> = EngineConstructorOptions & {
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
         * to opt out (tests, `ScopedStorage` isolation, pre-migration
         * inspection).
         */
        recover?: true | undefined;
        /**
         * Forwarded to `Engine.recoverAll`. Only use this during rolling
         * deploys or explicit storage migrations.
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
