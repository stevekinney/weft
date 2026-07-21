import { z } from 'zod';

import { tryLoadNodeBuiltin } from '../../runtime/portable.ts';
import type {
  DefinitionSchema,
  StandardJSONSchemaV1Options,
  StandardJSONSchemaV1Target,
} from './definition-schema.ts';

let cachedValibotConverter: ((schema: unknown, options?: unknown) => unknown) | undefined;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Direction parameter for {@link definitionSchemaToJsonSchema}. `"input"`
 * produces the JSON Schema describing the validator's accepted input;
 * `"output"` produces the schema describing the validated value.
 *
 * @example
 * ```ts
 * import type { DefinitionSchemaDirection } from '@lostgradient/weft';
 *
 * const direction: DefinitionSchemaDirection = 'input';
 * void direction;
 * ```
 */
export type DefinitionSchemaDirection = 'input' | 'output';

/**
 * Convert a {@link DefinitionSchema} to a JSON Schema fragment. Dispatch
 * order:
 *
 * 1. **Built-in vendor adapters first** — Zod (`vendor === 'zod'`) and Valibot
 *    (`vendor === 'valibot'`). This wins even when the schema also exposes a
 *    `~standard.jsonSchema` converter, because libraries like Zod 4 ship a
 *    structural converter that does not honor the project's
 *    `unrepresentable: 'any'` option; deferring to the vendor adapter keeps
 *    generated artifacts stable.
 * 2. **Structural `~standard.jsonSchema.input` / `.output`** — used for
 *    custom or third-party schemas without a built-in adapter.
 * 3. **Otherwise throws** — no built-in adapter and no structural converter.
 *
 * @example
 * ```ts
 * import { definitionSchemaToJsonSchema } from '@lostgradient/weft';
 * import { z } from 'zod';
 *
 * const schema = z.object({ email: z.string() });
 * const jsonSchema = definitionSchemaToJsonSchema(schema);
 * void jsonSchema;
 * ```
 */
export function definitionSchemaToJsonSchema(
  schema: DefinitionSchema,
  direction: DefinitionSchemaDirection = 'input',
): Record<string, unknown> {
  const standard = schema['~standard'];
  const vendor = standard.vendor;

  // Built-in vendor adapters win over a structural converter that may ship
  // alongside the validator. Zod 4, for example, exposes its own
  // `~standard.jsonSchema` that does not honor the project's
  // `unrepresentable: 'any'` option; deferring to the vendor adapter keeps
  // generated artifacts stable.
  if (vendor === 'zod') return convertZod(schema as z.ZodType);
  if (vendor === 'valibot') return convertValibot(schema);

  const structuralConverter = (standard as { jsonSchema?: unknown }).jsonSchema;
  if (isStructuralConverter(structuralConverter)) {
    const fn = structuralConverter[direction];
    if (typeof fn === 'function') {
      const options: StandardJSONSchemaV1Options = { target: defaultTarget };
      return stripDialect(requirePlainObject(fn(options), `${vendor} structural converter`));
    }
    // The schema attached a `~standard.jsonSchema` but is missing the
    // requested direction. Fail loudly rather than fall through to the
    // unknown-vendor message, which would blame the wrong thing.
    throw new Error(
      `definitionSchemaToJsonSchema: schema "${vendor}" provides ` +
        `\`~standard.jsonSchema\` but no \`${direction}\` converter. ` +
        `Attach both \`input\` and \`output\` converters or convert in only one direction.`,
    );
  }

  throw new Error(
    `definitionSchemaToJsonSchema: no built-in adapter for vendor "${vendor}". ` +
      `Attach a \`~standard.jsonSchema\` converter to the schema, or use Zod or Valibot.`,
  );
}

function isStructuralConverter(value: unknown): value is {
  readonly input?: (options: StandardJSONSchemaV1Options) => Record<string, unknown>;
  readonly output?: (options: StandardJSONSchemaV1Options) => Record<string, unknown>;
} {
  return value !== null && typeof value === 'object';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const defaultTarget: StandardJSONSchemaV1Target = 'draft-2020-12';

function convertZod(schema: z.ZodType): Record<string, unknown> {
  const result: unknown = z.toJSONSchema(schema, { unrepresentable: 'any' });
  return stripDialect(requirePlainObject(result, 'zod'));
}

function convertValibot(schema: DefinitionSchema): Record<string, unknown> {
  const toJsonSchema = loadValibotConverter();
  const result: unknown = toJsonSchema(schema);
  return stripDialect(requirePlainObject(result, 'valibot'));
}

/**
 * Build a `require()` rooted at this module's location, without a static
 * `import { createRequire } from 'node:module'`. Returns `undefined` outside
 * Bun/Node (where `process.getBuiltinModule` does not exist), which
 * {@link loadValibotConverter} turns into an actionable error rather than a
 * `ReferenceError`/`TypeError` from calling a stubbed browser bundle export.
 */
function loadNodeRequire(): ((specifier: string) => unknown) | undefined {
  const nodeModule = tryLoadNodeBuiltin<typeof import('node:module')>('node:module');
  return nodeModule?.createRequire(import.meta.url);
}

export function loadValibotConverter(
  requireModule?: (specifier: string) => unknown,
): (schema: unknown, options?: unknown) => unknown {
  const shouldUseCache = requireModule === undefined;
  if (shouldUseCache && cachedValibotConverter !== undefined) return cachedValibotConverter;
  // We let the runtime's package-resolution algorithm handle the `node_modules`
  // walk by passing the package name directly, rather than feeding `require`
  // an absolute path (which Bun's test runner can refuse mid-suite as an
  // "Unexpected require target"). Resolution is rooted at this module's
  // location via `createRequire(import.meta.url)`, which is what we want when
  // Weft is installed as a dependency. `node:module` is loaded through
  // `tryLoadNodeBuiltin` (process.getBuiltinModule) rather than a static
  // `import { createRequire } from 'node:module'`, so this module — reachable
  // from the browser-facing `@lostgradient/weft/client` bundle via the
  // catalog's Valibot schema adapter — carries no static Node built-in import.
  const resolver = requireModule ?? loadNodeRequire();
  if (resolver === undefined) {
    throw new Error(
      'definitionSchemaToJsonSchema: converting a Valibot schema requires Bun or ' +
        'Node 22.5+ (process.getBuiltinModule) to resolve `@valibot/to-json-schema`. ' +
        'Not available in browser or edge runtimes; attach a `~standard.jsonSchema` ' +
        'converter to the schema instead.',
    );
  }
  let valibotModule: { toJsonSchema?: (schema: unknown, options?: unknown) => unknown };
  try {
    valibotModule = resolver('@valibot/to-json-schema') as {
      toJsonSchema?: (schema: unknown, options?: unknown) => unknown;
    };
  } catch (error) {
    throw new Error(
      `definitionSchemaToJsonSchema: \`@valibot/to-json-schema\` is not installed. ` +
        `Install it to convert Valibot schemas to JSON Schema, or attach a ` +
        `\`~standard.jsonSchema\` converter to your schema. ` +
        `Resolver error: ${String(error)}.`,
      { cause: error },
    );
  }
  if (typeof valibotModule.toJsonSchema !== 'function') {
    throw new Error(
      `definitionSchemaToJsonSchema: the installed \`@valibot/to-json-schema\` ` +
        `does not export \`toJsonSchema\`.`,
    );
  }
  const converter = shouldUseCache
    ? (cachedValibotConverter = valibotModule.toJsonSchema)
    : valibotModule.toJsonSchema;
  return converter;
}

function stripDialect(object: Record<string, unknown>): Record<string, unknown> {
  if (!('$schema' in object)) return object;
  const result = { ...object };
  delete result['$schema'];
  return result;
}

function requirePlainObject(value: unknown, vendor: string): Record<string, unknown> {
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
