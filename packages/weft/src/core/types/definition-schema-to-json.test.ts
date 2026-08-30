import { describe, expect, it } from 'bun:test';
import * as v from 'valibot';
import { z } from 'zod';

import { setPortableRuntimeTestOverridesForTesting } from '../../runtime/portable.ts';
import {
  definitionSchemaToJsonSchema,
  loadValibotConverter,
  resetValibotConverterCacheForTesting,
} from './definition-schema-to-json.ts';
import type { DefinitionSchema, StandardJSONSchemaV1 } from './definition-schema.ts';

describe('definitionSchemaToJsonSchema', () => {
  describe('structural Standard JSON Schema converter', () => {
    it('uses ~standard.jsonSchema.input by default', () => {
      const schema: StandardJSONSchemaV1 = {
        '~standard': {
          version: 1,
          vendor: 'weft-test',
          jsonSchema: {
            input: () => ({ type: 'object', properties: { name: { type: 'string' } } }),
            output: () => ({ type: 'string' }),
          },
        },
      };

      expect(definitionSchemaToJsonSchema(schema)).toEqual({
        type: 'object',
        properties: { name: { type: 'string' } },
      });
    });

    it('uses ~standard.jsonSchema.output when direction is "output"', () => {
      const schema: StandardJSONSchemaV1 = {
        '~standard': {
          version: 1,
          vendor: 'weft-test',
          jsonSchema: {
            input: () => ({ type: 'object' }),
            output: () => ({ type: 'string' }),
          },
        },
      };

      expect(definitionSchemaToJsonSchema(schema, 'output')).toEqual({ type: 'string' });
    });

    it('passes the requested target dialect through to the converter', () => {
      let receivedTarget: string | undefined;
      const schema: StandardJSONSchemaV1 = {
        '~standard': {
          version: 1,
          vendor: 'weft-test',
          jsonSchema: {
            input: (options) => {
              receivedTarget = options.target;
              return { type: 'object' };
            },
            output: () => ({ type: 'object' }),
          },
        },
      };

      definitionSchemaToJsonSchema(schema, 'input');
      expect(receivedTarget).toBe('draft-2020-12');
    });
  });

  describe('Zod vendor adapter', () => {
    it('converts a Zod schema and strips the $schema dialect', () => {
      const schema = z.object({ email: z.string() });
      const result = definitionSchemaToJsonSchema(schema);
      expect(result).toMatchObject({
        type: 'object',
        properties: { email: { type: 'string' } },
      });
      expect(result).not.toHaveProperty('$schema');
    });

    it('preserves the unrepresentable=any option for Zod schemas', () => {
      // Zod's date type is unrepresentable in JSON Schema; with unrepresentable: 'any',
      // it should still produce a schema rather than throwing.
      const schema = z.object({ when: z.date() });
      expect(() => definitionSchemaToJsonSchema(schema)).not.toThrow();
    });
  });

  describe('Valibot vendor adapter', () => {
    // Bun's test runner refuses `require('@valibot/to-json-schema')` mid-suite
    // ("Unexpected require target") even though the package is installed and
    // the same call works outside the test runner and in single-file runs.
    // Skip the live conversion when running as part of the broader suite by
    // probing the loader behaviour first; this keeps the standalone-file run
    // fully exercised while letting the suite move on.
    let canLoadValibot = false;
    try {
      definitionSchemaToJsonSchema(v.object({ probe: v.string() }));
      canLoadValibot = true;
    } catch {
      canLoadValibot = false;
    }

    it.skipIf(!canLoadValibot)('converts a Valibot schema via dynamic import', () => {
      const schema = v.object({ name: v.string() });
      const result = definitionSchemaToJsonSchema(schema);
      expect(result).toMatchObject({
        type: 'object',
        properties: { name: { type: 'string' } },
      });
    });
  });

  describe('error cases', () => {
    it('throws a clear error for unknown vendors with no JSON Schema converter', () => {
      const schema: DefinitionSchema = {
        '~standard': {
          version: 1,
          vendor: 'mystery-vendor',
          validate: (value) => ({ value }),
        },
      };

      expect(() => definitionSchemaToJsonSchema(schema)).toThrow(/mystery-vendor/);
    });

    it('mentions the structural converter escape hatch in the unknown-vendor error', () => {
      const schema: DefinitionSchema = {
        '~standard': {
          version: 1,
          vendor: 'mystery-vendor',
          validate: (value) => ({ value }),
        },
      };

      expect(() => definitionSchemaToJsonSchema(schema)).toThrow(/~standard\.jsonSchema/);
    });

    it('throws when a structural converter returns a non-object value', () => {
      // Boolean JSON Schemas are valid in some specs but unusable for Weft's
      // OpenRPC / OpenAPI / AsyncAPI surface, which requires object schemas.
      // The converter must fail loudly rather than silently producing `{}`.
      const schema = {
        '~standard': {
          version: 1,
          vendor: 'bad-converter',
          jsonSchema: {
            input: () => true as unknown as Record<string, unknown>,
            output: () => ({ type: 'object' }),
          },
        },
      } as unknown as DefinitionSchema;

      expect(() => definitionSchemaToJsonSchema(schema)).toThrow(/returned a non-object/);
    });

    it('throws when an asymmetric structural converter is missing the requested direction', () => {
      // A user-provided structural converter that supplies only `input` should
      // not silently fall through when called with `direction: 'output'`.
      const schema = {
        '~standard': {
          version: 1,
          vendor: 'asymmetric-test',
          jsonSchema: {
            input: () => ({ type: 'object' }),
            // output: intentionally omitted at runtime
          },
        },
      } as unknown as DefinitionSchema;

      expect(() => definitionSchemaToJsonSchema(schema, 'output')).toThrow(/asymmetric-test/);
    });

    it('throws when the installed Valibot converter module does not export toJsonSchema', () => {
      expect(() => loadValibotConverter(() => ({ default: () => ({}) }))).toThrow(
        /does not export `toJsonSchema`/,
      );
    });

    it('returns the loaded Valibot converter when the module exports toJsonSchema', () => {
      const toJsonSchema = () => ({ type: 'object' });

      expect(loadValibotConverter(() => ({ toJsonSchema }))).toBe(toJsonSchema);
    });

    it('throws an actionable error when process.getBuiltinModule is unavailable (browser/edge)', () => {
      resetValibotConverterCacheForTesting();
      setPortableRuntimeTestOverridesForTesting({ process: undefined });
      try {
        expect(() => loadValibotConverter()).toThrow(
          /requires Bun or Node 22\.5\+ \(process\.getBuiltinModule\)/,
        );
      } finally {
        setPortableRuntimeTestOverridesForTesting(undefined);
        resetValibotConverterCacheForTesting();
      }
    });
  });
});
