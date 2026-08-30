import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { isDiscoverable } from './discovery-filter.ts';
import { createLiveOperationRegistry } from './rest-bindings.ts';

const ALLOW_LIST: ReadonlySet<string> = new Set([]);

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

describe('OpenAPI Zod coverage', () => {
  it('converts every required discoverable operation input field to non-empty JSON Schema', () => {
    const registry = createLiveOperationRegistry();

    for (const operation of registry.list()) {
      if (!isDiscoverable(operation)) continue;
      if (ALLOW_LIST.has(operation.name)) continue;

      const jsonSchema = objectRecord(
        z.toJSONSchema(operation.inputSchema, { unrepresentable: 'any' }),
      );
      const required = stringArray(jsonSchema['required']);
      const properties = objectRecord(jsonSchema['properties']);

      for (const field of required) {
        const fieldSchema = properties[field];
        expect(
          fieldSchema,
          `operation "${operation.name}" required field "${field}" converts to empty JSON Schema`,
        ).not.toEqual({});
        expect(fieldSchema).not.toEqual({ type: 'any' });
      }
    }
  });
});
