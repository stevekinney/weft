// ---------------------------------------------------------------------------
// Standard Schema-compatible definition metadata
// ---------------------------------------------------------------------------

/**
 * Metadata stored under `~standard` by Standard Schema-compatible libraries.
 *
 * @example
 * ```ts
 * import type { StandardTypedV1Properties } from 'weft';
 *
 * const properties: StandardTypedV1Properties = { version: 1, vendor: 'example' };
 * void properties;
 * ```
 */
export interface StandardTypedV1Properties<Input = unknown, Output = Input> {
  readonly version: 1;
  readonly vendor: string;
  readonly types?: StandardTypedV1Types<Input, Output> | undefined;
}

/**
 * Compile-time input and output markers used by Standard Schema.
 *
 * @example
 * ```ts
 * import type { StandardTypedV1Types } from 'weft';
 *
 * const types: StandardTypedV1Types<string, number> = {
 *   input: '',
 *   output: 0,
 * };
 * void types;
 * ```
 */
export interface StandardTypedV1Types<Input = unknown, Output = Input> {
  readonly input: Input;
  readonly output: Output;
}

/**
 * Standard Schema v1 validator metadata stored under `~standard`.
 *
 * @example
 * ```ts
 * import type { StandardSchemaV1Properties } from 'weft';
 *
 * const properties: StandardSchemaV1Properties<unknown, string> = {
 *   version: 1,
 *   vendor: 'example',
 *   validate: (value) =>
 *     typeof value === 'string' ? { value } : { issues: [{ message: 'Expected a string.' }] },
 * };
 * void properties;
 * ```
 */
export interface StandardSchemaV1Properties<
  Input = unknown,
  Output = Input,
> extends StandardTypedV1Properties<Input, Output> {
  readonly validate: (
    value: unknown,
    options?: StandardSchemaV1Options,
  ) => StandardSchemaV1Result<Output> | Promise<StandardSchemaV1Result<Output>>;
}

/**
 * Result returned by a Standard Schema v1 validator.
 *
 * @example
 * ```ts
 * import type { StandardSchemaV1Result } from 'weft';
 *
 * const result: StandardSchemaV1Result<string> = { value: 'ok' };
 * void result;
 * ```
 */
export type StandardSchemaV1Result<Output> =
  | StandardSchemaV1SuccessResult<Output>
  | StandardSchemaV1FailureResult;

/**
 * Successful Standard Schema v1 validation result.
 *
 * @example
 * ```ts
 * import type { StandardSchemaV1SuccessResult } from 'weft';
 *
 * const result: StandardSchemaV1SuccessResult<string> = { value: 'ok' };
 * void result;
 * ```
 */
export interface StandardSchemaV1SuccessResult<Output> {
  readonly value: Output;
  readonly issues?: undefined;
}

/**
 * Failed Standard Schema v1 validation result.
 *
 * @example
 * ```ts
 * import type { StandardSchemaV1FailureResult } from 'weft';
 *
 * const result: StandardSchemaV1FailureResult = {
 *   issues: [{ message: 'Expected a string.' }],
 * };
 * void result;
 * ```
 */
export interface StandardSchemaV1FailureResult {
  readonly issues: ReadonlyArray<StandardSchemaV1Issue>;
}

/**
 * Single validation issue reported by a Standard Schema v1 validator.
 *
 * @example
 * ```ts
 * import type { StandardSchemaV1Issue } from 'weft';
 *
 * const issue: StandardSchemaV1Issue = { message: 'Expected a string.' };
 * void issue;
 * ```
 */
export interface StandardSchemaV1Issue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | StandardSchemaV1PathSegment> | undefined;
}

/**
 * Structured path segment in a Standard Schema v1 issue path.
 *
 * @example
 * ```ts
 * import type { StandardSchemaV1PathSegment } from 'weft';
 *
 * const segment: StandardSchemaV1PathSegment = { key: 'email' };
 * void segment;
 * ```
 */
export interface StandardSchemaV1PathSegment {
  readonly key: PropertyKey;
}

/**
 * Options passed to a Standard Schema v1 validator.
 *
 * @example
 * ```ts
 * import type { StandardSchemaV1Options } from 'weft';
 *
 * const options: StandardSchemaV1Options = { libraryOptions: { abortEarly: true } };
 * void options;
 * ```
 */
export interface StandardSchemaV1Options {
  readonly libraryOptions?: Record<string, unknown> | undefined;
}

/**
 * Standard JSON Schema v1 converter metadata stored under `~standard`.
 *
 * @example
 * ```ts
 * import type { StandardJSONSchemaV1Properties } from 'weft';
 *
 * const properties: StandardJSONSchemaV1Properties = {
 *   version: 1,
 *   vendor: 'example',
 *   jsonSchema: {
 *     input: () => ({ type: 'object' }),
 *     output: () => ({ type: 'object' }),
 *   },
 * };
 * void properties;
 * ```
 */
export interface StandardJSONSchemaV1Properties<
  Input = unknown,
  Output = Input,
> extends StandardTypedV1Properties<Input, Output> {
  readonly jsonSchema: StandardJSONSchemaV1Converter;
}

/**
 * Input and output JSON Schema converter functions.
 *
 * @example
 * ```ts
 * import type { StandardJSONSchemaV1Converter } from 'weft';
 *
 * const converter: StandardJSONSchemaV1Converter = {
 *   input: () => ({ type: 'object' }),
 *   output: () => ({ type: 'object' }),
 * };
 * void converter;
 * ```
 */
export interface StandardJSONSchemaV1Converter {
  readonly input: (options: StandardJSONSchemaV1Options) => Record<string, unknown>;
  readonly output: (options: StandardJSONSchemaV1Options) => Record<string, unknown>;
}

/**
 * JSON Schema target dialect requested from a Standard JSON Schema converter.
 *
 * @example
 * ```ts
 * import type { StandardJSONSchemaV1Target } from 'weft';
 *
 * const target: StandardJSONSchemaV1Target = 'draft-2020-12';
 * void target;
 * ```
 */
export type StandardJSONSchemaV1Target =
  | 'draft-2020-12'
  | 'draft-07'
  | 'openapi-3.0'
  | ({} & string);

/**
 * Options passed to Standard JSON Schema converter functions.
 *
 * @example
 * ```ts
 * import type { StandardJSONSchemaV1Options } from 'weft';
 *
 * const options: StandardJSONSchemaV1Options = { target: 'draft-2020-12' };
 * void options;
 * ```
 */
export interface StandardJSONSchemaV1Options {
  readonly target: StandardJSONSchemaV1Target;
  readonly libraryOptions?: Record<string, unknown> | undefined;
}

/**
 * Base type metadata shared by the Standard Schema family.
 *
 * Weft copies the small structural interfaces it consumes instead of taking a
 * runtime dependency on [`@standard-schema/spec`](https://www.npmjs.com/package/@standard-schema/spec).
 * The runtime contract is the `~standard` property; libraries such as
 * [Zod](https://zod.dev/), [Valibot](https://valibot.dev/), and
 * [ArkType](https://arktype.io/) can satisfy it structurally.
 *
 * @example
 * ```ts
 * import type { StandardTypedV1 } from 'weft';
 *
 * const typedMetadata = {
 *   '~standard': { version: 1, vendor: 'example' },
 * } satisfies StandardTypedV1<unknown, unknown>;
 *
 * void typedMetadata;
 * ```
 */
export interface StandardTypedV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardTypedV1Properties<Input, Output>;
}

/**
 * Standard Schema v1 validation surface.
 *
 * @example
 * ```ts
 * import type { StandardSchemaV1 } from 'weft';
 *
 * const stringSchema = {
 *   '~standard': {
 *     version: 1,
 *     vendor: 'example',
 *     validate(value: unknown) {
 *       return typeof value === 'string'
 *         ? { value }
 *         : { issues: [{ message: 'Expected a string.' }] };
 *     },
 *   },
 * } satisfies StandardSchemaV1<unknown, string>;
 *
 * void stringSchema;
 * ```
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1Properties<Input, Output>;
}

/**
 * Standard JSON Schema v1 conversion surface.
 *
 * @example
 * ```ts
 * import type { StandardJSONSchemaV1 } from 'weft';
 *
 * const jsonSchemaMetadata = {
 *   '~standard': {
 *     version: 1,
 *     vendor: 'example',
 *     jsonSchema: {
 *       input: () => ({ type: 'object' }),
 *       output: () => ({ type: 'object' }),
 *     },
 *   },
 * } satisfies StandardJSONSchemaV1<Record<string, unknown>>;
 *
 * void jsonSchemaMetadata;
 * ```
 */
export interface StandardJSONSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardJSONSchemaV1Properties<Input, Output>;
}

/**
 * Schema metadata accepted by workflow and activity definitions.
 *
 * Validation and JSON Schema conversion are separate capabilities. A schema may
 * provide validation only, JSON Schema conversion only, or both. Core workflow
 * and activity registration validates this metadata shape for introspection;
 * adapters must opt in explicitly before using it for runtime input or output
 * validation.
 *
 * @example
 * ```ts
 * import type { DefinitionSchema } from 'weft';
 *
 * function acceptsDefinitionSchema(schema: DefinitionSchema): DefinitionSchema {
 *   return schema;
 * }
 *
 * void acceptsDefinitionSchema;
 * ```
 */
export type DefinitionSchema<Input = unknown, Output = Input> =
  | StandardSchemaV1<Input, Output>
  | StandardJSONSchemaV1<Input, Output>;

type StandardMetadataRecord = {
  jsonSchema?: unknown;
  validate?: unknown;
  vendor?: unknown;
  version?: unknown;
};

export function isDefinitionSchema(value: unknown): value is DefinitionSchema {
  const standardRecord = getStandardMetadataRecord(value);
  if (standardRecord === undefined) return false;
  if (typeof standardRecord.validate === 'function') return true;
  return isStandardJsonSchemaConverter(standardRecord.jsonSchema);
}

export function validateDefinitionSchemaMetadata(
  value: unknown,
  fieldName: string,
): DefinitionSchema {
  if (isDefinitionSchema(value)) return value;
  throw new TypeError(`${fieldName} must be Standard Schema-compatible definition metadata.`);
}

function getStandardMetadataRecord(value: unknown): StandardMetadataRecord | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const standard = (value as { '~standard'?: unknown })['~standard'];
  if (standard === null || typeof standard !== 'object') return undefined;
  const standardRecord = standard as StandardMetadataRecord;
  if (standardRecord.version !== 1) return undefined;
  if (typeof standardRecord.vendor !== 'string' || standardRecord.vendor.length === 0) {
    return undefined;
  }

  return standardRecord;
}

function isStandardJsonSchemaConverter(jsonSchema: unknown): boolean {
  if (jsonSchema === null || typeof jsonSchema !== 'object') return false;
  return (
    typeof (jsonSchema as { input?: unknown }).input === 'function' &&
    typeof (jsonSchema as { output?: unknown }).output === 'function'
  );
}
