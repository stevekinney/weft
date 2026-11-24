/**
 * Runtime implementation for the chained workflow builder. The class and its
 * normalisation helpers live in this file so `workflow-function.ts` stays
 * inside the 500-line lint ceiling. Phase 2 owns this file; Phase 3 reads the
 * resulting `BuiltWorkflowDefinition` shape via the type imports.
 */

import type { ConstraintDefinition } from '../constraint.ts';
import type { WorkflowWorkerVersioningPolicy } from '../versioning.ts';
import { WeftError } from '../weft-error.ts';
import type { ActivityDefinition, ActivityFunction } from './activity.ts';
import { clonePlain } from './clone-plain.ts';
import { deepFreeze } from './deep-freeze.ts';
import type { DefinitionSchema } from './definition-schema.ts';
import type { QueryDefinition, SignalDefinition, UpdateDefinition } from './message-handles.ts';
import { findMessageNameCollision } from './message-name-collisions.ts';
import { validateWorkflowOrActivityName } from './name-grammar.ts';
import type { RetentionPolicy } from './retry-retention.ts';
import type { SearchAttributeSchema } from './search-attributes.ts';
import type {
  ActivityEntryInput,
  ActivityMap,
  ActivityMapInput,
  QueryMap,
  SignalMap,
  UpdateMap,
  UsedActivityDefinition,
  UsesMapInput,
} from './workflow-builder-helpers.ts';
import type { BuiltWorkflowDefinition } from './workflow-builder.ts';
import type { WorkflowConcurrencyOptions } from './workflow-concurrency.ts';
import type { WorkflowFunction } from './workflow-function.ts';
import type { AnyActivityDefinition } from './workflow-registries.ts';

// ---------------------------------------------------------------------------
// Errors and options shape
// ---------------------------------------------------------------------------

/**
 * Thrown by the chained workflow builder for runtime invariants that the type
 * system cannot reliably catch — duplicate chain calls, key/name collisions
 * inside `.activities({ ... })`, method calls after `.execute()` has run, and
 * `.execute()` being called twice. Throwing a named error class (rather than a
 * bare `Error`) makes the failure greppable and tests can pin behaviour
 * precisely.
 *
 * @example
 * ```ts
 * import { workflow, WorkflowBuilderError } from '@lostgradient/weft';
 *
 * const builder = workflow({ name: 'demo' }).activities({ ping: async () => 'pong' });
 * try {
 *   // Re-calling `.activities()` after it's already been set throws at runtime.
 *   (builder as unknown as { activities: (map: object) => unknown }).activities({
 *     pong: async () => 'ping',
 *   });
 * } catch (error) {
 *   if (error instanceof WorkflowBuilderError) {
 *     // duplicate `.activities()` call rejected at runtime.
 *     void error.message;
 *   }
 * }
 * ```
 */
export class WorkflowBuilderError extends WeftError<'WorkflowBuilderError'> {
  constructor(message: string) {
    super('WorkflowBuilderError', message);
  }
}

/**
 * Initial options accepted by the builder-form `workflow({ name, ... })` call.
 * Extra metadata fields (`version`, `description`, `tags`, `retention`,
 * `concurrency`, `inputSchema`, `outputSchema`, `constraints`) are passed through
 * onto the returned {@link BuiltWorkflowDefinition} when `.execute(fn)` runs.
 * Only `name` is required.
 *
 * @example
 * ```ts
 * import { workflow, type WorkflowBuilderOptions } from '@lostgradient/weft';
 *
 * const options: WorkflowBuilderOptions<'welcome'> = {
 *   name: 'welcome',
 *   description: 'Greets a new user.',
 * };
 * const welcome = workflow(options).execute(async function* () { return 'ok'; });
 * void welcome;
 * ```
 */
export interface WorkflowBuilderOptions<
  TName extends string = string,
  TConcurrencyInput = unknown,
> {
  name: TName;
  version?: string;
  description?: string;
  tags?: ReadonlyArray<string>;
  retention?: RetentionPolicy;
  concurrency?: WorkflowConcurrencyOptions<TConcurrencyInput>;
  constraints?: ConstraintDefinition[];
  /**
   * Definition-level teardown activity driven by the engine after a
   * `cancelled`/`timed-out` terminal (issue #446). See
   * {@link WorkflowDefinition.finalizer}.
   */
  finalizer?: AnyActivityDefinition;
  inputSchema?: DefinitionSchema<unknown, unknown>;
  outputSchema?: DefinitionSchema<unknown, unknown>;
  workerVersioningPolicy?: WorkflowWorkerVersioningPolicy;
  /**
   * Explicitly forbidden: `workflow({ name }).execute(handler)` is the only
   * way to attach a handler. The builder rejects an in-options `handler`
   * field so the chained `.execute()` step is the single source of truth.
   */
  handler?: never;
}

// ---------------------------------------------------------------------------
// Builder implementation
// ---------------------------------------------------------------------------

/**
 * Entries a builder starts with, already normalised. `createWorkflowFactory`
 * supplies them; a plain `workflow({ name })` builder starts empty.
 */
export interface SharedWorkflowEntries {
  /** Engine-provided activities, declared on every workflow as if by `.uses()`. */
  readonly uses?: Readonly<Record<string, UsedActivityDefinition>>;
  readonly signals?: Readonly<Record<string, SignalDefinition<unknown>>>;
  readonly updates?: Readonly<Record<string, UpdateDefinition>>;
  readonly queries?: Readonly<Record<string, QueryDefinition>>;
}

type ChainMethodName =
  'activities' | 'uses' | 'signals' | 'updates' | 'queries' | 'searchAttributes' | 'services';

/**
 * Runtime implementation backing the {@link WorkflowBuilder} type. The class
 * is intentionally private to the module graph — callers always receive it
 * through {@link workflow} and type-narrow to `WorkflowBuilder` so the
 * phantom-flag state machine prevents duplicate chain calls at compile time.
 * The runtime mirrors the same invariants with state flags so misuse from
 * untyped JavaScript still throws.
 */
export class WorkflowBuilderImpl<TName extends string> {
  readonly #options: WorkflowBuilderOptions<TName>;
  readonly #called: Record<ChainMethodName, boolean> = {
    activities: false,
    uses: false,
    signals: false,
    updates: false,
    queries: false,
    searchAttributes: false,
    services: false,
  };
  #executed = false;
  #activities: Record<string, ActivityDefinition> = {};
  #uses: Record<string, UsedActivityDefinition>;
  #signals: Record<string, SignalDefinition<unknown>>;
  #updates: Record<string, UpdateDefinition>;
  #queries: Record<string, QueryDefinition>;
  #searchAttributes: SearchAttributeSchema = {};

  constructor(options: WorkflowBuilderOptions<TName>, shared: SharedWorkflowEntries = {}) {
    this.#options = options;
    this.#uses = { ...shared.uses };
    this.#signals = { ...shared.signals };
    this.#updates = { ...shared.updates };
    this.#queries = { ...shared.queries };
  }

  /**
   * Add a chain method's entries to the ones the builder already carries from
   * `createWorkflowFactory`. An entry occupying any name a shared entry
   * occupies, its key or its runtime name, is rejected rather than overriding
   * it, so a shared entry means the same thing in every workflow.
   */
  #merge<T>(method: ChainMethodName, current: Record<string, T>, added: Record<string, T>) {
    const collision = findMessageNameCollision(current, added);
    if (collision !== undefined) {
      const { key, name } = collision;
      const as = name === key ? '' : ` with runtime name "${name}"`;
      throw new WorkflowBuilderError(
        `workflow("${this.#options.name}"): .${method}() declares "${key}"${as}, which the workflow factory already declares. Shared entries cannot be overridden; give this one a different name.`,
      );
    }
    return { ...current, ...added };
  }

  #assertOpen(method: ChainMethodName | 'execute'): void {
    if (this.#executed) {
      throw new WorkflowBuilderError(
        `workflow("${this.#options.name}"): .${method}() called after .execute() — the builder is sealed once .execute() has run`,
      );
    }
  }

  #markCalled(method: ChainMethodName): void {
    if (this.#called[method]) {
      throw new WorkflowBuilderError(
        `workflow("${this.#options.name}"): .${method}() can only be called once before .execute()`,
      );
    }
    this.#called[method] = true;
  }

  activities = (map: ActivityMapInput): this => {
    this.#assertOpen('activities');
    this.#markCalled('activities');
    const scoped = normalizeActivityMap(map);
    // A factory's shared activities are `.uses()` entries, so a workflow-scoped
    // activity of the same name would shadow the engine's implementation.
    this.#merge('activities', this.#uses, scoped);
    this.#activities = scoped;
    return this;
  };

  uses = (map: UsesMapInput): this => {
    this.#assertOpen('uses');
    this.#markCalled('uses');
    this.#uses = this.#merge('uses', this.#uses, normalizeUsesMap(map));
    return this;
  };

  signals = (map: SignalMap): this => {
    this.#assertOpen('signals');
    this.#markCalled('signals');
    this.#signals = this.#merge('signals', this.#signals, map);
    return this;
  };

  updates = (map: UpdateMap): this => {
    this.#assertOpen('updates');
    this.#markCalled('updates');
    this.#updates = this.#merge('updates', this.#updates, map);
    return this;
  };

  queries = (map: QueryMap): this => {
    this.#assertOpen('queries');
    this.#markCalled('queries');
    this.#queries = this.#merge('queries', this.#queries, map);
    return this;
  };

  searchAttributes = (schema: SearchAttributeSchema): this => {
    this.#assertOpen('searchAttributes');
    this.#markCalled('searchAttributes');
    this.#searchAttributes = { ...schema };
    return this;
  };

  services = (): this => {
    this.#assertOpen('services');
    this.#markCalled('services');
    return this;
  };

  execute = (
    fn: WorkflowFunction,
  ): BuiltWorkflowDefinition<
    unknown,
    unknown,
    TName,
    ActivityMap,
    SignalMap,
    UpdateMap,
    QueryMap,
    SearchAttributeSchema
  > => {
    this.#assertOpen('execute');
    assertNoScopedActivityIsUsed(this.#options.name, this.#activities, this.#uses);
    this.#executed = true;

    // Deep-clone-and-freeze every nested definition. We do this against the
    // private maps before publishing the immutable view so any post-build
    // mutation of the *original* user-supplied references cannot reach the
    // engine's per-workflow registry.
    const frozenActivities = freezeRecord(this.#activities);
    const frozenUses = freezeRecord(this.#uses);
    const frozenSignals = freezeRecord(this.#signals);
    const frozenUpdates = freezeRecord(this.#updates);
    const frozenQueries = freezeRecord(this.#queries);
    const frozenSearchAttributes = deepFreeze(clonePlain(this.#searchAttributes));

    const handler: WorkflowFunction = (context, input) => fn(context, input);

    const built: BuiltWorkflowDefinition<
      unknown,
      unknown,
      TName,
      ActivityMap,
      SignalMap,
      UpdateMap,
      QueryMap,
      SearchAttributeSchema
    > = {
      name: this.#options.name,
      handler,
      activities: frozenActivities,
      ...usesField(frozenUses),
      signals: frozenSignals,
      updates: frozenUpdates,
      queries: frozenQueries,
      searchAttributes: frozenSearchAttributes,
      ...(this.#options.version !== undefined ? { version: this.#options.version } : {}),
      ...(this.#options.description !== undefined
        ? { description: this.#options.description }
        : {}),
      ...(this.#options.tags !== undefined ? { tags: this.#options.tags } : {}),
      ...(this.#options.retention !== undefined ? { retention: this.#options.retention } : {}),
      ...(this.#options.concurrency !== undefined
        ? {
            concurrency: deepFreeze(clonePlain(this.#options.concurrency)),
          }
        : {}),
      ...(this.#options.constraints !== undefined
        ? { constraints: this.#options.constraints }
        : {}),
      ...(this.#options.finalizer !== undefined ? { finalizer: this.#options.finalizer } : {}),
      ...(this.#options.inputSchema !== undefined
        ? { inputSchema: this.#options.inputSchema }
        : {}),
      ...(this.#options.outputSchema !== undefined
        ? { outputSchema: this.#options.outputSchema }
        : {}),
      ...workerVersioningPolicyField(this.#options.workerVersioningPolicy),
    };

    return Object.freeze(built);
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// `clonePlain` is imported from `./clone-plain.ts` — the shared recursive POJO
// clone that preserves function refs verbatim (which `structuredClone` cannot)
// and lets `deepFreeze` lock the containers down.

/**
 * Deep-clone each entry, deep-freeze the clone, and assemble into a frozen
 * outer record. Used for the `activities`/`signals`/`updates`/`queries` maps
 * on the built workflow definition.
 */
function freezeRecord<T extends object>(
  map: Record<string, T>,
): Readonly<Record<string, Readonly<T>>> {
  const out = createNameRecord<T>();
  for (const key of Object.keys(map)) {
    out[key] = deepFreeze(clonePlain(map[key])) as T;
  }
  return Object.freeze(out);
}

/**
 * A null-prototype record for the builder's name-keyed maps. `__proto__` is a
 * grammar-valid activity name, and assigning it on a plain `{}` would set the
 * prototype instead of storing an entry, dropping the declaration silently.
 */
function createNameRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function isFunction(value: unknown): value is (...arguments_: unknown[]) => unknown {
  return typeof value === 'function';
}

function usesField(uses: Readonly<Record<string, UsedActivityDefinition>>): {
  uses?: Readonly<Record<string, UsedActivityDefinition>>;
} {
  return Object.keys(uses).length === 0 ? {} : { uses };
}

function workerVersioningPolicyField(policy: WorkflowWorkerVersioningPolicy | undefined): {
  workerVersioningPolicy?: WorkflowWorkerVersioningPolicy;
} {
  return policy === undefined ? {} : { workerVersioningPolicy: policy };
}

function hasExecuteProperty(
  value: unknown,
): value is { execute: ActivityFunction; name?: unknown } & Record<string, unknown> {
  if (value === null) return false;
  const kind = typeof value;
  // Accept both plain objects and functions-with-attached-properties
  // (`ActivityCallable` is the latter — `activity()` returns a function with
  // own properties for `execute`, `name`, `retry`, etc.).
  if (kind !== 'object' && kind !== 'function') return false;
  const record = value as Record<string, unknown>;
  return 'execute' in record && typeof record['execute'] === 'function';
}

/**
 * Normalise an `.activities({ ... })` map. For each entry:
 *
 *   1. Validate the outer key against the wire-safe name grammar.
 *   2. Accept bare functions, `ActivityCallable` (which is both function and
 *      object), and object-form `{ execute, retry?, timeout?, ... }`.
 *   3. If the value carries its own `name` field and that name disagrees with
 *      the outer key, throw immediately so the mistake surfaces at the
 *      `.activities()` call site rather than at engine registration.
 *   4. Synthesize an `ActivityDefinition` whose `name` is the outer key and
 *      `execute` is the provided function. Object-form options pass through.
 */
function normalizeActivityMap(map: ActivityMapInput): Record<string, ActivityDefinition> {
  const out = createNameRecord<ActivityDefinition>();
  for (const key of Object.keys(map)) {
    validateWorkflowOrActivityName(key, 'activity');
    const entry: ActivityEntryInput = map[key]!;

    if (hasExecuteProperty(entry)) {
      const innerName = (entry as { name?: unknown }).name;
      if (typeof innerName === 'string' && innerName.length > 0 && innerName !== key) {
        throw new WorkflowBuilderError(
          `.activities(): key "${key}" disagrees with inner activity name "${innerName}". The outer key is canonical — remove the inner \`name\` field or align it with the key.`,
        );
      }
      const { name: _ignored, execute, ...rest } = entry as Record<string, unknown>;
      out[key] = {
        ...(rest as Omit<ActivityDefinition, 'name' | 'execute'>),
        name: key,
        execute: execute as ActivityFunction,
      };
      continue;
    }

    if (isFunction(entry)) {
      // Bare function (or function-only `ActivityCallable` with no `execute`
      // own-property — defensive, the `activity()` helper always sets one).
      // Wrap as a synthetic ActivityDefinition.
      out[key] = {
        name: key,
        execute: entry,
      };
      continue;
    }

    throw new WorkflowBuilderError(
      `.activities(): entry "${key}" must be a function, an activity() callable, or an object with an \`execute\` function`,
    );
  }
  return out;
}

/**
 * Normalise a `.uses({ ... })` map. Each entry names an activity the engine
 * provides (registered through `Engine.create({ activities })` or
 * `engine.register(activity)`), so unlike `.activities()` it must carry its own
 * `name`, and that name must equal the outer key: the engine resolves it by
 * that name in its global registry, never from this definition's `execute`.
 * A bare function is rejected even when its inferred `name` matches, since it
 * is not the definition the engine registers.
 * Only the name and schema metadata are kept, which is all a contract reads.
 */
export function normalizeUsesMap(map: UsesMapInput): Record<string, UsedActivityDefinition> {
  const out = createNameRecord<UsedActivityDefinition>();
  for (const key of Object.keys(map)) {
    validateWorkflowOrActivityName(key, 'activity');
    const entry: unknown = map[key];
    if (!hasExecuteProperty(entry) || entry.name !== key) {
      throw new WorkflowBuilderError(
        `.uses(): entry "${key}" must be an activity definition named "${key}" — pass the activity() definition the engine registers, keyed by its name`,
      );
    }
    const { inputSchema, outputSchema } = entry as {
      inputSchema?: DefinitionSchema;
      outputSchema?: DefinitionSchema;
    };
    out[key] = {
      name: key,
      ...(inputSchema === undefined ? {} : { inputSchema }),
      ...(outputSchema === undefined ? {} : { outputSchema }),
    };
  }
  return out;
}

function assertNoScopedActivityIsUsed(
  workflowName: string,
  activities: Readonly<Record<string, ActivityDefinition>>,
  uses: Readonly<Record<string, UsedActivityDefinition>>,
): void {
  for (const name of Object.keys(uses)) {
    if (Object.hasOwn(activities, name)) {
      throw new WorkflowBuilderError(
        `workflow("${workflowName}"): activity "${name}" is declared in both .activities() and .uses() — a workflow-scoped activity already shadows the engine's, so declare it in one place`,
      );
    }
  }
}
