import { describe, expect, it } from 'bun:test';

import type { RegistrySnapshot } from '../core/registry-snapshot.ts';
import {
  CodegenEmitError,
  emitPropertyKey,
  emitRegistryDeclaration,
  jsonSchemaToTypeScript,
} from './codegen-emit.ts';

describe('emitPropertyKey', () => {
  it('emits double-quoted string literals for plain identifiers', () => {
    expect(emitPropertyKey('welcome')).toBe('"welcome"');
  });

  it('escapes embedded quotes and backslashes', () => {
    expect(emitPropertyKey('with "quote"')).toBe('"with \\"quote\\""');
    expect(emitPropertyKey('back\\slash')).toBe('"back\\\\slash"');
  });

  it('escapes control characters', () => {
    expect(emitPropertyKey('line\nbreak')).toBe('"line\\nbreak"');
  });
});

describe('jsonSchemaToTypeScript primitives', () => {
  it.each([
    [{ type: 'string' }, 'string'],
    [{ type: 'number' }, 'number'],
    [{ type: 'integer' }, 'number'],
    [{ type: 'boolean' }, 'boolean'],
    [{ type: 'null' }, 'null'],
  ])('%p → %p', (schema, expected) => {
    expect(jsonSchemaToTypeScript(schema)).toBe(expected);
  });

  it('absent type and unknown keywords degrade to unknown', () => {
    expect(jsonSchemaToTypeScript({})).toBe('unknown');
    expect(jsonSchemaToTypeScript({ description: 'just a description' })).toBe('unknown');
    expect(jsonSchemaToTypeScript(undefined)).toBe('unknown');
    expect(jsonSchemaToTypeScript(null)).toBe('unknown');
  });

  it('boolean schemas convert to unknown/never', () => {
    expect(jsonSchemaToTypeScript(true)).toBe('unknown');
    expect(jsonSchemaToTypeScript(false)).toBe('never');
  });
});

describe('jsonSchemaToTypeScript enum and const', () => {
  it('emits a parenthesized union for primitive enums', () => {
    expect(jsonSchemaToTypeScript({ enum: ['a', 'b', 'c'] })).toBe('("a" | "b" | "c")');
    expect(jsonSchemaToTypeScript({ enum: [1, 2, 3] })).toBe('(1 | 2 | 3)');
    expect(jsonSchemaToTypeScript({ enum: [true, false] })).toBe('(true | false)');
  });

  it('emits unknown when an enum contains a non-primitive', () => {
    expect(jsonSchemaToTypeScript({ enum: ['a', { nested: true }] })).toBe('unknown');
  });

  it('degrades empty enum to unknown', () => {
    expect(jsonSchemaToTypeScript({ enum: [] })).toBe('unknown');
  });

  it('emits a bare literal for a single-entry enum (no parens)', () => {
    expect(jsonSchemaToTypeScript({ enum: ['only'] })).toBe('"only"');
  });

  it('emits a primitive literal for const', () => {
    expect(jsonSchemaToTypeScript({ const: 'fixed' })).toBe('"fixed"');
    expect(jsonSchemaToTypeScript({ const: 42 })).toBe('42');
    expect(jsonSchemaToTypeScript({ const: true })).toBe('true');
    expect(jsonSchemaToTypeScript({ const: null })).toBe('null');
  });

  it('emits unknown for non-primitive const', () => {
    expect(jsonSchemaToTypeScript({ const: { nested: true } })).toBe('unknown');
  });

  it('degrades enum + sibling type assertion to unknown', () => {
    // `enum`/`const` with `type` is a sibling constraint that may
    // be contradictory. Rather than silently emit the literal and
    // hope it satisfies `type`, degrade.
    expect(jsonSchemaToTypeScript({ type: 'number', enum: ['x'] })).toBe('unknown');
    expect(jsonSchemaToTypeScript({ type: 'string', const: 42 })).toBe('unknown');
  });

  it('degrades enum + const on the same node to unknown', () => {
    expect(jsonSchemaToTypeScript({ enum: ['a'], const: 'a' })).toBe('unknown');
  });

  it('ignores annotation-only siblings on enum/const', () => {
    expect(
      jsonSchemaToTypeScript({
        description: 'a literal',
        default: 'a',
        enum: ['a', 'b'],
      }),
    ).toBe('("a" | "b")');
    expect(
      jsonSchemaToTypeScript({
        description: 'a constant',
        const: 'fixed',
      }),
    ).toBe('"fixed"');
  });
});

describe('jsonSchemaToTypeScript combinators', () => {
  it('emits parenthesized unions for oneOf and anyOf', () => {
    expect(jsonSchemaToTypeScript({ oneOf: [{ type: 'string' }, { type: 'number' }] })).toBe(
      '(string | number)',
    );
    expect(jsonSchemaToTypeScript({ anyOf: [{ type: 'string' }, { type: 'boolean' }] })).toBe(
      '(string | boolean)',
    );
  });

  it('emits a parenthesized intersection for allOf', () => {
    expect(
      jsonSchemaToTypeScript({
        allOf: [
          {
            type: 'object',
            properties: { a: { type: 'string' } },
            required: ['a'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: { b: { type: 'number' } },
            required: ['b'],
            additionalProperties: false,
          },
        ],
      }),
    ).toBe('({ "a": string; } & { "b": number; })');
  });

  it('parenthesizes unions when nested inside an array (precedence)', () => {
    const arrayOfUnion = jsonSchemaToTypeScript({
      type: 'array',
      items: { oneOf: [{ type: 'string' }, { type: 'number' }] },
    });
    expect(arrayOfUnion).toBe('Array<(string | number)>');
  });

  it('emits nullable from type-as-array and from oneOf-null', () => {
    expect(jsonSchemaToTypeScript({ type: ['string', 'null'] })).toBe('(string | null)');
    expect(
      jsonSchemaToTypeScript({
        oneOf: [{ type: 'string' }, { type: 'null' }],
      }),
    ).toBe('(string | null)');
  });

  it('handles nullable objects with shape siblings without poisoning the null branch', () => {
    // Common pattern from Zod's `z.object({...}).nullable()`. The
    // null branch must not be poisoned by `properties`/`required`/
    // `additionalProperties` being "unexpected primitive siblings".
    expect(
      jsonSchemaToTypeScript({
        type: ['object', 'null'],
        properties: { a: { type: 'string' } },
        required: ['a'],
        additionalProperties: false,
      }),
    ).toBe('({ "a": string; } | null)');
  });

  it('handles nullable arrays with items without poisoning the null branch', () => {
    expect(
      jsonSchemaToTypeScript({
        type: ['array', 'null'],
        items: { type: 'string' },
      }),
    ).toBe('(Array<string> | null)');
  });

  it('strips object-only keywords from non-object branches when expanding type arrays', () => {
    // `properties` on a `string`/`null` branch is irrelevant; we
    // should still get a clean union.
    expect(
      jsonSchemaToTypeScript({
        type: ['object', 'string'],
        properties: { a: { type: 'string' } },
        required: ['a'],
        additionalProperties: false,
      }),
    ).toBe('({ "a": string; } | string)');
  });

  it('degrades empty type-as-array to unknown', () => {
    expect(jsonSchemaToTypeScript({ type: [] })).toBe('unknown');
  });

  it('emits a bare type for a single-element type-as-array (no parens)', () => {
    expect(jsonSchemaToTypeScript({ type: ['string'] })).toBe('string');
  });

  it('throws CodegenEmitError on excessive recursion depth', () => {
    let deep: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 200; i++) {
      deep = { type: 'array', items: deep };
    }
    expect(() => jsonSchemaToTypeScript(deep)).toThrow(CodegenEmitError);
  });

  it('degrades combinator + sibling assertion to unknown rather than dropping siblings', () => {
    // JSON Schema applies sibling keywords conjunctively. Rather than
    // implementing full composition, the emitter detects this case
    // and degrades to `unknown` so it never silently emits a
    // too-broad type.
    expect(
      jsonSchemaToTypeScript({
        type: 'object',
        properties: { a: { type: 'string' } },
        allOf: [{ properties: { b: { type: 'number' } } }],
      }),
    ).toBe('unknown');
    expect(
      jsonSchemaToTypeScript({
        type: 'string',
        oneOf: [{ const: 'a' }, { const: 'b' }],
      }),
    ).toBe('unknown');
  });

  it('degrades multiple combinators on the same node to unknown', () => {
    expect(
      jsonSchemaToTypeScript({
        oneOf: [{ type: 'string' }],
        allOf: [{ type: 'number' }],
      }),
    ).toBe('unknown');
    expect(
      jsonSchemaToTypeScript({
        anyOf: [{ type: 'string' }],
        oneOf: [{ type: 'number' }],
      }),
    ).toBe('unknown');
  });

  it('degrades type + unsupported sibling keyword (not, $ref, if/then) to unknown', () => {
    // Unsupported assertion keywords alongside a supported `type`
    // would otherwise silently emit the type-derived form, claiming
    // a TypeScript shape narrower or broader than the schema
    // actually accepts.
    expect(jsonSchemaToTypeScript({ type: 'string', not: {} })).toBe('unknown');
    expect(jsonSchemaToTypeScript({ type: 'string', $ref: '#/foo' })).toBe('unknown');
    expect(jsonSchemaToTypeScript({ type: 'number', dependentRequired: { a: ['b'] } })).toBe(
      'unknown',
    );
  });

  it('degrades object + unsupported keyword (patternProperties, propertyNames) to unknown', () => {
    expect(
      jsonSchemaToTypeScript({
        type: 'object',
        patternProperties: { '^x': { type: 'string' } },
        additionalProperties: false,
      }),
    ).toBe('unknown');
    expect(
      jsonSchemaToTypeScript({
        type: 'object',
        propertyNames: { pattern: '^[a-z]+$' },
      }),
    ).toBe('unknown');
    expect(
      jsonSchemaToTypeScript({
        type: 'object',
        unevaluatedProperties: false,
      }),
    ).toBe('unknown');
  });

  it('degrades array + unsupported keyword to unknown', () => {
    expect(
      jsonSchemaToTypeScript({
        type: 'array',
        items: { type: 'string' },
        contains: { type: 'string' },
      }),
    ).toBe('unknown');
  });

  it('still accepts annotation-only siblings on type-dispatched schemas', () => {
    expect(
      jsonSchemaToTypeScript({
        type: 'string',
        description: 'a name',
        minLength: 1,
        maxLength: 200,
      }),
    ).toBe('string');
    expect(
      jsonSchemaToTypeScript({
        type: 'object',
        description: 'a record',
        properties: { a: { type: 'string' } },
        required: ['a'],
        additionalProperties: false,
      }),
    ).toBe('{ "a": string; }');
  });

  it('ignores annotation-only siblings (description/default/minLength/etc.) on combinators', () => {
    // `description`, `minLength`, etc. are documentation/validation
    // hints that do not constrain the TypeScript shape, so the
    // combinator should still resolve normally.
    expect(
      jsonSchemaToTypeScript({
        description: 'a string or number',
        default: 'hello',
        minLength: 1,
        oneOf: [{ type: 'string' }, { type: 'number' }],
      }),
    ).toBe('(string | number)');
  });
});

describe('jsonSchemaToTypeScript objects', () => {
  it('emits required and optional named properties', () => {
    const result = jsonSchemaToTypeScript({
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'number' } },
      required: ['name'],
      additionalProperties: false,
    });
    expect(result).toBe('{ "age"?: number; "name": string; }');
  });

  it('closes the object when additionalProperties: false and emits no index signature', () => {
    const result = jsonSchemaToTypeScript({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    });
    expect(result).not.toContain('[index:');
    expect(result).toBe('{ "a": string; }');
  });

  it('defaults to open with [index: string]: unknown when additionalProperties is absent', () => {
    const result = jsonSchemaToTypeScript({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    });
    expect(result).toBe('{ "a": string; [index: string]: unknown; }');
  });

  it('treats additionalProperties: true as default-open with unknown index value', () => {
    expect(
      jsonSchemaToTypeScript({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
        additionalProperties: true,
      }),
    ).toBe('{ "a": string; [index: string]: unknown; }');
  });

  it('typed additionalProperties widens to include named property value types', () => {
    const result = jsonSchemaToTypeScript({
      type: 'object',
      properties: { count: { type: 'number' } },
      required: ['count'],
      additionalProperties: { type: 'string' },
    });
    expect(result).toBe('{ "count": number; [index: string]: string | number; }');
  });

  it('typed additionalProperties adds undefined when any named property is optional', () => {
    const result = jsonSchemaToTypeScript({
      type: 'object',
      properties: { count: { type: 'number' } },
      required: [],
      additionalProperties: { type: 'string' },
    });
    expect(result).toBe('{ "count"?: number; [index: string]: string | number | undefined; }');
  });

  it('required keys absent from properties become unknown', () => {
    expect(
      jsonSchemaToTypeScript({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a', 'b'],
        additionalProperties: false,
      }),
    ).toBe('{ "a": string; "b": unknown; }');
  });

  it('empty closed object becomes Record<string, never>', () => {
    expect(jsonSchemaToTypeScript({ type: 'object', additionalProperties: false })).toBe(
      'Record<string, never>',
    );
  });

  it('empty default-open object becomes Record<string, unknown>', () => {
    expect(jsonSchemaToTypeScript({ type: 'object' })).toBe('Record<string, unknown>');
  });

  it('empty typed-open object emits an explicit index signature', () => {
    expect(
      jsonSchemaToTypeScript({
        type: 'object',
        additionalProperties: { type: 'string' },
      }),
    ).toBe('{ [index: string]: string }');
  });

  it('invalid additionalProperties values degrade to an unknown index signature', () => {
    expect(
      jsonSchemaToTypeScript({
        type: 'object',
        additionalProperties: 123,
      }),
    ).toBe('Record<string, unknown>');
  });

  it('infers object shape when `type` is absent but `properties` is present', () => {
    expect(
      jsonSchemaToTypeScript({
        properties: { a: { type: 'string' } },
        required: ['a'],
        additionalProperties: false,
      }),
    ).toBe('{ "a": string; }');
  });

  it('infers object shape when `type` is absent but `additionalProperties` is present', () => {
    expect(jsonSchemaToTypeScript({ additionalProperties: false })).toBe('Record<string, never>');
  });
});

describe('jsonSchemaToTypeScript arrays (draft-2020-12)', () => {
  it('items as a single schema emits Array<T>', () => {
    expect(jsonSchemaToTypeScript({ type: 'array', items: { type: 'string' } })).toBe(
      'Array<string>',
    );
  });

  it('prefixItems + items: false emits fixed-length tuple', () => {
    expect(
      jsonSchemaToTypeScript({
        type: 'array',
        prefixItems: [{ type: 'string' }, { type: 'number' }],
        items: false,
      }),
    ).toBe('[string, number]');
  });

  it('prefixItems + items schema emits tuple with rest type', () => {
    expect(
      jsonSchemaToTypeScript({
        type: 'array',
        prefixItems: [{ type: 'string' }],
        items: { type: 'number' },
      }),
    ).toBe('[string, ...number[]]');
  });

  it('prefixItems alone emits tuple with unknown rest (open default)', () => {
    expect(
      jsonSchemaToTypeScript({
        type: 'array',
        prefixItems: [{ type: 'string' }],
      }),
    ).toBe('[string, ...unknown[]]');
  });

  it('legacy items as array + additionalItems false emits fixed tuple', () => {
    expect(
      jsonSchemaToTypeScript({
        type: 'array',
        items: [{ type: 'string' }, { type: 'number' }],
        additionalItems: false,
      }),
    ).toBe('[string, number]');
  });

  it('legacy items as array + additionalItems schema emits tuple with rest', () => {
    expect(
      jsonSchemaToTypeScript({
        type: 'array',
        items: [{ type: 'string' }],
        additionalItems: { type: 'number' },
      }),
    ).toBe('[string, ...number[]]');
  });

  it('legacy items as array defaults to an unknown rest tuple when additionalItems is absent', () => {
    expect(
      jsonSchemaToTypeScript({
        type: 'array',
        items: [{ type: 'string' }, { type: 'number' }],
      }),
    ).toBe('[string, number, ...unknown[]]');
  });

  it('array with no items keyword emits Array<unknown>', () => {
    expect(jsonSchemaToTypeScript({ type: 'array' })).toBe('Array<unknown>');
  });

  it('items: false emits an empty tuple', () => {
    expect(jsonSchemaToTypeScript({ type: 'array', items: false })).toBe('[]');
  });

  it('infers array shape when `type` is absent but `items` is present', () => {
    expect(jsonSchemaToTypeScript({ items: { type: 'string' } })).toBe('Array<string>');
  });

  it('infers array shape when `type` is absent but `prefixItems` is present', () => {
    expect(
      jsonSchemaToTypeScript({
        prefixItems: [{ type: 'string' }, { type: 'number' }],
        items: false,
      }),
    ).toBe('[string, number]');
  });
});

describe('jsonSchemaToTypeScript $ref and ignored keywords', () => {
  it('$ref and $defs degrade to unknown', () => {
    expect(jsonSchemaToTypeScript({ $ref: '#/$defs/Foo' })).toBe('unknown');
    expect(jsonSchemaToTypeScript({ $defs: { Foo: { type: 'string' } } })).toBe('unknown');
  });

  it('ignores description/default/numeric/string constraints on typed schemas', () => {
    expect(
      jsonSchemaToTypeScript({
        type: 'string',
        description: 'an email',
        default: 'a@b',
        minLength: 3,
        maxLength: 200,
        pattern: '@',
      }),
    ).toBe('string');
    expect(
      jsonSchemaToTypeScript({
        type: 'number',
        description: 'count',
        minimum: 0,
        maximum: 100,
      }),
    ).toBe('number');
  });
});

describe('emitRegistryDeclaration', () => {
  function buildSnapshot(input: Partial<RegistrySnapshot> = {}): RegistrySnapshot {
    return {
      registryVersion: 1,
      workflows: input.workflows ?? {},
      activities: input.activities ?? {},
    };
  }

  it('emits a valid empty file when the snapshot has no entries', () => {
    const output = emitRegistryDeclaration(buildSnapshot());
    expect(output).toContain("declare module 'weft' {");
    expect(output).toContain('interface WorkflowRegistry {}');
    // Activity names are typed per-workflow via the builder's
    // `.activities({...})` step, not via a global module augmentation.
    expect(output).not.toContain('ActivityTypes');
    expect(output).toContain('export {};');
    expect(output.endsWith('\n')).toBe(true);
  });

  it('documents in the banner that the augmentation types both engine and client call sites', () => {
    // The emitted `WorkflowRegistry` augmentation is the single source of
    // truth for `engine.start`, the client (`WeftClient.start`/`schedule`),
    // and `result()` output narrowing. The banner records that intent so the
    // generated file is self-explanatory and consumers know it is not
    // engine-only.
    const output = emitRegistryDeclaration(buildSnapshot());
    expect(output).toContain('type engine and client call sites');
  });

  it('is byte-identical across two runs with the same input', () => {
    const snapshot = buildSnapshot({
      workflows: {
        welcome: {
          inputSchema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
            additionalProperties: false,
          },
          outputSchema: { type: 'string' },
        },
      },
    });
    expect(emitRegistryDeclaration(snapshot)).toBe(emitRegistryDeclaration(snapshot));
  });

  it('sorts keys deterministically regardless of insertion order', () => {
    // Two snapshots with explicitly reversed insertion order: V8
    // preserves string-key insertion order, so this is the only way
    // to prove the emitter sorts rather than relying on iteration
    // luck.
    const snapshotA = buildSnapshot({
      workflows: {
        zeta: { inputSchema: { type: 'string' } },
        alpha: { inputSchema: { type: 'string' } },
      },
    });
    const snapshotB = buildSnapshot({
      workflows: {
        alpha: { inputSchema: { type: 'string' } },
        zeta: { inputSchema: { type: 'string' } },
      },
    });
    const outputA = emitRegistryDeclaration(snapshotA);
    const outputB = emitRegistryDeclaration(snapshotB);
    expect(outputA).toBe(outputB);
    expect(outputA.indexOf('"alpha"')).toBeLessThan(outputA.indexOf('"zeta"'));
  });

  it('uses null-prototype-safe key handling for names like __proto__', () => {
    const workflows: Record<string, { inputSchema?: Record<string, unknown> }> =
      Object.create(null);
    workflows['__proto__'] = { inputSchema: { type: 'string' } };
    workflows['valid'] = { inputSchema: { type: 'string' } };
    const output = emitRegistryDeclaration(buildSnapshot({ workflows }));
    expect(output).toContain('"__proto__"');
    expect(output).toContain('"valid"');
  });

  it('does not emit activity entries (they live on per-workflow builders, not a global registry)', () => {
    const output = emitRegistryDeclaration(
      buildSnapshot({
        activities: {
          ping: { queue: 'default', outputSchema: { type: 'string' } },
        },
      }),
    );
    expect(output).not.toContain('ActivityTypes');
    expect(output).not.toContain('"ping"');
  });

  it('emits unknown for workflows with no schemas', () => {
    const output = emitRegistryDeclaration(
      buildSnapshot({
        workflows: { bare: {} },
      }),
    );
    expect(output).toContain('"bare": { input: unknown; output: unknown };');
  });

  it('quotes names with special characters', () => {
    const output = emitRegistryDeclaration(
      buildSnapshot({
        workflows: { 'kebab-name': {}, 'with "quote"': {} },
      }),
    );
    expect(output).toContain('"kebab-name"');
    expect(output).toContain('"with \\"quote\\""');
  });
});
