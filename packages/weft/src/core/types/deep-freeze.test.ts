import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { deepFreeze } from './deep-freeze.ts';
import { definitionSchemaToJsonSchema } from './definition-schema-to-json.ts';

describe('deepFreeze', () => {
  it('leaves schema instances usable while freezing the containing definition', () => {
    const schema = z.object({ message: z.string() });
    const definition = deepFreeze({ input: schema, retry: { maxAttempts: 3 } });

    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.retry)).toBe(true);
    expect(definition.input).toBe(schema);
    expect(definition.input['~standard'].validate({ message: 'hello' })).toEqual({
      value: { message: 'hello' },
    });
    expect(definitionSchemaToJsonSchema(definition.input)).toMatchObject({
      type: 'object',
      properties: { message: { type: 'string' } },
    });
  });

  it('freezes nested plain objects', () => {
    const value = deepFreeze({ retry: { backoff: { initialInterval: 100 } } });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.retry)).toBe(true);
    expect(Object.isFrozen(value.retry.backoff)).toBe(true);
  });

  it('freezes nested arrays', () => {
    const value = deepFreeze({ list: [{ a: 1 }, { b: 2 }] });
    expect(Object.isFrozen(value.list)).toBe(true);
    expect(Object.isFrozen(value.list[0])).toBe(true);
  });

  it('does not stack-overflow on a direct self-cycle', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => deepFreeze(cyclic)).not.toThrow();
    expect(Object.isFrozen(cyclic)).toBe(true);
  });

  it('does not stack-overflow on an indirect cycle', () => {
    const a: { b?: unknown } = {};
    const b: { a?: unknown } = { a };
    a.b = b;
    expect(() => deepFreeze(a)).not.toThrow();
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(b)).toBe(true);
  });
});
