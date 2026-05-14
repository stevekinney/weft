import type {
  DefinitionSchema,
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1PathSegment,
} from './definition-schema.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Single normalized validation issue with an RFC 6901 JSON Pointer path.
 *
 * @example
 * ```ts
 * import type { ValidationIssue } from 'weft/json-schema';
 *
 * const issue: ValidationIssue = { message: 'Expected a string.', path: '/email' };
 * void issue;
 * ```
 */
export interface ValidationIssue {
  readonly message: string;
  readonly path: string;
}

/**
 * Context fields attached to a {@link StandardSchemaValidationError}, used by
 * boundary code to translate the runtime-neutral error into transport-specific
 * fault payloads.
 *
 * @example
 * ```ts
 * import type { StandardSchemaValidationContext } from 'weft/json-schema';
 *
 * const context: StandardSchemaValidationContext = {
 *   fieldName: 'input',
 *   operation: 'weft.workflows.start',
 * };
 * void context;
 * ```
 */
export interface StandardSchemaValidationContext {
  readonly fieldName: string;
  readonly operation?: string;
}

/**
 * Error thrown by {@link validateStandardSchema} when a Standard Schema
 * validator rejects an input. Carries the originating field name, optional
 * operation identifier, and the list of issues with RFC 6901 JSON Pointer
 * paths so transport code can translate it into the right fault shape.
 *
 * **Reserved for boundary integration.** Nothing in the engine calls
 * {@link validateStandardSchema} yet; the runtime validator is exported here
 * so transport-operation modules and worker dispatch paths can wire it in
 * during a follow-up. Definition helpers carry schemas as inert metadata
 * today.
 *
 * @example
 * ```ts
 * import { StandardSchemaValidationError } from 'weft/json-schema';
 *
 * const error = new StandardSchemaValidationError({
 *   fieldName: 'input',
 *   operation: 'weft.workflows.start',
 *   issues: [{ message: 'Expected a string.', path: '/email' }],
 * });
 * void error;
 * ```
 */
export class StandardSchemaValidationError extends Error {
  readonly fieldName: string;
  readonly operation: string | undefined;
  readonly issues: ReadonlyArray<ValidationIssue>;

  constructor(parameters: {
    fieldName: string;
    operation: string | undefined;
    issues: ReadonlyArray<ValidationIssue>;
  }) {
    super(buildErrorMessage(parameters.fieldName, parameters.operation, parameters.issues));
    this.name = 'StandardSchemaValidationError';
    this.fieldName = parameters.fieldName;
    this.operation = parameters.operation;
    this.issues = parameters.issues;
  }
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Validate an unknown input against a {@link DefinitionSchema} that carries a
 * Standard Schema validator under `~standard`. Awaits async validators. On
 * success returns the validated value. On failure throws a
 * {@link StandardSchemaValidationError} whose issue paths are RFC 6901 JSON
 * Pointers. Throws a {@link TypeError} when the schema only carries a JSON
 * Schema converter (no runtime validator).
 *
 * **Reserved for boundary integration.** This helper is exported for use by
 * transport-operation modules and worker-side activity dispatch paths during
 * boundary validation work. Nothing in the engine calls it today; the
 * definition helpers' schemas are inert metadata until that wiring lands.
 *
 * @example
 * ```ts
 * import { validateStandardSchema } from 'weft/json-schema';
 * import { z } from 'zod';
 *
 * const schema = z.object({ email: z.string().email() });
 * const valid = await validateStandardSchema(schema, { email: 'a@b.co' }, {
 *   fieldName: 'input',
 * });
 * void valid;
 * ```
 */
export async function validateStandardSchema<Output>(
  schema: DefinitionSchema<unknown, Output>,
  input: unknown,
  context: StandardSchemaValidationContext,
): Promise<Output> {
  const standardProperties = schema['~standard'];
  if (!hasValidator(standardProperties)) {
    throw new TypeError(
      `Schema for ${context.fieldName} does not provide runtime validation. ` +
        `Attach a Standard Schema validator (Zod, Valibot, or another vendor) ` +
        `or supply a runtime-validating schema at this boundary.`,
    );
  }

  const result = await standardProperties.validate(input);

  if (result.issues === undefined) {
    return result.value;
  }

  throw new StandardSchemaValidationError({
    fieldName: context.fieldName,
    operation: context.operation,
    issues: result.issues.map(toValidationIssue),
  });
}

/**
 * Format an array of {@link ValidationIssue} values as a single
 * newline-separated string. Useful in tests and developer logs.
 *
 * @example
 * ```ts
 * import { formatStandardSchemaIssues } from 'weft/json-schema';
 *
 * const formatted = formatStandardSchemaIssues([
 *   { message: 'Expected a string.', path: '/email' },
 * ]);
 * // "/email: Expected a string."
 * void formatted;
 * ```
 */
export function formatStandardSchemaIssues(issues: ReadonlyArray<ValidationIssue>): string {
  return issues
    .map((issue) => (issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`))
    .join('\n');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function hasValidator(
  properties: DefinitionSchema['~standard'],
): properties is StandardSchemaV1<unknown, unknown>['~standard'] {
  return typeof (properties as { validate?: unknown }).validate === 'function';
}

function toValidationIssue(issue: StandardSchemaV1Issue): ValidationIssue {
  return { message: issue.message, path: encodeJsonPointer(issue.path) };
}

function encodeJsonPointer(
  path: ReadonlyArray<PropertyKey | StandardSchemaV1PathSegment> | undefined,
): string {
  if (path === undefined || path.length === 0) return '';
  let pointer = '';
  for (const segment of path) {
    pointer += '/';
    pointer += encodeSegment(segment);
  }
  return pointer;
}

function encodeSegment(segment: PropertyKey | StandardSchemaV1PathSegment): string {
  const key = isPathSegment(segment) ? segment.key : segment;
  return escapeJsonPointerToken(String(key));
}

function isPathSegment(value: unknown): value is StandardSchemaV1PathSegment {
  return value !== null && typeof value === 'object' && 'key' in (value as Record<string, unknown>);
}

function escapeJsonPointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function buildErrorMessage(
  fieldName: string,
  operation: string | undefined,
  issues: ReadonlyArray<ValidationIssue>,
): string {
  const prefix = operation === undefined ? fieldName : `${operation} ${fieldName}`;
  return `Validation failed for ${prefix}:\n${formatStandardSchemaIssues(issues)}`;
}
