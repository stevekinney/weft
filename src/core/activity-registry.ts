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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Metadata stored per-activity, keyed to the function reference in a WeakMap.
 *
 * @example
 * ```ts
 * import { ActivityRegistry, type ActivityMetadata } from 'weft';
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
 * import { ActivityRegistry, type ActivityRegistrationOptions } from 'weft';
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
// oxlint-disable-next-line complexity -- ID:core-activity-registry-extract-definition-metadata-complexity
function extractDefinitionMetadata(name: string, fn: object): Partial<ActivityRegistrationOptions> {
  const result: Partial<ActivityRegistrationOptions> = {};
  const record = fn as Record<string, unknown>;

  if ('description' in fn && typeof record['description'] === 'string') {
    result.description = record['description'];
  }
  if (
    'tags' in fn &&
    Array.isArray(record['tags']) &&
    record['tags'].every((tag) => typeof tag === 'string')
  ) {
    result.tags = [...record['tags']];
  }
  if ('inputSchema' in fn) {
    result.inputSchema = validateDefinitionSchemaMetadata(
      record['inputSchema'],
      `activity definition "${name}".inputSchema`,
    );
  }
  if ('outputSchema' in fn) {
    result.outputSchema = validateDefinitionSchemaMetadata(
      record['outputSchema'],
      `activity definition "${name}".outputSchema`,
    );
  }
  if ('queue' in fn && typeof record['queue'] === 'string') {
    result.queue = record['queue'];
  }
  if ('retry' in fn && typeof record['retry'] === 'object' && record['retry'] !== null) {
    result.retry = record['retry'] as RetryPolicy;
  }
  if (
    'timeout' in fn &&
    (typeof record['timeout'] === 'string' || typeof record['timeout'] === 'number')
  ) {
    result.timeout = record['timeout'];
  }
  if ('idempotent' in fn && typeof record['idempotent'] === 'boolean') {
    result.idempotent = record['idempotent'];
  }

  return result;
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
 * import { ActivityRegistry } from 'weft';
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
  // oxlint-disable-next-line complexity -- ID:core-activity-registry-constructor-complexity
  register(name: string, fn: Function, options?: ActivityRegistrationOptions): void {
    // Keep function-reference metadata aligned when this name moves to a
    // different function. Aliased functions retarget to a remaining name;
    // unaliased functions leave the WeakMap.
    const existingFn = this.#nameIndex.get(name);
    if (existingFn && existingFn !== fn) {
      this.#retargetFunctionMetadata(existingFn, name);
    }

    const extracted = extractDefinitionMetadata(name, fn);

    const metadata: ActivityMetadata = {
      name,
      queue: options?.queue ?? extracted.queue ?? 'default',
    };

    const description = options?.description ?? extracted.description;
    if (description !== undefined) metadata.description = description;

    const tags = options?.tags ?? extracted.tags;
    if (tags !== undefined) metadata.tags = [...tags];

    const inputSchema =
      options?.inputSchema === undefined
        ? extracted.inputSchema
        : validateDefinitionSchemaMetadata(
            options.inputSchema,
            `activity registration "${name}".inputSchema`,
          );
    if (inputSchema !== undefined) metadata.inputSchema = inputSchema;

    const outputSchema =
      options?.outputSchema === undefined
        ? extracted.outputSchema
        : validateDefinitionSchemaMetadata(
            options.outputSchema,
            `activity registration "${name}".outputSchema`,
          );
    if (outputSchema !== undefined) metadata.outputSchema = outputSchema;

    const retry = options?.retry ?? extracted.retry;
    if (retry !== undefined) metadata.retry = copyRetryPolicy(retry);

    const timeout = options?.timeout ?? extracted.timeout;
    if (timeout !== undefined) metadata.timeout = timeout;

    const idempotent = options?.idempotent ?? extracted.idempotent;
    if (idempotent !== undefined) metadata.idempotent = idempotent;

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
