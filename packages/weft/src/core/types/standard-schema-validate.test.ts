import { describe, expect, it } from 'bun:test';
import * as v from 'valibot';
import { z } from 'zod';

import type { DefinitionSchema, StandardSchemaV1 } from './definition-schema.ts';
import {
  StandardSchemaValidationError,
  formatStandardSchemaIssues,
  validateStandardSchema,
} from './standard-schema-validate.ts';

const stringSchema: StandardSchemaV1<unknown, string> = {
  '~standard': {
    version: 1,
    vendor: 'weft-test',
    validate: (value) =>
      typeof value === 'string' ? { value } : { issues: [{ message: 'Expected a string.' }] },
  },
};

describe('validateStandardSchema', () => {
  it('returns the validated value on success with a hand-rolled schema', async () => {
    const result = await validateStandardSchema(stringSchema, 'hello', {
      fieldName: 'input',
    });
    expect(result).toBe('hello');
  });

  it('returns the validated value with a Zod schema', async () => {
    const schema = z.object({ email: z.string().email() });
    const result = await validateStandardSchema(
      schema,
      { email: 'a@b.co' },
      {
        fieldName: 'input',
      },
    );
    expect(result).toEqual({ email: 'a@b.co' });
  });

  it('returns the validated value with a Valibot schema', async () => {
    const schema = v.object({ name: v.string() });
    const result = await validateStandardSchema(
      schema,
      { name: 'Ada' },
      {
        fieldName: 'input',
      },
    );
    expect(result).toEqual({ name: 'Ada' });
  });

  it('awaits async validators', async () => {
    const asyncSchema: StandardSchemaV1<unknown, number> = {
      '~standard': {
        version: 1,
        vendor: 'weft-test',
        validate: async (value) =>
          typeof value === 'number' ? { value } : { issues: [{ message: 'Expected a number.' }] },
      },
    };

    const result = await validateStandardSchema(asyncSchema, 42, { fieldName: 'input' });
    expect(result).toBe(42);
  });

  it('throws StandardSchemaValidationError on failure', async () => {
    await expect(
      validateStandardSchema(stringSchema, 123, {
        fieldName: 'payload',
        operation: 'weft.workflows.signal',
      }),
    ).rejects.toBeInstanceOf(StandardSchemaValidationError);
  });

  it('propagates async validator throws', async () => {
    const throwingSchema: StandardSchemaV1<unknown, number> = {
      '~standard': {
        version: 1,
        vendor: 'weft-test',
        validate: async () => {
          throw new Error('validator blew up');
        },
      },
    };

    await expect(validateStandardSchema(throwingSchema, 1, { fieldName: 'input' })).rejects.toThrow(
      /validator blew up/,
    );
  });

  it('attaches fieldName, operation, and issues on the thrown error', async () => {
    try {
      await validateStandardSchema(stringSchema, 123, {
        fieldName: 'payload',
        operation: 'weft.workflows.signal',
      });
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(StandardSchemaValidationError);
      const validationError = error as StandardSchemaValidationError;
      expect(validationError.fieldName).toBe('payload');
      expect(validationError.operation).toBe('weft.workflows.signal');
      expect(validationError.issues).toHaveLength(1);
      expect(validationError.issues[0]?.message).toBe('Expected a string.');
      expect(validationError.issues[0]?.path).toBe('');
    }
  });

  it('formats deeply-nested issue paths as RFC 6901 JSON Pointers', async () => {
    const nested = z.object({
      items: z.array(
        z.object({
          sku: z.string(),
        }),
      ),
    });

    try {
      await validateStandardSchema(
        nested,
        { items: [{ sku: 'ok' }, { sku: 123 }] },
        { fieldName: 'input' },
      );
      throw new Error('expected validation to fail');
    } catch (error) {
      const validationError = error as StandardSchemaValidationError;
      expect(validationError.issues[0]?.path).toBe('/items/1/sku');
    }
  });

  it('escapes ~ as ~0 and / as ~1 in path segments', async () => {
    const slashTilde: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'weft-test',
        validate: () => ({
          issues: [
            {
              message: 'bad',
              path: ['a/b', 'c~d', 0, { key: 'plain' }],
            },
          ],
        }),
      },
    };

    try {
      await validateStandardSchema(slashTilde, {}, { fieldName: 'input' });
      throw new Error('expected validation to fail');
    } catch (error) {
      const validationError = error as StandardSchemaValidationError;
      expect(validationError.issues[0]?.path).toBe('/a~1b/c~0d/0/plain');
    }
  });

  it('encodes empty path arrays as the empty string', async () => {
    const rootIssue: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'weft-test',
        validate: () => ({ issues: [{ message: 'root failure' }] }),
      },
    };

    try {
      await validateStandardSchema(rootIssue, {}, { fieldName: 'input' });
      throw new Error('expected validation to fail');
    } catch (error) {
      const validationError = error as StandardSchemaValidationError;
      expect(validationError.issues[0]?.path).toBe('');
    }
  });

  it('throws TypeError when the schema only carries a JSON Schema converter', async () => {
    const jsonSchemaOnly: DefinitionSchema = {
      '~standard': {
        version: 1,
        vendor: 'weft-test',
        jsonSchema: {
          input: () => ({ type: 'object' }),
          output: () => ({ type: 'object' }),
        },
      },
    };

    await expect(
      validateStandardSchema(jsonSchemaOnly, {}, { fieldName: 'input' }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('includes the field name in the TypeError message for JSON-Schema-only schemas', async () => {
    const jsonSchemaOnly: DefinitionSchema = {
      '~standard': {
        version: 1,
        vendor: 'weft-test',
        jsonSchema: {
          input: () => ({ type: 'object' }),
          output: () => ({ type: 'object' }),
        },
      },
    };

    await expect(
      validateStandardSchema(jsonSchemaOnly, {}, { fieldName: 'workflow.input' }),
    ).rejects.toThrow(/workflow\.input/);
  });
});

describe('formatStandardSchemaIssues', () => {
  it('formats a single issue with a path', () => {
    const formatted = formatStandardSchemaIssues([
      { message: 'Expected a string.', path: '/email' },
    ]);
    expect(formatted).toBe('/email: Expected a string.');
  });

  it('formats multiple issues separated by newlines', () => {
    const formatted = formatStandardSchemaIssues([
      { message: 'Expected a string.', path: '/email' },
      { message: 'Expected an integer.', path: '/age' },
    ]);
    expect(formatted).toBe('/email: Expected a string.\n/age: Expected an integer.');
  });

  it('omits the leading colon for root-level issues', () => {
    const formatted = formatStandardSchemaIssues([{ message: 'bad payload', path: '' }]);
    expect(formatted).toBe('bad payload');
  });

  it('returns an empty string when the issue list is empty', () => {
    expect(formatStandardSchemaIssues([])).toBe('');
  });
});
