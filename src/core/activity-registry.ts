/**
 * WeakMap-backed activity registry.
 *
 * Metadata is keyed to function references in a WeakMap so that lookup by
 * function reference is O(1). A separate name index (plain Map) holds strong
 * references to registered functions, keeping them alive until explicitly
 * unregistered. When a function is unregistered, removing it from the name
 * index releases the strong reference and allows the WeakMap entry to be
 * collected.
 *
 * @module core/activity-registry
 */

import {
  validateDefinitionSchemaMetadata,
  type DefinitionSchema,
  type Duration,
  type RetryPolicy,
} from './types.ts';
import { validateWorkflowOrActivityName } from './types/name-grammar.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Metadata stored per-activity, keyed to the function reference in a WeakMap.
 *
 * @example
 * ```ts
 * import { ActivityRegistry, type ActivityMetadata } from '@lostgradient/weft';
 *
 * const registry = new ActivityRegistry();
 * const fn = async (input: unknown) => ({ result: input });
 * registry.register('processOrder', fn, { queue: 'orders', timeout: '30s' });
 *
 * const meta: ActivityMetadata | undefined = registry.getMetadata(fn);
 * console.log(meta?.name);   // 'processOrder'
 * console.log(meta?.queue);  // 'orders'
 * ```
 */
export interface ActivityMetadata {
  /** Registered activity name. */
  name: string;
  /** Queue used for activity dispatch. */
  queue: string;
  /** User-facing description for catalog, code generation, and tool surfaces. */
  description?: string;
  /** User-facing grouping tags for catalog and documentation surfaces. */
  tags?: ReadonlyArray<string>;
  /** Optional input schema metadata for introspection; core execution does not validate input against it. */
  inputSchema?: DefinitionSchema;
  /** Optional output schema metadata for introspection; core execution does not validate output against it. */
  outputSchema?: DefinitionSchema;
  /** Retry policy used when the activity fails. */
  retry?: RetryPolicy;
  /** Activity execution timeout. */
  timeout?: Duration;
  /** Whether the activity can be safely repeated. */
  idempotent?: boolean;
}

/**
 * Optional overrides when registering an activity.
 *
 * @example
 * ```ts
 * import { ActivityRegistry, type ActivityRegistrationOptions } from '@lostgradient/weft';
 *
 * const options: ActivityRegistrationOptions = {
 *   queue: 'high-priority',
 *   timeout: '60s',
 *   idempotent: true,
 * };
 *
 * const registry = new ActivityRegistry();
 * const fn = async (input: unknown) => input;
 * registry.register('sendNotification', fn, options);
 * ```
 */
export interface ActivityRegistrationOptions {
  /** Queue used for activity dispatch. */
  queue?: string;
  /** User-facing description for catalog, code generation, and tool surfaces. */
  description?: string;
  /** User-facing grouping tags for catalog and documentation surfaces. */
  tags?: ReadonlyArray<string>;
  /** Optional input schema metadata for introspection; registration validates metadata shape only. */
  inputSchema?: DefinitionSchema;
  /** Optional output schema metadata for introspection; registration validates metadata shape only. */
  outputSchema?: DefinitionSchema;
  /** Retry policy used when the activity fails. */
  retry?: RetryPolicy;
  /** Activity execution timeout. */
  timeout?: Duration;
  /** Whether the activity can be safely repeated. */
  idempotent?: boolean;
}

export type RegisteredActivityFunction = (input?: unknown, context?: unknown) => unknown;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect whether `fn` carries colocated metadata from the `activity()` helper.
 * The helper assigns `name`, `execute`, and optional catalog and dispatch
 * metadata as own properties on the returned function.
 */
function extractDefinitionMetadata(name: string, fn: object): Partial<ActivityRegistrationOptions> {
  const record = fn as Record<string, unknown>;

  return {
    ...extractCatalogMetadata(record),
    ...extractSchemaMetadata(name, record),
    ...extractDispatchMetadata(record),
  };
}

function extractCatalogMetadata(
  record: Record<string, unknown>,
): Pick<ActivityRegistrationOptions, 'description' | 'tags'> {
  return {
    ...(typeof record['description'] === 'string' ? { description: record['description'] } : {}),
    ...(Array.isArray(record['tags']) && record['tags'].every((tag) => typeof tag === 'string')
      ? { tags: [...record['tags']] }
      : {}),
  };
}

function extractSchemaMetadata(
  name: string,
  record: Record<string, unknown>,
): Pick<ActivityRegistrationOptions, 'inputSchema' | 'outputSchema'> {
  return {
    ...('inputSchema' in record
      ? {
          inputSchema: validateDefinitionSchemaMetadata(
            record['inputSchema'],
            `activity definition "${name}".inputSchema`,
          ),
        }
      : {}),
    ...('outputSchema' in record
      ? {
          outputSchema: validateDefinitionSchemaMetadata(
            record['outputSchema'],
            `activity definition "${name}".outputSchema`,
          ),
        }
      : {}),
  };
}

function extractDispatchMetadata(
  record: Record<string, unknown>,
): Pick<ActivityRegistrationOptions, 'queue' | 'retry' | 'timeout' | 'idempotent'> {
  return {
    ...(typeof record['queue'] === 'string' ? { queue: record['queue'] } : {}),
    ...(isRetryPolicyCandidate(record['retry']) ? { retry: record['retry'] } : {}),
    ...(typeof record['timeout'] === 'string' || typeof record['timeout'] === 'number'
      ? { timeout: record['timeout'] }
      : {}),
    ...(typeof record['idempotent'] === 'boolean' ? { idempotent: record['idempotent'] } : {}),
  };
}

function isRetryPolicyCandidate(value: unknown): value is RetryPolicy {
  return typeof value === 'object' && value !== null;
}

export function copyActivityMetadata(metadata: ActivityMetadata): ActivityMetadata {
  return {
    name: metadata.name,
    queue: metadata.queue,
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    ...(metadata.tags === undefined ? {} : { tags: [...metadata.tags] }),
    ...(metadata.inputSchema === undefined ? {} : { inputSchema: metadata.inputSchema }),
    ...(metadata.outputSchema === undefined ? {} : { outputSchema: metadata.outputSchema }),
    ...(metadata.retry === undefined ? {} : { retry: copyRetryPolicy(metadata.retry) }),
    ...(metadata.timeout === undefined ? {} : { timeout: metadata.timeout }),
    ...(metadata.idempotent === undefined ? {} : { idempotent: metadata.idempotent }),
  };
}

function copyRetryPolicy(retry: RetryPolicy): RetryPolicy {
  return {
    ...retry,
    ...(retry.nonRetryableErrors === undefined
      ? {}
      : { nonRetryableErrors: [...retry.nonRetryableErrors] }),
  };
}

function resolveSchemaMetadata(
  name: string,
  extracted: Partial<ActivityRegistrationOptions>,
  options: ActivityRegistrationOptions | undefined,
): Pick<Partial<ActivityMetadata>, 'inputSchema' | 'outputSchema'> {
  const inputSchema =
    options?.inputSchema === undefined
      ? extracted.inputSchema
      : validateDefinitionSchemaMetadata(
          options.inputSchema,
          `activity registration "${name}".inputSchema`,
        );
  const outputSchema =
    options?.outputSchema === undefined
      ? extracted.outputSchema
      : validateDefinitionSchemaMetadata(
          options.outputSchema,
          `activity registration "${name}".outputSchema`,
        );

  return {
    ...(inputSchema === undefined ? {} : { inputSchema }),
    ...(outputSchema === undefined ? {} : { outputSchema }),
  };
}

function preferOptionValue<Value>(
  optionValue: Value | undefined,
  extractedValue: Value | undefined,
): Value | undefined {
  return optionValue ?? extractedValue;
}

function applyOptionalActivityMetadata(
  metadata: ActivityMetadata,
  values: Omit<Partial<ActivityMetadata>, 'name' | 'queue'>,
): void {
  if (values.description !== undefined) metadata.description = values.description;
  if (values.tags !== undefined) metadata.tags = [...values.tags];
  if (values.inputSchema !== undefined) metadata.inputSchema = values.inputSchema;
  if (values.outputSchema !== undefined) metadata.outputSchema = values.outputSchema;
  if (values.retry !== undefined) metadata.retry = copyRetryPolicy(values.retry);
  if (values.timeout !== undefined) metadata.timeout = values.timeout;
  if (values.idempotent !== undefined) metadata.idempotent = values.idempotent;
}

function assignOptionalActivityMetadataValue<
  Key extends keyof Omit<ActivityMetadata, 'name' | 'queue'>,
>(
  metadata: Omit<Partial<ActivityMetadata>, 'name' | 'queue'>,
  key: Key,
  value: ActivityMetadata[Key] | undefined,
): void {
  if (value !== undefined) {
    metadata[key] = value;
  }
}

function buildOptionalActivityMetadata(
  name: string,
  extracted: Partial<ActivityRegistrationOptions>,
  options: ActivityRegistrationOptions | undefined,
): Omit<Partial<ActivityMetadata>, 'name' | 'queue'> {
  const optionalMetadata: Omit<Partial<ActivityMetadata>, 'name' | 'queue'> = {
    ...resolveSchemaMetadata(name, extracted, options),
  };

  assignOptionalActivityMetadataValue(
    optionalMetadata,
    'description',
    preferOptionValue(options?.description, extracted.description),
  );
  assignOptionalActivityMetadataValue(
    optionalMetadata,
    'tags',
    preferOptionValue(options?.tags, extracted.tags),
  );
  assignOptionalActivityMetadataValue(
    optionalMetadata,
    'retry',
    preferOptionValue(options?.retry, extracted.retry),
  );
  assignOptionalActivityMetadataValue(
    optionalMetadata,
    'timeout',
    preferOptionValue(options?.timeout, extracted.timeout),
  );
  assignOptionalActivityMetadataValue(
    optionalMetadata,
    'idempotent',
    preferOptionValue(options?.idempotent, extracted.idempotent),
  );

  return optionalMetadata;
}

function buildActivityMetadata(
  name: string,
  extracted: Partial<ActivityRegistrationOptions>,
  options: ActivityRegistrationOptions | undefined,
): ActivityMetadata {
  const metadata: ActivityMetadata = {
    name,
    queue: preferOptionValue(options?.queue, extracted.queue) ?? 'default',
  };
  applyOptionalActivityMetadata(metadata, buildOptionalActivityMetadata(name, extracted, options));

  return metadata;
}

// ---------------------------------------------------------------------------
// ActivityRegistry
// ---------------------------------------------------------------------------

/**
 * WeakMap-backed registry mapping activity names to their execute functions
 * and metadata. Used internally by the {@link Engine} to dispatch activities
 * by name. Call `engine.register(activityDefinition)` rather than
 * constructing an `ActivityRegistry` directly — the engine manages the
 * registry lifecycle.
 *
 * @example
 * ```ts
 * import { ActivityRegistry } from '@lostgradient/weft';
 *
 * const registry = new ActivityRegistry();
 * const fn = async (input: unknown) => ({ result: input });
 * registry.register('processOrder', fn, { queue: 'orders', timeout: '30s' });
 *
 * const meta = registry.getMetadata(fn);
 * console.log(meta?.name);   // 'processOrder'
 * console.log(meta?.queue);  // 'orders'
 * ```
 */
export class ActivityRegistry {
  /** Metadata keyed to the activity function object. */
  #metadata: WeakMap<object, ActivityMetadata>;

  /** Per-name metadata used by deterministic catalog introspection. */
  #definitions: Map<string, ActivityMetadata>;

  /**
   * Name → function lookup. Holds strong references to registered functions,
   * keeping them (and their WeakMap metadata) alive until explicitly
   * unregistered.
   */
  #nameIndex: Map<string, object>;

  constructor() {
    this.#metadata = new WeakMap();
    this.#definitions = new Map();
    this.#nameIndex = new Map();
  }

  #retargetFunctionMetadata(fn: object, excludingName?: string): void {
    let replacementMetadata: ActivityMetadata | undefined;
    for (const [registeredName, registeredFn] of this.#nameIndex) {
      if (registeredName !== excludingName && registeredFn === fn) {
        replacementMetadata = this.#definitions.get(registeredName);
      }
    }

    if (replacementMetadata === undefined) {
      this.#metadata.delete(fn);
    } else {
      this.#metadata.set(fn, replacementMetadata);
    }
  }

  /**
   * Register an activity function with associated metadata.
   *
   * If `fn` was created via the `activity()` helper, metadata is
   * auto-extracted from its colocated properties. Explicit `options`
   * take precedence over auto-extracted values.
   */
  register(name: string, fn: Function, options?: ActivityRegistrationOptions): void {
    validateWorkflowOrActivityName(name, 'activity');
    // Keep function-reference metadata aligned when this name moves to a
    // different function. Aliased functions retarget to a remaining name;
    // unaliased functions leave the WeakMap.
    const existingFn = this.#nameIndex.get(name);
    if (existingFn && existingFn !== fn) {
      this.#retargetFunctionMetadata(existingFn, name);
    }

    const extracted = extractDefinitionMetadata(name, fn);
    const metadata = buildActivityMetadata(name, extracted, options);

    this.#metadata.set(fn, metadata);
    this.#definitions.set(name, metadata);
    this.#nameIndex.set(name, fn);
  }

  /** Check whether an activity is registered under the given name. */
  has(name: string): boolean {
    return this.#nameIndex.has(name);
  }

  /** Resolve a function by its registered name. Returns `undefined` if not found. */
  resolve(name: string): RegisteredActivityFunction | undefined {
    const fn = this.#nameIndex.get(name);
    if (!fn) return undefined;
    return fn as RegisteredActivityFunction;
  }

  /** Get metadata for a function reference. Returns `undefined` if the function was never registered. */
  getMetadata(fn: Function): ActivityMetadata | undefined {
    const metadata = this.#metadata.get(fn);
    return metadata === undefined ? undefined : copyActivityMetadata(metadata);
  }

  /** Get metadata by registered activity name. */
  getMetadataByName(name: string): ActivityMetadata | undefined {
    return this.getDefinition(name);
  }

  /** Get catalog metadata for a registered activity name. */
  getDefinition(name: string): ActivityMetadata | undefined {
    const metadata = this.#definitions.get(name);
    return metadata === undefined ? undefined : copyActivityMetadata(metadata);
  }

  /** List catalog metadata for all registered activity names. */
  listDefinitions(): ActivityMetadata[] {
    return [...this.#nameIndex.keys()].flatMap((name) => {
      const metadata = this.getDefinition(name);
      return metadata === undefined ? [] : [metadata];
    });
  }

  /** Remove an activity registration by name. */
  unregister(name: string): void {
    const fn = this.#nameIndex.get(name);
    this.#nameIndex.delete(name);
    this.#definitions.delete(name);

    if (fn) {
      this.#retargetFunctionMetadata(fn);
    }
  }

  /** Iterate over all registered activity names. */
  *names(): IterableIterator<string> {
    yield* this.#nameIndex.keys();
  }
}
