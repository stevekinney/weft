import { describe, expect, it } from 'bun:test';

import { renderNode, schemaToNode, type TypeNode } from './operation-client-schema.ts';

const NO_ALIASES = new Map<string, string>();
/** Render a JSON Schema with no alias substitution — the pre-hoist baseline. */
function renderInline(schema: Record<string, unknown>): string {
  return renderNode(schemaToNode(schema), NO_ALIASES);
}

describe('schemaToNode + renderNode — emitted text contract', () => {
  // These assertions pin the exact TypeScript text the generator emits for each
  // supported schema feature. Snapshot schemas arrive key-sorted, so on the real
  // catalog this matches the pre-refactor `Object.entries` order byte-for-byte;
  // the explicit field sort here is the intentional, enforced invariant.
  it('renders primitives', () => {
    expect(renderInline({ type: 'string' })).toBe('string');
    expect(renderInline({ type: 'number' })).toBe('number');
    expect(renderInline({ type: 'integer' })).toBe('number');
    expect(renderInline({ type: 'boolean' })).toBe('boolean');
    expect(renderInline({ type: 'null' })).toBe('null');
  });

  it('renders arrays as ReadonlyArray', () => {
    expect(renderInline({ type: 'array', items: { type: 'string' } })).toBe(
      'ReadonlyArray<string>',
    );
    expect(renderInline({ type: 'array' })).toBe('ReadonlyArray<unknown>');
  });

  it('renders type-array unions preserving member order', () => {
    expect(renderInline({ type: ['string', 'number', 'null'] })).toBe('string | number | null');
  });

  it('renders primitive const literals and anyOf unions', () => {
    expect(renderInline({ const: 'delayed', type: 'string' })).toBe('"delayed"');
    expect(renderInline({ const: false, type: 'boolean' })).toBe('false');
    expect(
      renderInline({
        anyOf: [
          {
            type: 'object',
            properties: { kind: { const: 'delayed', type: 'string' } },
            required: ['kind'],
          },
          { type: 'null' },
        ],
      }),
    ).toBe('{ readonly "kind": "delayed"; } | null');
  });

  it('falls back to unknown for unsupported type-array members', () => {
    expect(renderInline({ type: ['string', 123] })).toBe('string | unknown');
    expect(renderInline({ anyOf: [{ type: 'string' }, 123] })).toBe('unknown');
  });

  // WFT-93: `z.discriminatedUnion()` compiles to `oneOf` with a `const`
  // discriminant on each branch. These pin the emitted union so consumers can
  // narrow on the discriminant rather than receiving `unknown`.
  it('renders oneOf branches as a union preserving const discriminants', () => {
    expect(
      renderInline({
        oneOf: [
          {
            type: 'object',
            properties: { state: { const: 'queued', type: 'string' }, queue: { type: 'string' } },
            required: ['state', 'queue'],
          },
          {
            type: 'object',
            properties: { state: { const: 'terminal', type: 'string' } },
            required: ['state'],
          },
        ],
      }),
    ).toBe(
      '{ readonly "queue": string; readonly "state": "queued"; } | { readonly "state": "terminal"; }',
    );
  });

  it('flattens a oneOf branch that is itself a oneOf', () => {
    expect(
      renderInline({
        oneOf: [
          {
            type: 'object',
            properties: { state: { const: 'queued', type: 'string' } },
            required: ['state'],
          },
          {
            oneOf: [
              {
                type: 'object',
                properties: {
                  disposition: { const: 'resolved', type: 'string' },
                  state: { const: 'terminal', type: 'string' },
                },
                required: ['state', 'disposition'],
              },
              {
                type: 'object',
                properties: {
                  disposition: { const: 'cancelled', type: 'string' },
                  state: { const: 'terminal', type: 'string' },
                },
                required: ['state', 'disposition'],
              },
            ],
          },
        ],
      }),
    ).toBe(
      '{ readonly "state": "queued"; } | ' +
        '{ readonly "disposition": "resolved"; readonly "state": "terminal"; } | ' +
        '{ readonly "disposition": "cancelled"; readonly "state": "terminal"; }',
    );
  });

  it('renders a nullable oneOf nested under anyOf', () => {
    expect(
      renderInline({
        anyOf: [
          {
            oneOf: [
              {
                type: 'object',
                properties: { status: { const: 'pending', type: 'string' } },
                required: ['status'],
              },
              {
                type: 'object',
                properties: { status: { const: 'failed', type: 'string' } },
                required: ['status'],
              },
            ],
          },
          { type: 'null' },
        ],
      }),
    ).toBe('{ readonly "status": "pending"; } | { readonly "status": "failed"; } | null');
  });

  it('falls back to unknown for unsupported oneOf members', () => {
    expect(renderInline({ oneOf: [{ type: 'string' }, 123] })).toBe('unknown');
    expect(renderInline({ oneOf: [] })).toBe('unknown');
  });

  // JSON Schema applies sibling combinators conjunctively. Composing them is a
  // non-goal here, so degrade rather than silently honoring one and dropping
  // the other — the same posture `src/json-schema/codegen-emit.ts` takes. `allOf` is an
  // intersection this emitter never interprets, so it degrades even alone, and
  // even when sibling `type`/`properties` keywords would otherwise have matched.
  it('falls back to unknown for allOf and for co-occurring combinators', () => {
    expect(renderInline({ allOf: [{ type: 'string' }] })).toBe('unknown');
    expect(
      renderInline({
        allOf: [{ type: 'object', properties: { a: { type: 'string' } } }],
        type: 'object',
        properties: { b: { type: 'string' } },
      }),
    ).toBe('unknown');
    expect(renderInline({ anyOf: [{ type: 'string' }], oneOf: [{ type: 'number' }] })).toBe(
      'unknown',
    );
    expect(renderInline({ anyOf: [{ type: 'string' }], allOf: [{ type: 'number' }] })).toBe(
      'unknown',
    );
    expect(renderInline({ anyOf: [] })).toBe('unknown');
  });

  it('renders objects with sorted fields and required handling', () => {
    expect(
      renderInline({
        type: 'object',
        properties: { b: { type: 'string' }, a: { type: 'number' } },
        required: ['a'],
      }),
    ).toBe('{ readonly "a": number; readonly "b"?: string; }');
  });

  it('renders a no-properties object as Record<string, unknown>', () => {
    expect(renderInline({ type: 'object' })).toBe('Record<string, unknown>');
  });

  it('renders nested objects', () => {
    expect(
      renderInline({
        type: 'object',
        properties: { range: { type: 'object', properties: { gt: { type: 'number' } } } },
      }),
    ).toBe('{ readonly "range"?: { readonly "gt"?: number; }; }');
  });

  it('renders a string enum as a literal union preserving member order', () => {
    expect(renderInline({ type: 'string', enum: ['started', 'signalled'] })).toBe(
      '"started" | "signalled"',
    );
    // A bare string enum (no explicit `type`) is still a literal union.
    expect(renderInline({ enum: ['a', 'b'] })).toBe('"a" | "b"');
  });

  it('escapes string-enum members with literal-sensitive characters', () => {
    // Raw interpolation would emit invalid or wrong TypeScript for these; the
    // generator must produce a properly escaped string literal per member.
    expect(renderInline({ enum: ["can't"] })).toBe('"can\'t"');
    expect(renderInline({ enum: ['a\\b'] })).toBe('"a\\\\b"');
    expect(renderInline({ enum: ['line\nbreak'] })).toBe('"line\\nbreak"');
    expect(renderInline({ enum: ['quote"d'] })).toBe('"quote\\"d"');
  });

  it('collapses unsupported schema features to unknown', () => {
    // Non-string and mixed enums fall through rather than guessing a literal.
    expect(renderInline({ enum: [1, 2] })).toBe('unknown');
    expect(renderInline({ enum: ['a', 2] })).toBe('unknown');
    expect(renderInline({ enum: [] })).toBe('unknown');
    expect(renderInline({ const: { unsupported: true } })).toBe('unknown');
    expect(renderInline({})).toBe('unknown');
  });

  it('throws on a node kind outside the closed TypeNode union', () => {
    // `TypeNode`'s discriminant is closed and `schemaToNode()` only ever
    // produces one of its member kinds, so TypeScript proves the `default`
    // branch in `renderNode()`'s switch unreachable (`node satisfies never`).
    // Cast past that — as the caller-provided-id runtime guard tests do
    // elsewhere in this repo — to prove the runtime guard itself still fires
    // for a genuinely malformed node (e.g. one built by a future schema
    // variant this renderer has not been updated for).
    const malformed = { kind: 'not-a-real-kind' } as unknown as TypeNode;
    expect(() => renderNode(malformed, NO_ALIASES)).toThrow(/Unsupported schema node/);
  });
});
