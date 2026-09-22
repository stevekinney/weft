/**
 * Tests for the OpenRPC 1.3.2 document generator.
 *
 * `generateOpenRpcDocument` intersects the `OperationRegistry` with the
 * requested JSON-RPC transports in `OpenRpcOptions.transports`:
 *   - `transports: []` → zero methods (and no synthetic rpc.discover).
 *   - `transports: ['http']` → WS-only subscribe methods are omitted.
 *   - Every listed method carries `paramStructure: 'by-name'` plus both the
 *     per-field `ContentDescriptor` surface and an `x-weft-paramsSchema`
 *     extension (the authoritative top-level object schema with
 *     `additionalProperties` computed from `unknownKeyPolicy.jsonRpc`).
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { records } from './protocol.test-support.ts';

import { OpenRpcDocumentSchema } from './openrpc-document-schema.ts';
import { generateOpenRpcDocument } from './openrpc.ts';
import { type OperationRegistry } from './operation-catalog.ts';
import type { ParameterizedAccessHint } from './operation-catalog/types.ts';
import type { UnarySchemaOperationDefinition } from './operation-registry.ts';
import { defineOperation } from './operation-registry.ts';
import { createLiveOperationRegistry } from './rest-bindings.ts';

export function makeOp(overrides: {
  readonly name: string;
  readonly inputSchema?: z.ZodObject;
  readonly outputSchema?: z.ZodType;
  readonly access?: import('./authorization.ts').AccessPolicy;
  readonly discoverable?: boolean;
  readonly mcpExposable?: boolean;
  readonly mcpTool?: { readonly workflowType: string };
  readonly summary?: string;
  readonly tags?: ReadonlyArray<string>;
  readonly destructive?: boolean;
  readonly transports?: {
    readonly http: boolean;
    readonly jsonRpcHttp: boolean;
    readonly jsonRpcWebSocket: boolean;
    readonly jsonRpcStdio: boolean;
  };
  readonly unknownKeyPolicy?: {
    readonly http: 'reject' | 'strip' | 'passthrough';
    readonly jsonRpc: 'reject' | 'strip' | 'passthrough';
  };
  readonly parameterizedAccess?: ParameterizedAccessHint;
}): UnarySchemaOperationDefinition<z.ZodObject, z.ZodType> {
  return defineOperation({
    mcpExposable: false,
    destructive: false,
    summary: 'test op',
    tags: [],
    access: { kind: 'public' },
    inputSchema: overrides.inputSchema ?? z.looseObject({}),
    outputSchema: overrides.outputSchema ?? z.object({}),
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    ...overrides,
    invoke: async () => ({}),
  });
}

export function createRegistryDouble(
  operations: ReadonlyArray<import('./operation-catalog.ts').ErasedOperation>,
): OperationRegistry {
  return {
    get(name) {
      return operations.find((operation) => operation.name === name);
    },
    list() {
      return operations;
    },
  };
}

describe('OpenRPC document schema round-trip', () => {
  it('the live /openrpc.json output validates against the committed minimal OpenRpcDocument schema', () => {
    // Drives the same generator the runtime route handler uses, then
    // parses the result through `OpenRpcDocumentSchema`. If the schema
    // drifts from the live shape (e.g. a generator change adds a field
    // that the schema rejects), this test fails — pinning the schema as
    // the canonical contract description.
    const document = generateOpenRpcDocument({
      registry: createLiveOperationRegistry(),
      transports: ['http', 'websocket'],
    });
    const parsed = OpenRpcDocumentSchema.safeParse(document);
    if (!parsed.success) {
      throw new Error(
        `OpenRpcDocument schema rejected the live document: ${JSON.stringify(parsed.error.issues)}`,
      );
    }
    expect(parsed.success).toBe(true);
    const parsedDocument: unknown = parsed.data;
    const generatedDocument: unknown = document;
    expect(parsedDocument).toEqual(generatedDocument);
  });

  it('rejects an operation-catalog method that omits x-weft-access', () => {
    const document = generateOpenRpcDocument({
      registry: createLiveOperationRegistry(),
      transports: ['http', 'websocket'],
    });
    const methods = records(document['methods'], 'document methods');
    const operationMethod = methods.find((method) => method['name'] !== 'rpc.discover')!;
    delete operationMethod['x-weft-access'];

    const parsed = OpenRpcDocumentSchema.safeParse(document);

    expect(parsed.success).toBe(false);
  });
});
