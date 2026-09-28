/**
 * Type-safe worker authoring primitives.
 *
 * These helpers adapt the existing workflow builder contract into the worker
 * transport's `{ workflows: { [workflowType]: { name, activities } } }` shape.
 * The workflow definition remains the authority: activity keys, input, output,
 * and workflow names are inferred from the definition the engine uses.
 *
 * @module worker/authoring
 */

import type { ActivityCallOptions } from '../core/types/activity.ts';
import type { SearchAttributeSchema } from '../core/types/search-attributes.ts';
import type {
  ActivityMap,
  ActivityResultFor,
  NormalizedActivityEntry,
  QueryMap,
  SignalMap,
  UpdateMap,
} from '../core/types/workflow-builder-helpers.ts';
import type { BuiltWorkflowDefinition } from '../core/types/workflow-builder.ts';
import type { RemoteActivityContext } from './remote-activity-context.ts';
import type { RemoteWorkerWorkflowDefinition } from './workflow-activity-binding.ts';

export type { RemoteActivityContext } from './remote-activity-context.ts';

type WorkflowName<TDefinition> = TDefinition extends { readonly name: infer TName extends string }
  ? TName
  : string;

type WorkflowActivities<TDefinition> = TDefinition extends {
  readonly _activities?: infer TActivities extends ActivityMap;
}
  ? TActivities
  : {};

type ActivityInput<TEntry extends NormalizedActivityEntry> =
  TEntry extends NormalizedActivityEntry<infer TInput> ? TInput : unknown;

type ActivityEntryAt<
  TDefinition,
  TName extends keyof WorkflowActivities<TDefinition> & string,
> = WorkflowActivities<TDefinition>[TName] extends infer TEntry extends NormalizedActivityEntry
  ? TEntry
  : never;

type ActivityArguments<TInput> = [TInput] extends [void]
  ? [context?: RemoteActivityContext]
  : [input: TInput, context?: RemoteActivityContext];

type WorkerActivityImplementationFor<TEntry extends NormalizedActivityEntry> = (
  ...arguments_: ActivityArguments<ActivityInput<TEntry>>
) => ActivityResultFor<TEntry> | Promise<ActivityResultFor<TEntry>>;

/** Implementation function for one activity definition. */
export type ActivityImplementation<TEntry extends NormalizedActivityEntry> =
  WorkerActivityImplementationFor<TEntry>;

/** Activity implementation map for one workflow definition. */
export type WorkflowActivityImplementations<TDefinition> = {
  [TName in keyof WorkflowActivities<TDefinition> & string]: ActivityImplementation<
    ActivityEntryAt<TDefinition, TName>
  >;
};

/** Worker implementation object for one workflow definition. */
export type WorkerImplementation<TDefinition> = Readonly<{
  name: WorkflowName<TDefinition>;
  activities: WorkflowActivityImplementations<TDefinition>;
}>;

type ImplementedWorkflowMap = Record<
  string,
  { readonly name: string; readonly activities: object }
>;

type WorkerWorkflowMap<TWorkflows extends ImplementedWorkflowMap> = {
  [TName in keyof TWorkflows & string]: TWorkflows[TName] & { readonly name: TName };
};

export type DefinedWorker<TWorkflows extends ImplementedWorkflowMap> = Readonly<{
  deployment: string;
  workflows: WorkerWorkflowMap<TWorkflows> & Record<string, RemoteWorkerWorkflowDefinition>;
}>;

/**
 * Contract-only activity declaration for workflows that dispatch to a remote
 * worker. It intentionally carries no `execute` function, so it cannot be used
 * as a local inline implementation.
 */
export type RemoteActivityDeclaration<TInput, TOutput, TName extends string = string> = Readonly<{
  name: TName;
  remote: true;
  input?: TInput;
  output?: TOutput;
  timeout?: ActivityCallOptions['timeout'];
  queue?: ActivityCallOptions['queue'];
  retry?: ActivityCallOptions['retry'];
  idempotencyKey?: ActivityCallOptions['idempotencyKey'];
}>;

/**
 * Declare a remote activity contract without creating a same-process fallback
 * implementation.
 */
export function remoteActivity<TInput, TOutput, const TName extends string>(
  options: Omit<RemoteActivityDeclaration<TInput, TOutput, TName>, 'remote'>,
): RemoteActivityDeclaration<TInput, TOutput, TName> {
  return Object.freeze({ ...options, remote: true });
}

/**
 * Bind typed activity implementations to one workflow definition. Missing,
 * extra, or incorrectly typed activity keys fail in object-literal call sites.
 */
export function implementWorkflow<
  TInput,
  TOutput,
  const TName extends string,
  const TActivities extends ActivityMap,
  TSignals extends SignalMap,
  TUpdates extends UpdateMap,
  TQueries extends QueryMap,
  TSearchAttributes extends SearchAttributeSchema,
  TServices,
>(
  definition: BuiltWorkflowDefinition<
    TInput,
    TOutput,
    TName,
    TActivities,
    TSignals,
    TUpdates,
    TQueries,
    TSearchAttributes,
    TServices
  >,
  options: {
    activities: WorkflowActivityImplementations<
      BuiltWorkflowDefinition<
        TInput,
        TOutput,
        TName,
        TActivities,
        TSignals,
        TUpdates,
        TQueries,
        TSearchAttributes,
        TServices
      >
    >;
  },
): WorkerImplementation<
  BuiltWorkflowDefinition<
    TInput,
    TOutput,
    TName,
    TActivities,
    TSignals,
    TUpdates,
    TQueries,
    TSearchAttributes,
    TServices
  >
> {
  return Object.freeze({
    name: definition.name,
    activities: Object.freeze({ ...options.activities }),
  });
}

/**
 * Package workflow implementations into the `RemoteWorker` workflows map.
 * The outer key must match each implementation's literal workflow name.
 */
export function defineWorker<const TWorkflows extends ImplementedWorkflowMap>(options: {
  deployment: string;
  workflows: WorkerWorkflowMap<TWorkflows>;
}): DefinedWorker<TWorkflows> {
  return Object.freeze({
    deployment: options.deployment,
    workflows: Object.freeze({ ...options.workflows }),
  }) as DefinedWorker<TWorkflows>;
}
