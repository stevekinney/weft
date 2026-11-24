/**
 * `createWorkflowFactory`: one shared set of activities, signals, updates, and
 * queries that every workflow built from the factory declares.
 *
 * The factory registers nothing by itself. Each builder it returns starts with
 * the shared entries already declared, so `.execute(fn)` freezes them into the
 * workflow definition exactly as if the workflow had called `.uses({...})`,
 * `.signals({...})`, `.updates({...})`, and `.queries({...})`. Shared
 * activities are engine-provided: dispatch resolves them through the engine's
 * activity registry, so they must be registered on the engine. The factory's
 * `createEngine` does that and the workflow registration in one call.
 *
 * This module sits outside `core/types/` because `createEngine` constructs an
 * `Engine`, and the engine imports the types barrel.
 */

import type {
  EngineCreateOptions,
  EngineCreateWorkflowRegistry,
} from './engine/engine-create-types.ts';
import { ActivityResolutionError } from './engine/errors.ts';
import { Engine } from './engine/index.ts';
import { clonePlain } from './types/clone-plain.ts';
import { deepFreeze } from './types/deep-freeze.ts';
import type {
  QueryDefinition,
  SignalDefinition,
  UpdateDefinition,
} from './types/message-handles.ts';
import { findMessageNameCollisionWithin } from './types/message-name-collisions.ts';
import type {
  ActivityMap,
  NormalizeActivities,
  QueryMap,
  SignalMap,
  UpdateMap,
} from './types/workflow-builder-helpers.ts';
import {
  normalizeUsesMap,
  type SharedWorkflowEntries,
  WorkflowBuilderError,
  type WorkflowBuilderOptions,
} from './types/workflow-builder-runtime.ts';
import type { InitialBuilderState, WorkflowBuilder } from './types/workflow-builder.ts';
import { createWorkflowBuilder } from './types/workflow-function.ts';
import type {
  AnyActivityDefinition,
  AnyWorkflowDefinition,
  InferActivityEntries,
} from './types/workflow-registries.ts';

/**
 * The shared entries passed to {@link createWorkflowFactory}. `activities` takes
 * what `.uses({...})` takes: `activity()` definitions keyed by their own names,
 * which the engine registers and every workflow dispatches by name. `signals`,
 * `updates`, and `queries` take what the matching builder methods take. Every
 * map is optional.
 *
 * @example
 * ```ts
 * import {
 *   activity,
 *   signal,
 *   type SignalDefinition,
 *   type WorkflowFactoryEntries,
 * } from '@lostgradient/weft';
 *
 * const greet = activity({ name: 'greet', execute: async (name: string) => `Hello, ${name}` });
 * const entries: WorkflowFactoryEntries<
 *   { greet: typeof greet },
 *   { approve: SignalDefinition<{ approverId: string }> }
 * > = {
 *   activities: { greet },
 *   signals: { approve: signal<{ approverId: string }>('approve') },
 * };
 * void entries;
 * ```
 */
export interface WorkflowFactoryEntries<
  TActivities extends Record<string, AnyActivityDefinition> = {},
  TSignals extends SignalMap = {},
  TUpdates extends UpdateMap = {},
  TQueries extends QueryMap = {},
> {
  readonly activities?: TActivities;
  readonly signals?: TSignals;
  readonly updates?: TUpdates;
  readonly queries?: TQueries;
}

/**
 * Options for a workflow factory's `createEngine`: everything
 * `Engine.create(...)` accepts, with `workflows` required. `activities` holds
 * any engine-provided activities beyond the factory's own, such as one a single
 * workflow adds with `.uses()`.
 *
 * @example
 * ```ts
 * import { createWorkflowFactory, type WorkflowFactoryEngineOptions } from '@lostgradient/weft';
 *
 * const { workflow } = createWorkflowFactory({});
 * const job = workflow({ name: 'job' }).execute(async function* () {
 *   return 'done';
 * });
 * const options: WorkflowFactoryEngineOptions<{ job: typeof job }> = {
 *   workflows: { job },
 *   recover: false,
 * };
 * void options;
 * ```
 */
export type WorkflowFactoryEngineOptions<
  TWorkflows extends Record<string, AnyWorkflowDefinition>,
  TExtraActivities extends Record<string, AnyActivityDefinition> = {},
> = EngineCreateOptions<TWorkflows, TExtraActivities> & { workflows: TWorkflows };

/**
 * The value {@link createWorkflowFactory} returns. Its members are plain
 * functions and a frozen record, so they can be destructured.
 *
 * - `workflow` takes the options `workflow({ name })` takes and returns a
 *   builder that already declares the shared entries.
 * - `activities` is the shared activity definitions, frozen.
 * - `createEngine` creates an engine with the given workflows and the shared
 *   activities registered. It first checks that every activity any workflow
 *   declares with `.uses()` is provided, and throws `ActivityResolutionError`
 *   before creating the engine if one is not, so no workflow starts or
 *   recovers against an engine missing an activity.
 *
 * @example
 * ```ts
 * import { createWorkflowFactory, type WorkflowFactory } from '@lostgradient/weft';
 *
 * // A factory with no shared entries builds the same workflows `workflow()` does.
 * const factory: WorkflowFactory = createWorkflowFactory({});
 * const job = factory.workflow({ name: 'job' }).execute(async function* () {
 *   return 'done';
 * });
 * void job;
 * ```
 */
export interface WorkflowFactory<
  TActivities extends Record<string, AnyActivityDefinition> = {},
  TSignals extends SignalMap = {},
  TUpdates extends UpdateMap = {},
  TQueries extends QueryMap = {},
> {
  readonly workflow: <const TName extends string>(
    options: WorkflowBuilderOptions<TName>,
  ) => WorkflowBuilder<
    TName,
    FactoryActivityMap<TActivities>,
    TSignals,
    TUpdates,
    TQueries,
    {},
    InitialBuilderState
  >;
  readonly activities: Readonly<TActivities>;
  readonly createEngine: <
    TWorkflows extends Record<string, AnyWorkflowDefinition>,
    TExtraActivities extends Record<string, AnyActivityDefinition> = {},
  >(
    options: WorkflowFactoryEngineOptions<TWorkflows, TExtraActivities>,
  ) => Promise<
    Engine<
      EngineCreateWorkflowRegistry<TWorkflows>,
      InferActivityEntries<TActivities & TExtraActivities>
    >
  >;
}

type FactoryActivityMap<TActivities extends Record<string, AnyActivityDefinition>> =
  NormalizeActivities<TActivities> extends infer TMap extends ActivityMap ? TMap : never;

/**
 * Declare activities, signals, updates, and queries once and share them across
 * many workflows. Every workflow built with the returned `workflow` gets typed
 * `ctx.run('name', input)`, `ctx.waitForSignal('name')`, and the rest for the
 * shared entries.
 *
 * Shared activities are declared on each workflow as if by `.uses({...})`:
 * they are engine-provided, so the engine must register them. Create the
 * engine with the returned `createEngine`, which registers the shared
 * activities with the workflows and refuses to create an engine that would be
 * missing one.
 *
 * A workflow can still add its own entries with `.activities({...})`,
 * `.uses({...})`, `.signals({...})`, `.updates({...})`, and `.queries({...})`;
 * they merge with the shared ones. Redeclaring a name the factory already
 * declares, in any of them, is a type error and throws `WorkflowBuilderError`,
 * so a shared name means the same thing in every workflow. Declared signals,
 * updates, and queries are closed sets, so the factory's declarations close
 * them for every workflow it builds: a message whose name no declaration lists
 * is rejected.
 *
 * @example
 * ```ts
 * import { activity, createWorkflowFactory, signal } from '@lostgradient/weft';
 *
 * const greet = activity({ name: 'greet', execute: async (name: string) => `Hello, ${name}` });
 *
 * const { workflow, createEngine } = createWorkflowFactory({
 *   activities: { greet },
 *   signals: { approve: signal<{ approverId: string }>('approve') },
 * });
 *
 * const welcome = workflow({ name: 'welcome' })
 *   .activities({ shout: async (text: string) => text.toUpperCase() })
 *   .execute(async function* (ctx, name: string) {
 *     const greeting = yield* ctx.run('greet', name);
 *     const { approverId } = yield* ctx.waitForSignal('approve');
 *     return { greeting: yield* ctx.run('shout', greeting), approverId };
 *   });
 *
 * const farewell = workflow({ name: 'farewell' }).execute(async function* (ctx, name: string) {
 *   return yield* ctx.run('greet', name);
 * });
 *
 * const engine = await createEngine({ workflows: { welcome, farewell }, recover: false });
 * void engine;
 * ```
 */
export function createWorkflowFactory<
  TActivities extends Record<string, AnyActivityDefinition> = {},
  TSignals extends SignalMap = {},
  TUpdates extends UpdateMap = {},
  TQueries extends QueryMap = {},
>(
  entries: WorkflowFactoryEntries<TActivities, TSignals, TUpdates, TQueries>,
): WorkflowFactory<TActivities, TSignals, TUpdates, TQueries> {
  // Validate and copy once, so a bad entry fails here and later mutation of
  // the caller's maps cannot change what the factory's workflows declare.
  const activities = Object.freeze({ ...entries.activities }) as Readonly<TActivities>;
  const shared: SharedWorkflowEntries = {
    uses: snapshot(normalizeUsesMap(activities)),
    signals: snapshot(entries.signals as Record<string, SignalDefinition<unknown>> | undefined),
    updates: snapshot(entries.updates as Record<string, UpdateDefinition> | undefined),
    queries: snapshot(entries.queries as Record<string, QueryDefinition> | undefined),
  };
  for (const kind of ['signals', 'updates', 'queries'] as const) {
    const collision = findMessageNameCollisionWithin(shared[kind] ?? {});
    if (collision !== undefined) {
      throw new WorkflowBuilderError(
        `createWorkflowFactory(): ${kind} entry "${collision.key}" occupies the name "${collision.name}", which another shared entry already uses as its key or runtime name`,
      );
    }
  }

  const workflow = <const TName extends string>(options: WorkflowBuilderOptions<TName>) =>
    createWorkflowBuilder(options, shared) as unknown as WorkflowBuilder<
      TName,
      FactoryActivityMap<TActivities>,
      TSignals,
      TUpdates,
      TQueries,
      {},
      InitialBuilderState
    >;

  const createEngine = async (
    options: WorkflowFactoryEngineOptions<Record<string, AnyWorkflowDefinition>>,
  ) => {
    const sharedActivities: Readonly<Record<string, AnyActivityDefinition>> = activities;
    const provided: Record<string, AnyActivityDefinition> = { ...options.activities };
    for (const name of Object.keys(provided)) {
      if (Object.hasOwn(sharedActivities, name) && provided[name] !== sharedActivities[name]) {
        throw new TypeError(
          `createEngine(): activity "${name}" is already provided by the workflow factory; remove it from \`activities\``,
        );
      }
    }
    const all = { ...sharedActivities, ...provided };
    for (const definition of Object.values(options.workflows)) {
      const uses = (definition as { readonly uses?: Readonly<Record<string, unknown>> }).uses;
      for (const name of Object.keys(uses ?? {})) {
        if (!Object.hasOwn(all, name)) throw new ActivityResolutionError(definition.name, name);
      }
    }
    return Engine.create({ ...options, activities: all } as never);
  };

  return Object.freeze({
    workflow,
    activities,
    createEngine,
  }) as unknown as WorkflowFactory<TActivities, TSignals, TUpdates, TQueries>;
}

/**
 * Clone and freeze each shared definition, schemas included, so mutating one
 * after the factory is created cannot change what later workflows declare.
 */
function snapshot<T extends object>(map: Record<string, T> | undefined): Record<string, T> {
  // A null prototype keeps a `__proto__` key an own entry.
  const out = Object.create(null) as Record<string, T>;
  for (const [key, definition] of Object.entries(map ?? {})) {
    out[key] = deepFreeze(clonePlain(definition));
  }
  return out;
}
