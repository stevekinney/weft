/**
 * JSON Schema extraction and component deduplication for OpenAPI documents.
 *
 * @module server/openapi-schemas
 */

import { z } from 'zod';

import { definitionSchemaToJsonSchema } from '../core/types/definition-schema-to-json.ts';
import { isDiscoverable } from './discovery-filter.ts';
import { compareStrings, normalizeJsonObject } from './json-schema-utilities.ts';
import { canonicalJson } from './openapi-canonical-json.ts';
import type { OperationRegistry } from './operation-catalog.ts';

/** Schema slots owned by an operation definition. */
export type OpenApiSchemaSlot = 'Input' | 'Output' | 'Event';

export type OpenApiSchemaHelper = {
  readonly components: Record<string, unknown>;
  refFor(operationName: string, slot: OpenApiSchemaSlot): unknown;
};

type Owner = {
  readonly operationName: string;
  readonly slot: OpenApiSchemaSlot;
};

type Entry = {
  readonly schema: Record<string, unknown>;
  readonly owners: Owner[];
};

/**
 * Extract JSON Schemas for every discoverable operation and hoist duplicate
 * schemas into `components.schemas` using canonical-JSON equality.
 */
export function extractComponentsSchemas(registry: OperationRegistry): OpenApiSchemaHelper {
  const byCanonical = new Map<string, Entry>();
  const operationSlotToCanonical = new Map<string, string>();

  for (const operation of registry.list()) {
    if (!isDiscoverable(operation)) continue;

    const slots: ReadonlyArray<readonly [OpenApiSchemaSlot, z.ZodType | undefined]> = [
      ['Input', operation.inputSchema],
      ['Output', operation.outputSchema],
      ['Event', operation.eventSchema],
    ];

    for (const [slot, schema] of slots) {
      if (schema === undefined) continue;

      const jsonSchema = definitionSchemaToJsonSchema(schema, directionForSlot(slot));
      const canonical = canonicalJson(jsonSchema);
      const owner = { operationName: operation.name, slot };
      operationSlotToCanonical.set(ownerKey(owner.operationName, owner.slot), canonical);

      const existing = byCanonical.get(canonical);
      if (existing === undefined) {
        byCanonical.set(canonical, { schema: normalizeJsonObject(jsonSchema), owners: [owner] });
      } else {
        existing.owners.push(owner);
      }
    }
  }

  const components: Record<string, unknown> = {};
  const hoistedKeys = new Map<string, string>();
  const hoistCandidates = [...byCanonical.entries()]
    .filter(([, entry]) => entry.owners.length >= 2)
    .map(([canonical, entry]) => {
      const firstOwner = [...entry.owners].toSorted(compareOwners)[0]!;
      return {
        canonical,
        entry,
        baseName: operationSlotToComponentName(firstOwner.operationName, firstOwner.slot),
      };
    })
    .toSorted(
      (left, right) =>
        compareStrings(left.baseName, right.baseName) ||
        compareStrings(left.canonical, right.canonical),
    );

  for (const candidate of hoistCandidates) {
    let componentName = candidate.baseName;
    let suffix = 2;
    while (componentName in components) {
      componentName = `${candidate.baseName}_${suffix}`;
      suffix += 1;
    }
    components[componentName] = candidate.entry.schema;
    hoistedKeys.set(candidate.canonical, componentName);
  }

  return {
    components,
    refFor(operationName: string, slot: OpenApiSchemaSlot): unknown {
      const canonical = operationSlotToCanonical.get(ownerKey(operationName, slot));
      if (canonical === undefined) return undefined;

      const componentName = hoistedKeys.get(canonical);
      if (componentName !== undefined) {
        return { $ref: `#/components/schemas/${componentName}` };
      }

      return byCanonical.get(canonical)?.schema;
    },
  };
}

function ownerKey(operationName: string, slot: OpenApiSchemaSlot): string {
  return `${operationName}:${slot}`;
}

function directionForSlot(slot: OpenApiSchemaSlot): 'input' | 'output' {
  return slot === 'Input' ? 'input' : 'output';
}

function compareOwners(left: Owner, right: Owner): number {
  return (
    compareStrings(left.operationName, right.operationName) || compareStrings(left.slot, right.slot)
  );
}

function operationSlotToComponentName(operationName: string, slot: OpenApiSchemaSlot): string {
  return (
    operationName
      .split('.')
      .map((segment) => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
      .join('') + slot
  );
}
