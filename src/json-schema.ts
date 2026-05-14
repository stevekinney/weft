/**
 * Standard Schema and JSON Schema helper types for Weft definition metadata.
 *
 * @module json-schema
 */

import {
  StandardSchemaValidationError,
  formatStandardSchemaIssues,
  validateStandardSchema,
} from './core/types/standard-schema-validate.ts';

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
 * import { formatStandardSchemaIssues } from 'weft/json-schema';
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
 * import { StandardSchemaValidationError } from 'weft/json-schema';
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
 * import { validateStandardSchema } from 'weft/json-schema';
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

export {
  exportedStandardSchemaValidationError as StandardSchemaValidationError,
  exportedFormatStandardSchemaIssues as formatStandardSchemaIssues,
  exportedValidateStandardSchema as validateStandardSchema,
};
