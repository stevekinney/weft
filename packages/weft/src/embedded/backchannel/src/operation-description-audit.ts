/**
 * Audit that an operation catalog describes itself on the wire.
 *
 * @module server/operation-description-audit
 */

import { z } from 'zod';

import { isDiscoverable } from './discovery-filter.ts';
import type { ErasedOperation } from './operation-catalog.ts';
import { zodToJsonSchema } from './zod-json-schema.ts';

/**
 * The part of an operation the description audit reads. Anything
 * `defineOperation` returns satisfies it.
 */
type AuditedOperation = Pick<
  ErasedOperation,
  'name' | 'description' | 'access' | 'discoverable' | 'inputSchema'
>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function isParameterDescribed(
  property: unknown,
  definitions: Record<string, unknown> | undefined,
): boolean {
  if (!isPlainObject(property)) return false;
  if (hasText(property['description'])) return true;
  // A reused schema is emitted once under `$defs` and referenced; the
  // description then lives on the definition the reference resolves to.
  const reference = property['$ref'];
  if (typeof reference !== 'string' || definitions === undefined) return false;
  const prefix = '#/$defs/';
  if (!reference.startsWith(prefix)) return false;
  const definitionName = reference.slice(prefix.length);
  if (!Object.hasOwn(definitions, definitionName)) return false;
  const target = definitions[definitionName];
  return isPlainObject(target) && hasText(target['description']);
}

function undescribedParameters(operation: AuditedOperation): string[] {
  // The registry already requires an object input; a non-object has no
  // parameter fields to describe.
  if (!(operation.inputSchema instanceof z.ZodObject)) return [];
  const schema = zodToJsonSchema(operation.inputSchema);
  const properties = schema['properties'];
  if (!isPlainObject(properties)) return [];
  const definitions = isPlainObject(schema['$defs']) ? schema['$defs'] : undefined;
  return Object.keys(properties)
    .filter((name) => !isParameterDescribed(properties[name], definitions))
    .toSorted();
}

/**
 * List what a catalog leaves undescribed in its discovery documents.
 *
 * Only discoverable operations are audited: public operations, and
 * non-public ones marked `discoverable: true` (the same filter that decides
 * what OpenAPI and OpenRPC list). Each is reported when it has no
 * `description`, and once more for every top-level input field whose JSON
 * Schema carries no `description`, which is the text a zod `.describe()` puts
 * on the wire. The result is empty when the catalog is fully described, so a
 * catalog's own test asserts it equals `[]` and fails with the offending names.
 *
 * Call `.describe()` last on a nullable field: `.describe('x').nullable()` wraps
 * the described schema in an `anyOf`, so the field itself carries no
 * `description` and is reported, while `.nullable().describe('x')` passes.
 * Placing `.describe()` before `.optional()` or `.default()` also passes.
 *
 * Accepts a registry (anything with `list()`) or an iterable of operations.
 * Entries read `<operation>: missing description` or
 * `<operation>: parameter "<field>" missing description`, sorted by operation.
 *
 * @example
 * ```ts
 * import { findUndescribedOperations } from '@lostgradient/backchannel';
 * import { createLiveOperationRegistry } from '@lostgradient/weft';
 *
 * const undescribed = findUndescribedOperations(createLiveOperationRegistry());
 * console.log(undescribed.length === 0 ? 'every operation is described' : undescribed.join('\n'));
 * ```
 */
export function findUndescribedOperations(
  operations: Iterable<AuditedOperation> | { list(): Iterable<AuditedOperation> },
): ReadonlyArray<string> {
  const entries = Symbol.iterator in operations ? operations : operations.list();
  const problems: string[] = [];
  for (const operation of entries) {
    if (!isDiscoverable(operation)) continue;
    if (!hasText(operation.description)) problems.push(`${operation.name}: missing description`);
    for (const field of undescribedParameters(operation)) {
      problems.push(`${operation.name}: parameter "${field}" missing description`);
    }
  }
  return problems.toSorted();
}
