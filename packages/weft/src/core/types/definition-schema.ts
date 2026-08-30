// ---------------------------------------------------------------------------
// Standard Schema-compatible definition metadata
// ---------------------------------------------------------------------------

/**
 * Metadata stored under `~standard` by Standard Schema-compatible libraries.
 *
 * @example
 * ```ts
 * import type { StandardTypedV1Properties } from '@lostgradient/weft/json-schema';
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
 * import type { StandardTypedV1Types } from '@lostgradient/weft/json-schema';
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
 * import type { StandardSchemaV1Properties } from '@lostgradient/weft/json-schema';
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
 * import type { StandardSchemaV1Result } from '@lostgradient/weft/json-schema';
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
 * import type { StandardSchemaV1SuccessResult } from '@lostgradient/weft/json-schema';
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
 * import type { StandardSchemaV1FailureResult } from '@lostgradient/weft/json-schema';
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
 * import type { StandardSchemaV1Issue } from '@lostgradient/weft/json-schema';
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
 * import type { StandardSchemaV1PathSegment } from '@lostgradient/weft/json-schema';
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
 * import type { StandardSchemaV1Options } from '@lostgradient/weft/json-schema';
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
 * import type { StandardJSONSchemaV1Properties } from '@lostgradient/weft/json-schema';
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
 * import type { StandardJSONSchemaV1Converter } from '@lostgradient/weft/json-schema';
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
 * import type { StandardJSONSchemaV1Target } from '@lostgradient/weft/json-schema';
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
 * import type { StandardJSONSchemaV1Options } from '@lostgradient/weft/json-schema';
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
 * import type { StandardTypedV1 } from '@lostgradient/weft/json-schema';
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
 * import type { StandardSchemaV1 } from '@lostgradient/weft/json-schema';
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
 * import type { StandardJSONSchemaV1 } from '@lostgradient/weft/json-schema';
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
 * import type { DefinitionSchema } from '@lostgradient/weft/json-schema';
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

/**
 * Extract the schema's *input* type — what the validator accepts before any
 * transform runs. For a schema like `z.string().transform(s => s.length)`,
 * `InferSchemaInput` is `string`. Helpers in the codebase use this when they
 * want the wire-side / pre-validation type; for handler-side / post-validation
 * payloads, see {@link InferSchemaOutput}. When a schema omits
 * `~standard.types`, inference usually widens to `unknown`, so typed markers
 * are required to preserve a concrete input type.
 *
 * @example
 * ```ts
 * import type { InferSchemaInput } from '@lostgradient/weft/json-schema';
 * import { z } from 'zod';
 *
 * const schema = z.string().transform((s) => s.length);
 * type Input = InferSchemaInput<typeof schema>; // string
 * const value: Input = 'hello';
 * void value;
 * ```
 */
export type InferSchemaInput<TSchema> =
  TSchema extends StandardTypedV1<infer Input, unknown> ? Input : never;

/**
 * Extract the schema's *output* type — what the validator produces after any
 * transform runs. For a schema like `z.string().transform(s => s.length)`,
 * `InferSchemaOutput` is `number`. The definition helpers use this for
 * handler-side payload types: handlers see the validated, parsed value. When a
 * schema omits `~standard.types`, inference usually widens to `unknown`, so
 * typed markers are required to preserve a concrete output type.
 *
 * @example
 * ```ts
 * import type { InferSchemaOutput } from '@lostgradient/weft/json-schema';
 * import { z } from 'zod';
 *
 * const schema = z.string().transform((s) => s.length);
 * type Output = InferSchemaOutput<typeof schema>; // number
 * const value: Output = 5;
 * void value;
 * ```
 */
export type InferSchemaOutput<TSchema> =
  TSchema extends StandardTypedV1<unknown, infer Output> ? Output : never;

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
  throw new TypeError(
    `${fieldName} must be Standard Schema-compatible definition metadata. ` +
      `Pass a Zod, Valibot, ArkType (or any Standard Schema v1) validator, or ` +
      `attach a \`~standard.jsonSchema\` converter directly. ` +
      `Received: ${describeReceivedValue(value)}.`,
  );
}

function describeReceivedValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  if (typeof value !== 'object') return typeof value;
  const keys = Object.keys(value);
  if (keys.length === 0) return 'an empty object';
  return `an object with keys [${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ', …' : ''}]`;
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
