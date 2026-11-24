/**
 * Zod to JSON Schema, for the generic operation layer.
 *
 * Every operation declares its input, output and event schemas as Zod types, so the documents and
 * the catalog snapshot convert only those. Weft's public schema converter
 * (`definitionSchemaToJsonSchema`, which also converts Valibot and structural schemas) delegates its
 * Zod branch here, so the two never disagree.
 *
 * @module server/zod-json-schema
 */

import { z } from 'zod';

/**
 * Which side of a schema to describe: `'input'` is what the schema accepts, `'output'` is what it
 * validates to.
 */
export type ZodJsonSchemaDirection = 'input' | 'output';

/** Convert a Zod schema to a JSON Schema fragment without a `$schema` dialect marker. */
export function zodToJsonSchema(
  schema: z.ZodType,
  direction: ZodJsonSchemaDirection = 'input',
): Record<string, unknown> {
  // `io` decides whether a `.default()` field is required: the input side
  // leaves it optional, the output side always carries it. Zod also stops
  // closing plain objects (`additionalProperties: false`) on the input side;
  // the override restores that so published contracts keep the closed shape
  // they had before `io` was forwarded and only `required` changes.
  const result: unknown = z.toJSONSchema(schema, {
    unrepresentable: 'any',
    io: direction,
    override: ({ zodSchema, jsonSchema }) => {
      if (direction !== 'input' || !(zodSchema instanceof z.ZodObject)) return;
      if (!zodSchema.def.catchall && jsonSchema.additionalProperties === undefined) {
        jsonSchema.additionalProperties = false;
      }
    },
  });
  return stripDialect(requirePlainObject(result));
}

/** Drop the `$schema` dialect marker so a fragment embeds in a larger document. */
export function stripDialect(object: Record<string, unknown>): Record<string, unknown> {
  if (!('$schema' in object)) return object;
  const result = { ...object };
  delete result['$schema'];
  return result;
}

/** Narrow a converter's result to a JSON Schema object, or fail loudly. */
export function requirePlainObject(value: unknown, vendor = 'zod'): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  // Fail loudly: silently swapping a non-object converter result for `{}`
  // would emit unconstrained schemas in OpenRPC / OpenAPI / AsyncAPI output.
  throw new Error(
    `definitionSchemaToJsonSchema: ${vendor} converter returned a non-object ` +
      `(${typeof value}). Expected a JSON Schema object.`,
  );
}
