import { compareStrings } from '../src/server/json-schema-utilities.ts';

const UNSUPPORTED_COMBINATOR = Symbol('unsupported-combinator');

export type TypeNode =
  | { readonly kind: 'primitive'; readonly text: string }
  | { readonly kind: 'array'; readonly element: TypeNode }
  | { readonly kind: 'union'; readonly members: ReadonlyArray<TypeNode> }
  | { readonly kind: 'record' }
  | { readonly kind: 'object'; readonly fields: ReadonlyArray<ObjectField> };

export type ObjectField = {
  readonly name: string;
  readonly optional: boolean;
  readonly value: TypeNode;
};

/**
 * Return the members of an all-string `enum`, or `undefined` when the schema has
 * no `enum` or any member is not a string. A single-quoted string-literal union
 * is emitted for these; mixed or non-string enums fall through to the `unknown`
 * fallback rather than guessing a representation.
 */
function stringEnumMembers(schema: Record<string, unknown>): readonly string[] | undefined {
  const values = schema['enum'];
  if (!Array.isArray(values) || values.length === 0) return undefined;
  if (!values.every((value): value is string => typeof value === 'string')) return undefined;
  return values;
}

/**
 * Return the branch schemas of a `anyOf`/`oneOf` union, `undefined` when the
 * schema is not a union, or {@link UNSUPPORTED_COMBINATOR} when it is one the
 * emitter refuses to interpret.
 *
 * TypeScript has no exclusive-or type, so `oneOf` and `anyOf` both render to
 * the same `A | B` union text; Zod's `discriminatedUnion()` compiles to `oneOf`
 * with a `const` discriminant per branch, which the `const` handling above
 * already preserves as a literal (WFT-93). `allOf` stays unsupported.
 *
 * JSON Schema applies sibling combinators conjunctively, so a node carrying
 * more than one is a constraint this emitter does not compose. Degrade to
 * `unknown` rather than silently honoring one and dropping the rest — the same
 * posture `src/json-schema/codegen-emit.ts` takes for the same case.
 */
function unionBranches(
  schema: Record<string, unknown>,
): readonly unknown[] | undefined | typeof UNSUPPORTED_COMBINATOR {
  let found:
    { readonly keyword: 'anyOf' | 'oneOf'; readonly branches: readonly unknown[] } | undefined;
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const value = schema[keyword];
    if (!Array.isArray(value)) continue;
    if (found !== undefined || keyword === 'allOf') return UNSUPPORTED_COMBINATOR;
    found = { keyword, branches: value };
  }
  if (found === undefined) return undefined;
  // An empty combinator array is a degenerate schema with no branches to union.
  return found.branches.length > 0 ? found.branches : UNSUPPORTED_COMBINATOR;
}

/**
 * Parse a JSON Schema fragment into a normalized {@link TypeNode}. Reproduces
 * exactly the schema subset the emitter supports: primitives, arrays,
 * string `enum` literal unions, primitive `const` literals, `type: []` unions,
 * `anyOf`/`oneOf` unions, objects (honoring `required`), no-`properties` objects
 * as `Record<string, unknown>`, and an `unknown` fallback for every other schema
 * feature (non-string `enum`, `allOf`, co-occurring combinators,
 * additionalProperties, nullable patterns).
 */
export function schemaToNode(schema: Record<string, unknown>): TypeNode {
  const constant = schema['const'];
  if (
    typeof constant === 'string' ||
    typeof constant === 'number' ||
    typeof constant === 'boolean' ||
    constant === null
  ) {
    return { kind: 'primitive', text: JSON.stringify(constant) };
  }

  const branches = unionBranches(schema);
  if (branches === UNSUPPORTED_COMBINATOR) return { kind: 'primitive', text: 'unknown' };
  if (branches !== undefined) {
    const members = branches.map((member) =>
      isRecord(member)
        ? schemaToNode(member)
        : ({ kind: 'primitive', text: 'unknown' } satisfies TypeNode),
    );
    if (members.some((member) => member.kind === 'primitive' && member.text === 'unknown')) {
      return { kind: 'primitive', text: 'unknown' };
    }
    return {
      kind: 'union',
      members,
    };
  }

  // A string `enum` is tighter than its `type: 'string'`, so emit the literal
  // union and preserve the operation's discriminant (e.g. startorsignal's
  // `outcome: 'started' | 'signalled'`) instead of widening to `string`. Members
  // stay in schema order for deterministic output. Non-string enums fall through.
  const stringEnum = stringEnumMembers(schema);
  if (stringEnum !== undefined) {
    return {
      kind: 'union',
      // `JSON.stringify` produces a TypeScript-valid double-quoted string literal
      // with proper escaping, so enum values containing quotes, backslashes, or
      // newlines emit a correct literal rather than via raw interpolation.
      members: stringEnum.map((value) => ({ kind: 'primitive', text: JSON.stringify(value) })),
    };
  }
  return typedSchemaNode(schema);
}

function typedSchemaNode(schema: Record<string, unknown>): TypeNode {
  const type = schema['type'];
  switch (type) {
    case 'string':
      return { kind: 'primitive', text: 'string' };
    case 'number':
    case 'integer':
      return { kind: 'primitive', text: 'number' };
    case 'boolean':
      return { kind: 'primitive', text: 'boolean' };
    case 'null':
      return { kind: 'primitive', text: 'null' };
    case 'array':
      return arraySchemaNode(schema['items']);
  }
  if (Array.isArray(type)) {
    return { kind: 'union', members: type.map(typeUnionMember) };
  }
  if (type === 'object' || isRecord(schema['properties'])) return objectSchemaNode(schema);
  return { kind: 'primitive', text: 'unknown' };
}

function typeUnionMember(value: unknown): TypeNode {
  return typeof value === 'string'
    ? schemaToNode({ type: value })
    : { kind: 'primitive', text: 'unknown' };
}

function arraySchemaNode(items: unknown): TypeNode {
  return {
    kind: 'array',
    element: isRecord(items) ? schemaToNode(items) : { kind: 'primitive', text: 'unknown' },
  };
}

function objectSchemaNode(schema: Record<string, unknown>): TypeNode {
  const properties = schema['properties'];
  if (!isRecord(properties)) return { kind: 'record' };
  const required = new Set(
    Array.isArray(schema['required'])
      ? schema['required'].filter((entry): entry is string => typeof entry === 'string')
      : [],
  );
  // Canonical property order keeps alias identity independent of insertion order.
  const fields = Object.entries(properties)
    .map(([name, propertySchema]) => ({
      name,
      optional: !required.has(name),
      value: isRecord(propertySchema)
        ? schemaToNode(propertySchema)
        : ({ kind: 'primitive', text: 'unknown' } satisfies TypeNode),
    }))
    .toSorted((left, right) => compareStrings(left.name, right.name));
  return { kind: 'object', fields };
}

/**
 * Render a {@link TypeNode} to TypeScript. When a child node's
 * {@link canonicalKey} is present in `aliasNameByKey`, the alias name is
 * substituted in place of inlining the shape. `suppressKey` prevents an alias
 * body from referencing itself (which would emit `type X = X`).
 */
export function renderNode(
  node: TypeNode,
  aliasNameByKey: ReadonlyMap<string, string>,
  suppressKey?: string,
): string {
  // Render a child, substituting its alias name unless it is the suppressed self.
  const renderChild = (child: TypeNode): string => {
    const key = canonicalKey(child);
    if (key !== suppressKey) {
      const alias = aliasNameByKey.get(key);
      if (alias !== undefined) return alias;
    }
    return renderNode(child, aliasNameByKey, suppressKey);
  };

  switch (node.kind) {
    case 'primitive':
      return node.text;
    case 'record':
      return 'Record<string, unknown>';
    case 'array':
      return `ReadonlyArray<${renderChild(node.element)}>`;
    case 'union':
      return node.members.map((member) => renderChild(member)).join(' | ');
    case 'object': {
      const fields = node.fields.map((field) => {
        const optional = field.optional ? '?' : '';
        return `readonly ${JSON.stringify(field.name)}${optional}: ${renderChild(field.value)};`;
      });
      return `{ ${fields.join(' ')} }`;
    }
    default:
      throw new Error(`Unsupported schema node: ${JSON.stringify(node satisfies never)}`);
  }
}

/**
 * Render a top-level node (an operation input/output position). Unlike
 * {@link renderNode}, this substitutes the alias name when the node *itself* is
 * hoisted — so two operations with an identical whole-object input both collapse
 * to the same alias reference.
 */
export function renderRoot(node: TypeNode, aliasNameByKey: ReadonlyMap<string, string>): string {
  const alias = aliasNameByKey.get(canonicalKey(node));
  if (alias !== undefined) return alias;
  return renderNode(node, aliasNameByKey);
}

/** Deterministic structural key for a node; equal iff the emitted text is equal. */
export function canonicalKey(node: TypeNode): string {
  return JSON.stringify(node);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
