/**
 * Standard Schema and JSON Schema helper types for Weft definition metadata.
 *
 * @module json-schema
 */

import { definitionSchemaToJsonSchema } from './core/types/definition-schema-to-json.ts';
import {
  StandardSchemaValidationError,
  formatStandardSchemaIssues,
  validateStandardSchema,
} from './core/types/standard-schema-validate.ts';

export type { DefinitionSchemaDirection } from './core/types/definition-schema-to-json.ts';
export type {
  DefinitionSchema,
  InferSchemaOutput,
  StandardJSONSchemaV1,
  StandardJSONSchemaV1Converter,
  StandardJSONSchemaV1Options,
  StandardJSONSchemaV1Properties,
  StandardJSONSchemaV1Target,
  StandardSchemaV1,
  StandardSchemaV1FailureResult,
  StandardSchemaV1Issue,
  StandardSchemaV1Options,
  StandardSchemaV1PathSegment,
  StandardSchemaV1Properties,
  StandardSchemaV1Result,
  StandardSchemaV1SuccessResult,
  StandardTypedV1,
  StandardTypedV1Properties,
  StandardTypedV1Types,
} from './core/types/definition-schema.ts';
export type {
  StandardSchemaValidationContext,
  ValidationIssue,
} from './core/types/standard-schema-validate.ts';

/**
 * Format normalized Standard Schema validation issues as a readable message.
 *
 * @example
 * ```ts
 * import { formatStandardSchemaIssues } from '@lostgradient/weft';
 *
 * const message = formatStandardSchemaIssues([
 *   { message: 'Expected a string.', path: '/email' },
 * ]);
 * console.log(message);
 * ```
 */
const exportedFormatStandardSchemaIssues = formatStandardSchemaIssues;

/**
 * Error thrown when Standard Schema runtime validation rejects boundary input.
 *
 * @example
 * ```ts
 * import { StandardSchemaValidationError } from '@lostgradient/weft';
 *
 * const error = new StandardSchemaValidationError({
 *   fieldName: 'input',
 *   operation: 'weft.workflows.start',
 *   issues: [{ message: 'Expected a string.', path: '/email' }],
 * });
 * console.log(error.issues);
 * ```
 */
const exportedStandardSchemaValidationError = StandardSchemaValidationError;

/**
 * Validate unknown input against a Standard Schema-compatible runtime validator.
 *
 * @example
 * ```ts
 * import { validateStandardSchema } from '@lostgradient/weft';
 * import { z } from 'zod';
 *
 * const schema = z.object({ email: z.string().email() });
 * const value = await validateStandardSchema(schema, { email: 'a@b.co' }, {
 *   fieldName: 'input',
 * });
 * console.log(value.email);
 * ```
 */
const exportedValidateStandardSchema = validateStandardSchema;

/**
 * Convert a {@link DefinitionSchema} to a JSON Schema fragment through its vendor adapter (Zod or
 * Valibot) or its `~standard.jsonSchema` converter, as Weft does for an activity's schemas.
 *
 * @example
 * ```ts
 * import { definitionSchemaToJsonSchema } from '@lostgradient/weft';
 * import { z } from 'zod';
 *
 * const jsonSchema = definitionSchemaToJsonSchema(z.object({ email: z.string() }), 'input');
 * console.log(jsonSchema);
 * ```
 */
const exportedDefinitionSchemaToJsonSchema = definitionSchemaToJsonSchema;

export {
  exportedStandardSchemaValidationError as StandardSchemaValidationError,
  exportedDefinitionSchemaToJsonSchema as definitionSchemaToJsonSchema,
  exportedFormatStandardSchemaIssues as formatStandardSchemaIssues,
  exportedValidateStandardSchema as validateStandardSchema,
};
