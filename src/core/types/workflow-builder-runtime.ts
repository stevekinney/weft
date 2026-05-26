/**
 * Runtime implementation for the chained workflow builder. The class and its
 * normalisation helpers live in this file so `workflow-function.ts` stays
 * inside the 500-line lint ceiling. Phase 2 owns this file; Phase 3 reads the
 * resulting `BuiltWorkflowDefinition` shape via the type imports.
 */

import type { ConstraintDefinition } from '../constraint.ts';
import { WeftError } from '../weft-error.ts';
import type { ActivityDefinition, ActivityFunction } from './activity.ts';
import { clonePlain } from './clone-plain.ts';
import { deepFreeze } from './deep-freeze.ts';
import type { DefinitionSchema } from './definition-schema.ts';
import type { QueryDefinition, SignalDefinition, UpdateDefinition } from './message-handles.ts';
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
} from './workflow-builder-helpers.ts';
import type { BuiltWorkflowDefinition } from './workflow-builder.ts';
import type { WorkflowFunction } from './workflow-function.ts';

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
 * import { workflow, WorkflowBuilderError } from 'weft';
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
 * `inputSchema`, `outputSchema`, `migrate`, `constraints`) are passed through
 * onto the returned {@link BuiltWorkflowDefinition} when `.execute(fn)` runs.
 * Only `name` is required.
 *
 * @example
 * ```ts
 * import { workflow, type WorkflowBuilderOptions } from 'weft';
 *
 * const options: WorkflowBuilderOptions<'welcome'> = {
 *   name: 'welcome',
 *   description: 'Greets a new user.',
 * };
 * const welcome = workflow(options).execute(async function* () { return 'ok'; });
 * void welcome;
 * ```
 */
export interface WorkflowBuilderOptions<TName extends string = string> {
  name: TName;
  version?: string;
  description?: string;
  tags?: ReadonlyArray<string>;
  retention?: RetentionPolicy;
  constraints?: ConstraintDefinition[];
  migrate?: (checkpoint: unknown, fromVersion: string) => unknown;
  inputSchema?: DefinitionSchema<unknown, unknown>;
  outputSchema?: DefinitionSchema<unknown, unknown>;
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

type ChainMethodName = 'activities' | 'signals' | 'updates' | 'queries' | 'searchAttributes';

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
    signals: false,
    updates: false,
    queries: false,
    searchAttributes: false,
  };
  #executed = false;
  #activities: Record<string, ActivityDefinition> = {};
  #signals: Record<string, SignalDefinition<unknown>> = {};
  #updates: Record<string, UpdateDefinition> = {};
  #queries: Record<string, QueryDefinition> = {};
  #searchAttributes: SearchAttributeSchema = {};

  constructor(options: WorkflowBuilderOptions<TName>) {
    this.#options = options;
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
    this.#activities = normalizeActivityMap(map);
    return this;
  };

  signals = (map: SignalMap): this => {
    this.#assertOpen('signals');
    this.#markCalled('signals');
    this.#signals = { ...(map as Record<string, SignalDefinition<unknown>>) };
    return this;
  };

  updates = (map: UpdateMap): this => {
    this.#assertOpen('updates');
    this.#markCalled('updates');
    this.#updates = { ...(map as Record<string, UpdateDefinition>) };
    return this;
  };

  queries = (map: QueryMap): this => {
    this.#assertOpen('queries');
    this.#markCalled('queries');
    this.#queries = { ...(map as Record<string, QueryDefinition>) };
    return this;
  };

  searchAttributes = (schema: SearchAttributeSchema): this => {
    this.#assertOpen('searchAttributes');
    this.#markCalled('searchAttributes');
    this.#searchAttributes = { ...schema };
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
    this.#executed = true;

    // Deep-clone-and-freeze every nested definition. We do this against the
    // private maps before publishing the immutable view so any post-build
    // mutation of the *original* user-supplied references cannot reach the
    // engine's per-workflow registry.
    const frozenActivities = freezeRecord(this.#activities);
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
      ...(this.#options.constraints !== undefined
        ? { constraints: this.#options.constraints }
        : {}),
      ...(this.#options.migrate !== undefined ? { migrate: this.#options.migrate } : {}),
      ...(this.#options.inputSchema !== undefined
        ? { inputSchema: this.#options.inputSchema }
        : {}),
      ...(this.#options.outputSchema !== undefined
        ? { outputSchema: this.#options.outputSchema }
        : {}),
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
  const out: Record<string, T> = {};
  for (const key of Object.keys(map)) {
    out[key] = deepFreeze(clonePlain(map[key])) as T;
  }
  return Object.freeze(out);
}

function isFunction(value: unknown): value is (...arguments_: unknown[]) => unknown {
  return typeof value === 'function';
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
  const out: Record<string, ActivityDefinition> = {};
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
