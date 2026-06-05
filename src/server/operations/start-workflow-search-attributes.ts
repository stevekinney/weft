import { validateAttributeType } from '../../core/search-attributes.ts';
import { StartWorkflowValidationError } from '../../core/start-workflow-validation.ts';
import type { SearchAttributeSchema, SearchAttributeValue } from '../../core/types.ts';

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
