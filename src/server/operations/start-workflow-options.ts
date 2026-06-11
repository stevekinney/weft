import { validateAttributeType } from '../../core/search-attributes.ts';
import {
  assertExclusiveStartWorkflowOptions,
  coerceStartWorkflowDuration,
  coerceStartWorkflowId,
  coerceStartWorkflowIdempotencyKey,
  coerceStartWorkflowTags,
  coerceStartWorkflowTimestamp,
  StartWorkflowValidationError,
} from '../../core/start-workflow-validation.ts';
import type {
  SearchAttributeSchema,
  SearchAttributeValue,
  StartOptions,
} from '../../core/types.ts';

/**
 * The raw, transport-supplied start-option fields shared by `weft.workflows.start`
 * and `weft.workflows.startorsignal`. Each is `unknown` because validation happens
 * in {@link buildSharedStartWorkflowOptions}, not at the schema boundary, so both
 * surfaces hit one cross-transport error path.
 */
export type SharedStartWorkflowOptionInput = {
  id?: unknown;
  executionTimeout?: unknown;
  startAt?: unknown;
  startAfter?: unknown;
  tags?: unknown;
  idempotencyKey?: unknown;
  searchAttributes?: unknown;
};

/**
 * Coerce the shared start-option fields into a validated {@link StartOptions}.
 * Both start operations call this so they cannot drift in how they validate `id`,
 * `executionTimeout`, `startAt`/`startAfter`, `tags`, `idempotencyKey`, and
 * `searchAttributes` (a new field added here covers both surfaces at once). Throws
 * {@link StartWorkflowValidationError} on any malformed field.
 *
 * `onTerminalConflict` is intentionally NOT part of this shared path: it is an
 * in-process `engine.start`-only policy (its purge-and-restart would make the
 * transport `weft.workflows.start` operation conditionally destructive and would
 * violate `startOrSignal`'s at-most-once identity), so it is not exposed over
 * REST/JSON-RPC. See follow-up issue #489.
 */
export function buildSharedStartWorkflowOptions(
  input: SharedStartWorkflowOptionInput,
  searchAttributeSchema: SearchAttributeSchema | undefined,
): StartOptions {
  const options: StartOptions = {};

  if (input.id !== undefined) {
    options.id = coerceStartWorkflowId(input.id, 'Field "id"');
  }
  if (input.executionTimeout !== undefined) {
    options.executionTimeout = coerceStartWorkflowDuration(
      input.executionTimeout,
      'Field "executionTimeout"',
    );
  }
  if (input.startAt !== undefined) {
    options.startAt = coerceStartWorkflowTimestamp(input.startAt, 'Field "startAt"');
  }
  if (input.startAfter !== undefined) {
    options.startAfter = coerceStartWorkflowDuration(input.startAfter, 'Field "startAfter"');
  }
  if (input.tags !== undefined) {
    options.tags = coerceStartWorkflowTags(input.tags, 'Field "tags"');
  }
  if (input.idempotencyKey !== undefined) {
    options.idempotencyKey = coerceStartWorkflowIdempotencyKey(
      input.idempotencyKey,
      'Field "idempotencyKey"',
    );
  }
  if (input.searchAttributes !== undefined) {
    options.searchAttributes = coerceStartWorkflowSearchAttributes(
      input.searchAttributes,
      'Field "searchAttributes"',
      searchAttributeSchema,
    );
  }

  assertExclusiveStartWorkflowOptions(options.startAt, options.startAfter);

  return options;
}

/**
 * Coerce a transport-supplied `searchAttributes` object into validated
 * {@link SearchAttributeValue}s. Shared by `weft.workflows.start` and
 * `weft.workflows.startorsignal` so both apply the same null-prototype guard,
 * date-time normalization, schema-presence check, and type validation —
 * preventing the two start surfaces from drifting in how they accept attributes.
 */
export function coerceStartWorkflowSearchAttributes(
  value: unknown,
  fieldName: string,
  schema: SearchAttributeSchema | undefined,
): Record<string, SearchAttributeValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StartWorkflowValidationError(`${fieldName} must be an object`);
  }

  // Null-prototype record keeps untrusted attribute keys from touching Object.prototype setters.
  const attributes = Object.create(null) as Record<string, SearchAttributeValue>;
  for (const [key, attributeValue] of Object.entries(value)) {
    attributes[key] = coerceStartWorkflowSearchAttributeValue(
      key,
      attributeValue,
      fieldName,
      schema,
    );
  }

  return attributes;
}

function coerceStartWorkflowSearchAttributeValue(
  key: string,
  value: unknown,
  fieldName: string,
  schema: SearchAttributeSchema | undefined,
): SearchAttributeValue {
  if (!isSearchAttributeValue(value)) {
    throw new StartWorkflowValidationError(
      `${fieldName}.${key} must be a string, number, boolean, Date, or string array`,
    );
  }

  if (schema === undefined) {
    return value;
  }

  const definition = schema[key];
  if (definition === undefined) {
    throw new StartWorkflowValidationError(
      `Unknown search attribute "${key}". Registered attributes: ${Object.keys(schema).join(', ')}`,
    );
  }

  const normalizedValue =
    definition.type === 'string' && definition.format === 'date-time' && typeof value === 'string'
      ? coerceDateTimeSearchAttribute(key, value, fieldName)
      : value;

  try {
    validateAttributeType(key, normalizedValue, definition);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StartWorkflowValidationError(message);
  }

  return normalizedValue;
}

function coerceDateTimeSearchAttribute(key: string, value: string, fieldName: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new StartWorkflowValidationError(`${fieldName}.${key} must be a valid date-time string`);
  }
  return date;
}

function isSearchAttributeValue(value: unknown): value is SearchAttributeValue {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Date ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  );
}
