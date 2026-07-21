import { ActivityRegistry } from '../activity-registry.ts';
import { WorkflowDefinitionRegisteredEvent } from '../events.ts';
import {
  activity,
  validateDefinitionSchemaMetadata,
  type ActivityDefinition,
  type QueryDefinition,
  type SignalDefinition,
  type UpdateDefinition,
  type WorkflowConcurrencyOptions,
  type WorkflowDefinition,
} from '../types.ts';
import { clonePlain } from '../types/clone-plain.ts';
import { validateWorkflowOrActivityName } from '../types/name-grammar.ts';
import type { EngineInternals } from './internals.ts';
import { normalizeRetentionPolicy } from './validation.ts';

type RegistrationEntry =
  EngineInternals['registrations'] extends Map<string, infer Entry> ? Entry : never;

export type RegistrationCallbacks = {
  ensureRetentionSweepInterval: () => void;
  dispatchEvent: (event: Event) => void;
};

function copiedTags(tags: ReadonlyArray<string> | undefined): string[] | undefined {
  return tags === undefined ? undefined : [...tags];
}

function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  return typeof value === 'object' && value !== null && 'name' in value && 'handler' in value;
}

function assertConstraintsSupported(
  internals: EngineInternals,
  name: string,
  registration: WorkflowDefinition,
): void {
  if (!registration.constraints || registration.constraints.length === 0) {
    return;
  }
  // Constraints are only evaluated by the inline execution strategy —
  // `evaluateConstraints` reads per-workflow context via
  // `internals.inlineStrategy.getContext(...)`. In worker execution mode the
  // inline strategy is absent, so every constraint would be silently
  // skipped. Fail loud at registration time rather than swallowing the
  // invariant at runtime.
  if (internals.inlineStrategy === null) {
    throw new Error(
      `Cannot register workflow "${name}" with constraints: constraints are not supported in worker execution mode. ` +
        `The engine was constructed with \`workerExecution\`, which runs workflows in a Web Worker where the inline ` +
        `execution context required by constraint evaluation is unavailable. Remove the \`constraints\` option, or ` +
        `construct the engine without \`workerExecution\` to run workflows inline.`,
    );
  }
}

function buildBaseRegistrationEntry(
  name: string,
  registration: WorkflowDefinition,
): RegistrationEntry {
  const tags = copiedTags(registration.tags);
  const normalizedRetention = normalizeRetentionPolicy(
    registration.retention,
    `registration("${name}").retention`,
  );
  return {
    handler: registration.handler,
    version: registration.version ?? '1',
    ...(registration.description === undefined ? {} : { description: registration.description }),
    ...(tags === undefined ? {} : { tags }),
    ...(registration.inputSchema === undefined
      ? {}
      : {
          inputSchema: validateDefinitionSchemaMetadata(
            registration.inputSchema,
            `registration("${name}").inputSchema`,
          ),
        }),
    ...(registration.outputSchema === undefined
      ? {}
      : {
          outputSchema: validateDefinitionSchemaMetadata(
            registration.outputSchema,
            `registration("${name}").outputSchema`,
          ),
        }),
    ...(normalizedRetention !== null && { retention: normalizedRetention }),
    ...(registration.concurrency !== undefined
      ? {
          concurrency: normalizeWorkflowConcurrencyOptions(
            registration.concurrency,
            `registration("${name}").concurrency`,
          ),
        }
      : {}),
  };
}

function normalizeWorkflowConcurrencyOptions(
  concurrency: WorkflowConcurrencyOptions,
  fieldName: string,
): WorkflowConcurrencyOptions {
  if (!Number.isInteger(concurrency.max) || concurrency.max < 1) {
    throw new RangeError(`${fieldName}.max must be a positive integer`);
  }
  if (concurrency.key !== undefined && typeof concurrency.key !== 'function') {
    throw new TypeError(`${fieldName}.key must be a function when provided`);
  }
  return Object.freeze({
    max: concurrency.max,
    ...(concurrency.key === undefined ? {} : { key: concurrency.key }),
  });
}

function applyOptionalRegistrationFields(
  entry: RegistrationEntry,
  registration: WorkflowDefinition,
): void {
  if (registration.searchAttributes && Object.keys(registration.searchAttributes).length > 0) {
    entry.searchAttributes = registration.searchAttributes;
  }
  if (registration.constraints && registration.constraints.length > 0) {
    entry.constraints = registration.constraints;
  }
  if (registration.finalizer !== undefined) {
    // Stored as-declared. The teardown drive (#446 Phase 2) resolves it from this
    // entry by the workflow's durable `state.type` and narrows it to the
    // structural `RunnableFinalizer` it invokes — see `runWorkflowFinalizer`.
    // Finalizers are host-side trusted activity code. workflowExecutionMode:'worker'
    // isolates only the workflow generator; the finalizer always runs on the engine
    // host via runFinalizerActivity (see #564).
    entry.finalizer = registration.finalizer;
  }
}

function buildRegistrationEntry(name: string, registration: WorkflowDefinition): RegistrationEntry {
  const entry = buildBaseRegistrationEntry(name, registration);
  applyOptionalRegistrationFields(entry, registration);
  if (isBuilderWorkflowDefinition(registration)) {
    entry.signals = registration.signals;
    entry.updates = registration.updates;
    entry.queries = registration.queries;
  }
  return entry;
}

function commitWorkflowDefinition(
  internals: EngineInternals,
  definition: WorkflowDefinition,
  callbacks: RegistrationCallbacks,
): void {
  const name = definition.name;
  validateWorkflowOrActivityName(name, 'workflow');
  assertConstraintsSupported(internals, name, definition);
  const entry = buildRegistrationEntry(name, definition);
  internals.registrations.set(name, entry);
  callbacks.ensureRetentionSweepInterval();
  internals.workflowTypesByHandler.set(definition.handler, name);
  callbacks.dispatchEvent(new WorkflowDefinitionRegisteredEvent(name));
}

/**
 * Heuristic detector for `BuiltWorkflowDefinition` — the runtime shape returned
 * by `workflow({ name }).execute(...)`. We test for the per-message-kind maps
 * the builder writes (`activities`, `signals`, `updates`, `queries`,
 * `searchAttributes`) directly on the definition. We do not import the
 * type from `workflow-builder.ts` to avoid a cycle with the engine package;
 * the runtime check is sufficient because the builder is the only producer of
 * objects with all five fields as plain `Readonly<Record<string, ...>>`.
 */
function hasNonNullObjectField(value: object, key: string): boolean {
  if (!(key in value)) return false;
  const fieldValue = (value as { [k: string]: unknown })[key];
  return typeof fieldValue === 'object' && fieldValue !== null;
}

function isBuilderWorkflowDefinition(value: unknown): value is WorkflowDefinition & {
  readonly activities: Readonly<Record<string, Readonly<ActivityDefinition>>>;
  readonly signals: Readonly<Record<string, Readonly<SignalDefinition<unknown>>>>;
  readonly updates: Readonly<Record<string, Readonly<UpdateDefinition<unknown>>>>;
  readonly queries: Readonly<Record<string, Readonly<QueryDefinition<unknown>>>>;
  readonly searchAttributes: Readonly<Record<string, unknown>>;
} {
  if (!isWorkflowDefinition(value)) return false;
  return (
    hasNonNullObjectField(value, 'activities') &&
    hasNonNullObjectField(value, 'signals') &&
    hasNonNullObjectField(value, 'updates') &&
    hasNonNullObjectField(value, 'queries') &&
    hasNonNullObjectField(value, 'searchAttributes')
  );
}

// `clonePlain` is imported from `../types/clone-plain.ts` — see the import at
// the top of this file. The engine's defensive deep clone of activity option
// subtrees uses the same helper as the builder.

/**
 * Build a fresh per-workflow {@link ActivityRegistry} from a builder workflow's
 * activities map. Each entry is defensively deep-cloned and then turned into a
 * fresh `ActivityCallable` via {@link activity}, so the engine's registry holds
 * its own callable references and the user's `BuiltWorkflowDefinition` cannot
 * influence dispatch by post-registration mutation.
 */
function buildPerWorkflowActivityRegistry(
  activities: Readonly<Record<string, Readonly<ActivityDefinition>>>,
): ActivityRegistry {
  const registry = new ActivityRegistry();
  for (const definition of Object.values(activities)) {
    const clonedDefinition = clonePlain(definition);
    // Re-running `activity(...)` rebuilds the callable, validates the name
    // against the wire-safe grammar, and freezes the colocated metadata
    // independently from the user's frozen input. The resulting object is the
    // canonical entry stored in the per-workflow registry.
    const callable = activity(clonedDefinition);
    registry.register(callable.name, callable);
  }
  return registry;
}

/**
 * Apply the runtime collision rule for `engine.register(workflow)`. Same
 * `WorkflowDefinition` object reference re-registered is a no-op (idempotent
 * return value `true`). Same-name-but-different-object throws. Same-reference
 * detection uses identity equality (`===`); deep equality is intentionally not
 * considered because the builder freezes the returned definition, so two
 * builder outputs are only equal by reference.
 */
/**
 * Read-only collision check. Returns whether the registration is a no-op
 * (same reference), throws on name-already-registered-with-different-ref, or
 * returns "register" when the name is new. Callers are responsible for the
 * actual `set` once subsequent registration steps succeed — splitting check
 * from commit ensures a mid-registration failure cannot leave an orphan
 * entry in `workflowDefinitionsByName` that would make later retries falsely
 * report idempotency.
 */
function checkWorkflowCollision(
  internals: EngineInternals,
  name: string,
  definition: object,
): { kind: 'idempotent' } | { kind: 'register' } {
  const existing = internals.workflowDefinitionsByName.get(name);
  if (existing === undefined) {
    return { kind: 'register' };
  }
  if (existing === definition) {
    return { kind: 'idempotent' };
  }
  throw new Error(`Workflow "${name}" is already registered with a different definition`);
}

export function register(
  internals: EngineInternals,
  definition: unknown,
  callbacks: RegistrationCallbacks,
): void {
  if (!isWorkflowDefinition(definition)) {
    throw new TypeError(
      'engine.register() expects a WorkflowDefinition (produced by `workflow({ name }).execute(fn)`) or an ActivityDefinition.',
    );
  }
  if (isBuilderWorkflowDefinition(definition)) {
    const decision = checkWorkflowCollision(internals, definition.name, definition);
    if (decision.kind === 'idempotent') return;
    // Build the per-workflow ActivityRegistry before any commits so an
    // activity-metadata failure leaves zero state behind. Commit both maps
    // (workflowDefinitionsByName + activityRegistriesByWorkflow) together
    // after every fallible step has succeeded — if `commitWorkflowDefinition`
    // throws below, neither commit happens and a retry sees the workflow as
    // still unregistered.
    const perWorkflowRegistry = buildPerWorkflowActivityRegistry(definition.activities);
    commitWorkflowDefinition(internals, definition, callbacks);
    internals.workflowDefinitionsByName.set(definition.name, definition);
    internals.activityRegistriesByWorkflow.set(definition.name, perWorkflowRegistry);
    return;
  }
  // Plain `WorkflowDefinition` (the runtime shape returned by the builder
  // before `.activities()` / `.signals()` / etc. populate the per-workflow
  // maps). The builder always populates those maps to empty objects, so this
  // branch only fires for hand-rolled `WorkflowDefinition` literals — which
  // are still valid because the public type is structural.
  commitWorkflowDefinition(internals, definition, callbacks);
}

export function resolveWorkflowTypeTarget(
  internals: EngineInternals,
  target: string | Function,
  _callbacks: RegistrationCallbacks,
): string {
  if (typeof target === 'string') {
    return target;
  }

  const registeredType = internals.workflowTypesByHandler.get(target);
  if (registeredType) {
    return registeredType;
  }

  throw new Error(
    'Workflow functions used in composition operators must be registered before use. ' +
      'Pass the registered workflow type string or register the function on the engine first.',
  );
}
