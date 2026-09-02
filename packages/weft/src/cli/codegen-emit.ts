/**
 * Deterministic JSON-Schema → TypeScript emitter for `weft codegen`.
 *
 * Consumes the active workflow projection of a registry snapshot
 * (`Record<name, RegistryWorkflowEntry>`, the same data served by
 * `GET /v1/registry` and resolved from its v2 manifest array by
 * `codegen-validate.ts`'s `resolveActiveWorkflowEntries`) and produces a
 * single `.d.ts` string that augments the public `'@lostgradient/weft'`
 * module with typed `WorkflowRegistry` entries. The output is byte-stable
 * across runs with the same input:
 * keys are sorted with explicit codepoint comparators, property names
 * are uniformly double-quoted via `JSON.stringify`, and there are no
 * timestamps or environment-dependent paths.
 *
 * The augmented `WorkflowRegistry` interface is the single source of
 * truth for per-workflow input/output typing across the whole public
 * surface: `engine.start`, `WorkflowHandle.result()`, AND the client
 * (`WeftClient.start`/`schedule` and `ClientHandle.result()`). The
 * client overloads key off this interface, so emitting one declaration
 * narrows both engine and client call sites — there is no separate
 * client-specific emission, and skipping codegen leaves both usable with
 * plain string names.
 *
 * Activity names are no longer emitted as a global `ActivityTypes`
 * module augmentation — that interface was removed when the chained
 * workflow builder made activity names a per-workflow concern (typed at
 * the builder's `.activities({...})` step). The snapshot still carries
 * activity schemas because the same registry feeds discovery and MCP tooling,
 * but the emitter intentionally drops them from the
 * generated `.d.ts`.
 *
 * The JSON Schema subset supported here covers what
 * `definitionSchemaToJsonSchema` actually produces today (Zod via
 * `z.toJSONSchema` and Valibot via `@valibot/to-json-schema`).
 * Anything outside that subset degrades to `unknown` so the emitter
 * never claims a type it cannot justify.
 *
 * @module cli/codegen-emit
 */

import type { RegistryWorkflowEntry } from '../core/registry-snapshot.ts';
import {
  ARRAY_SUPPORTED_KEYS,
  CodegenEmitError,
  hasUnexpectedSibling,
  OBJECT_SUPPORTED_KEYS,
  PRIMITIVE_SUPPORTED_KEYS,
} from './codegen-emit-keywords.ts';

export { CodegenEmitError } from './codegen-emit-keywords.ts';

const WEFT_PACKAGE_NAME = '@lostgradient/weft';

// Deterministic, locale-independent compare via `<`/`>` (UTF-16
// code-unit order). Registry keys are workflow/activity identifiers
// and never contain astral codepoints in practice, so the difference
// from true Unicode codepoint order doesn't matter.
function codepointCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Emit a TypeScript property key as a double-quoted string literal. */
export function emitPropertyKey(name: string): string {
  return JSON.stringify(name);
}

function primitiveTypeFor(typeKeyword: string): string | undefined {
  switch (typeKeyword) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    default:
      return undefined;
  }
}

/**
 * Maximum recursion depth for `jsonSchemaToTypeScript`. JSON Schema
 * inputs are generated from finite TypeScript types in practice, so a
 * 64-deep bound is comfortably more than enough for any real workflow
 * or activity schema, while still cheaply bounding the converter
 * against a hostile or malformed input. When the limit is hit, the
 * converter throws {@link CodegenEmitError}, which the executor
 * converts to a `CommandOutput` with exit code 1 — the user-facing
 * contract that the CLI never crashes on bad input is preserved.
 */
const MAX_RECURSION_DEPTH = 64;

function tryCombinator(node: Record<string, unknown>, depth: number): string | undefined {
  const hasOneOf = Array.isArray(node['oneOf']);
  const hasAnyOf = Array.isArray(node['anyOf']);
  const hasAllOf = Array.isArray(node['allOf']);

  const combinatorCount = (hasOneOf ? 1 : 0) + (hasAnyOf ? 1 : 0) + (hasAllOf ? 1 : 0);
  if (combinatorCount === 0) return undefined;

  // Multiple combinators on the same node (e.g. `oneOf` + `allOf`)
  // are conjunctive sibling constraints in JSON Schema. We don't
  // attempt to compose them — degrade rather than silently pick one.
  if (combinatorCount > 1) return 'unknown';

  // JSON Schema applies sibling keywords conjunctively: a combinator
  // appearing alongside `type`, `properties`, `enum`, etc. does NOT
  // replace those constraints. Rather than implement full sibling
  // composition (which would balloon the emitter and rarely matters
  // in practice for Zod/Valibot outputs), detect the case and
  // degrade to `unknown` so we never silently emit a too-broad type.
  if (hasUnexpectedSibling(node, ['oneOf', 'anyOf', 'allOf'])) return 'unknown';

  if (hasOneOf) return parenUnion(node['oneOf'] as unknown[], depth);
  if (hasAnyOf) return parenUnion(node['anyOf'] as unknown[], depth);
  return parenIntersection(node['allOf'] as unknown[], depth);
}

function enumLiteralsToTypeScript(entries: unknown[]): string {
  // Empty `enum: []` is a degenerate schema. We emit `unknown` for
  // symmetry with other "we don't know" paths.
  if (entries.length === 0) return 'unknown';
  const literals = entries.map(literalFromValue);
  if (literals.some((literal) => literal === 'unknown')) return 'unknown';
  if (literals.length === 1) return literals[0]!;
  return `(${literals.join(' | ')})`;
}

function tryEnumOrConst(node: Record<string, unknown>): string | undefined {
  const hasConst = 'const' in node;
  const hasEnum = Array.isArray(node['enum']);
  if (!hasConst && !hasEnum) return undefined;
  if (hasConst && hasEnum) return 'unknown';

  // `enum`/`const` paired with other assertion keywords (`type`,
  // `properties`, etc.) is a sibling constraint we don't compose.
  // Degrade so we never claim a literal that may not satisfy the
  // sibling. Annotation-only keywords (description, default, …) are
  // fine to ignore.
  const ownKeyword = hasConst ? 'const' : 'enum';
  if (hasUnexpectedSibling(node, [ownKeyword])) return 'unknown';

  if (hasConst) return literalFromValue(node['const']);
  return enumLiteralsToTypeScript(node['enum'] as unknown[]);
}

// Keywords that only apply when the value has a specific shape.
// When expanding `type: [...]` into per-branch dispatches, strip
// keywords irrelevant to the branch's type so common patterns like
// `{ type: ['object', 'null'], properties: { … } }` don't poison
// the null branch with "unexpected siblings" and degrade to
// `unknown`.
const OBJECT_ONLY_KEYWORDS = ['properties', 'required', 'additionalProperties'] as const;
const ARRAY_ONLY_KEYWORDS = ['items', 'prefixItems', 'additionalItems'] as const;

function projectNodeForTypeBranch(
  node: Record<string, unknown>,
  branchType: string,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type') continue;
    if (branchType !== 'object' && (OBJECT_ONLY_KEYWORDS as readonly string[]).includes(key)) {
      continue;
    }
    if (branchType !== 'array' && (ARRAY_ONLY_KEYWORDS as readonly string[]).includes(key)) {
      continue;
    }
    projected[key] = value;
  }
  projected['type'] = branchType;
  return projected;
}

function expandTypeArray(
  node: Record<string, unknown>,
  typeKeyword: unknown[],
  depth: number,
): string {
  // `type: ['string', 'null']` flattens to a union of the per-type
  // results so callers get `(string | null)` rather than `unknown`.
  if (typeKeyword.length === 0) return 'unknown';
  const branches = typeKeyword.map((branchType) => {
    if (typeof branchType !== 'string') return 'unknown';
    return jsonSchemaToTypeScriptAtDepth(projectNodeForTypeBranch(node, branchType), depth + 1);
  });
  if (branches.length === 1) return branches[0]!;
  return `(${branches.join(' | ')})`;
}

function dispatchTypeString(
  node: Record<string, unknown>,
  typeKeyword: string,
  depth: number,
): string | undefined {
  if (typeKeyword === 'array') {
    if (hasUnexpectedSibling(node, ARRAY_SUPPORTED_KEYS)) return 'unknown';
    return arrayTypeScript(node, depth);
  }
  if (typeKeyword === 'object') {
    if (hasUnexpectedSibling(node, OBJECT_SUPPORTED_KEYS)) return 'unknown';
    return objectTypeScript(node, depth);
  }
  const primitive = primitiveTypeFor(typeKeyword);
  if (primitive === undefined) return undefined;
  if (hasUnexpectedSibling(node, PRIMITIVE_SUPPORTED_KEYS)) return 'unknown';
  return primitive;
}

function dispatchByType(node: Record<string, unknown>, depth: number): string | undefined {
  const typeKeyword = node['type'];
  if (Array.isArray(typeKeyword)) return expandTypeArray(node, typeKeyword, depth);
  if (typeof typeKeyword !== 'string') return undefined;
  return dispatchTypeString(node, typeKeyword, depth);
}

function dispatchByShape(node: Record<string, unknown>, depth: number): string | undefined {
  // `properties` or `additionalProperties` without an explicit
  // `type: 'object'` is still object-shaped (some converters omit
  // `type`). Same for `items`/`prefixItems` → array.
  if ('properties' in node || 'additionalProperties' in node) {
    if (hasUnexpectedSibling(node, OBJECT_SUPPORTED_KEYS)) return 'unknown';
    return objectTypeScript(node, depth);
  }
  if ('items' in node || 'prefixItems' in node) {
    if (hasUnexpectedSibling(node, ARRAY_SUPPORTED_KEYS)) return 'unknown';
    return arrayTypeScript(node, depth);
  }
  return undefined;
}

function normalizeSchema(schema: unknown): Record<string, unknown> | string {
  if (schema === undefined || schema === null) return 'unknown';
  if (schema === true) return 'unknown';
  if (schema === false) return 'never';
  if (typeof schema !== 'object' || Array.isArray(schema)) return 'unknown';
  return schema as Record<string, unknown>;
}

function jsonSchemaToTypeScriptAtDepth(schema: unknown, depth: number): string {
  if (depth > MAX_RECURSION_DEPTH) {
    throw new CodegenEmitError(
      `JSON Schema converter exceeded ${MAX_RECURSION_DEPTH} levels of nesting`,
    );
  }
  const node = normalizeSchema(schema);
  if (typeof node === 'string') return node;
  // Combinators take precedence over `type` only when no sibling
  // assertion keywords are present; otherwise `tryCombinator`
  // degrades to `unknown` (see comment inside it).
  return (
    tryCombinator(node, depth) ??
    tryEnumOrConst(node) ??
    dispatchByType(node, depth) ??
    dispatchByShape(node, depth) ??
    'unknown'
  );
}

/** Convert a single JSON Schema fragment to a TypeScript type expression. */
export function jsonSchemaToTypeScript(schema: unknown): string {
  return jsonSchemaToTypeScriptAtDepth(schema, 0);
}

function parenUnion(branches: unknown[], depth: number): string {
  if (branches.length === 0) return 'unknown';
  const types = branches.map((branch) => jsonSchemaToTypeScriptAtDepth(branch, depth + 1));
  if (types.length === 1) return types[0]!;
  return `(${types.join(' | ')})`;
}

function parenIntersection(branches: unknown[], depth: number): string {
  if (branches.length === 0) return 'unknown';
  const types = branches.map((branch) => jsonSchemaToTypeScriptAtDepth(branch, depth + 1));
  if (types.length === 1) return types[0]!;
  return `(${types.join(' & ')})`;
}

function literalFromValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return 'unknown';
}

function arrayTypeScript(node: Record<string, unknown>, depth: number): string {
  const prefixItems = node['prefixItems'];
  const itemsRaw = node['items'];
  const additionalItemsRaw = node['additionalItems'];
  const childDepth = depth + 1;

  // Draft-2020-12: `prefixItems` carries the tuple positions, and
  // `items` (a single schema or `false`) controls the rest.
  if (Array.isArray(prefixItems)) {
    const positions = prefixItems.map((p) => jsonSchemaToTypeScriptAtDepth(p, childDepth));
    if (itemsRaw === false) {
      return `[${positions.join(', ')}]`;
    }
    if (itemsRaw === undefined) {
      // Draft-2020-12 default is open: rest of `unknown`.
      return `[${[...positions, '...unknown[]'].join(', ')}]`;
    }
    const restType = jsonSchemaToTypeScriptAtDepth(itemsRaw, childDepth);
    return `[${[...positions, `...${restType}[]`].join(', ')}]`;
  }

  // Draft-07 tuple form: `items` may be an array of position schemas,
  // in which case `additionalItems` plays the rest-controller role.
  if (Array.isArray(itemsRaw)) {
    const positions = itemsRaw.map((p) => jsonSchemaToTypeScriptAtDepth(p, childDepth));
    if (additionalItemsRaw === false) {
      return `[${positions.join(', ')}]`;
    }
    if (additionalItemsRaw === undefined) {
      return `[${[...positions, '...unknown[]'].join(', ')}]`;
    }
    const restType = jsonSchemaToTypeScriptAtDepth(additionalItemsRaw, childDepth);
    return `[${[...positions, `...${restType}[]`].join(', ')}]`;
  }

  if (itemsRaw === undefined || itemsRaw === true) {
    return 'Array<unknown>';
  }
  if (itemsRaw === false) {
    return '[]';
  }
  return `Array<${jsonSchemaToTypeScriptAtDepth(itemsRaw, childDepth)}>`;
}

type ObjectRendering = {
  propertyLines: string[];
  namedValueTypes: string[];
  hasOptionalNamedProperty: boolean;
};

function renderObjectProperties(
  properties: Record<string, unknown> | undefined,
  requiredSet: ReadonlySet<string>,
  depth: number,
): ObjectRendering {
  const declaredKeys = properties ? Object.keys(properties) : [];
  const declaredKeySet = new Set(declaredKeys);
  const missingRequired = [...requiredSet].filter((key) => !declaredKeySet.has(key));
  const allKeys = [...declaredKeys, ...missingRequired].toSorted(codepointCompare);

  const propertyLines: string[] = [];
  const namedValueTypes: string[] = [];
  let hasOptionalNamedProperty = false;

  for (const key of allKeys) {
    const isRequired = requiredSet.has(key);
    const schemaForKey = properties && declaredKeySet.has(key) ? properties[key] : undefined;
    const valueType = jsonSchemaToTypeScriptAtDepth(schemaForKey, depth + 1);
    namedValueTypes.push(valueType);
    if (!isRequired) hasOptionalNamedProperty = true;
    propertyLines.push(`${emitPropertyKey(key)}${isRequired ? '' : '?'}: ${valueType};`);
  }

  return { propertyLines, namedValueTypes, hasOptionalNamedProperty };
}

function emptyObjectTypeScript(indexSignature: string | undefined): string {
  if (indexSignature === undefined) {
    // `additionalProperties: false` with no named properties.
    return 'Record<string, never>';
  }
  if (indexSignature === 'unknown') {
    return 'Record<string, unknown>';
  }
  return `{ [index: string]: ${indexSignature} }`;
}

function objectTypeScript(node: Record<string, unknown>, depth: number): string {
  const propertiesRaw = node['properties'];
  const properties =
    propertiesRaw !== null && typeof propertiesRaw === 'object' && !Array.isArray(propertiesRaw)
      ? (propertiesRaw as Record<string, unknown>)
      : undefined;
  const requiredRaw = node['required'];
  const requiredSet = new Set<string>(
    Array.isArray(requiredRaw)
      ? requiredRaw.filter((entry): entry is string => typeof entry === 'string')
      : [],
  );

  const rendering = renderObjectProperties(properties, requiredSet, depth);
  const indexSignature = indexSignatureForObject(
    node['additionalProperties'],
    rendering.namedValueTypes,
    rendering.hasOptionalNamedProperty,
    depth,
  );

  if (rendering.propertyLines.length === 0) {
    return emptyObjectTypeScript(indexSignature);
  }

  if (indexSignature === undefined) {
    return `{ ${rendering.propertyLines.join(' ')} }`;
  }
  return `{ ${rendering.propertyLines.join(' ')} [index: string]: ${indexSignature}; }`;
}

/**
 * Resolve the index-signature value type for an object schema.
 *
 * - `additionalProperties: false` → closed (return `undefined` so the
 *   caller emits no index signature).
 * - Absent or `true` → open with `unknown` (a supertype of every
 *   named property's value type, so the resulting `.d.ts` always
 *   typechecks under `strict`).
 * - Schema object → typed open. The value type is the union of the
 *   typed schema and every named property's value type, plus
 *   `undefined` when any named property is optional, so TypeScript's
 *   index-signature compatibility rule is satisfied.
 */
function indexSignatureForObject(
  additionalRaw: unknown,
  namedValueTypes: readonly string[],
  hasOptionalNamedProperty: boolean,
  depth: number,
): string | undefined {
  if (additionalRaw === false) return undefined;
  if (additionalRaw === undefined || additionalRaw === true) return 'unknown';

  if (
    additionalRaw !== null &&
    typeof additionalRaw === 'object' &&
    !Array.isArray(additionalRaw)
  ) {
    const typedValue = jsonSchemaToTypeScriptAtDepth(additionalRaw, depth + 1);
    const unionMembers = new Set<string>([typedValue, ...namedValueTypes]);
    if (hasOptionalNamedProperty) unionMembers.add('undefined');
    const members = [...unionMembers];
    if (members.length === 1) return members[0]!;
    return members.join(' | ');
  }

  return 'unknown';
}

function sortedWorkflowEntries(
  workflows: Record<string, RegistryWorkflowEntry>,
): Array<[string, RegistryWorkflowEntry]> {
  return Object.entries(workflows).toSorted(([a], [b]) => codepointCompare(a, b));
}

function emitWorkflowEntry(name: string, entry: RegistryWorkflowEntry): string {
  const input = jsonSchemaToTypeScript(entry.inputSchema);
  const output = jsonSchemaToTypeScript(entry.outputSchema);
  return `    ${emitPropertyKey(name)}: { input: ${input}; output: ${output} };`;
}

/**
 * Emit the full `.d.ts` declaration string for a registry's active workflow
 * projection.
 *
 * The output is deterministic: keys are sorted by codepoint, property
 * names go through {@link emitPropertyKey}, and unions/intersections
 * are always parenthesized so they compose correctly when nested.
 */
export function emitRegistryDeclaration(
  activeWorkflows: Record<string, RegistryWorkflowEntry>,
): string {
  const workflows = sortedWorkflowEntries(activeWorkflows);

  const workflowLines = workflows.map(([name, entry]) => emitWorkflowEntry(name, entry));

  const workflowBlock =
    workflowLines.length === 0
      ? '  interface WorkflowRegistry {}'
      : ['  interface WorkflowRegistry {', ...workflowLines, '  }'].join('\n');

  const lines = [
    '// Generated by `weft codegen`. Do not edit by hand.',
    '// Augments `WorkflowRegistry` to type engine and client call sites',
    '// (start/schedule input and handle.result() output) per workflow.',
    '/* eslint-disable */',
    '',
    `declare module '${WEFT_PACKAGE_NAME}' {`,
    workflowBlock,
    '}',
    '',
    'export {};',
    '',
  ];

  return lines.join('\n');
}
