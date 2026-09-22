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
import { record, records } from './protocol.test-support.ts';

import { generateOpenRpcDocument } from './openrpc.ts';
import { createOperationRegistry, type OperationRegistry } from './operation-catalog.ts';
import type { ParameterizedAccessHint } from './operation-catalog/types.ts';
import type { UnarySchemaOperationDefinition } from './operation-registry.ts';
import { defineOperation } from './operation-registry.ts';

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function makeOp(overrides: {
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

describe('generateOpenRpcDocument — params schema fidelity', () => {
  it('emits a ContentDescriptor per top-level input field', () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.workflows.signal',
        inputSchema: z.object({
          id: z.string(),
          name: z.string(),
          payload: z.unknown(),
        }),
        outputSchema: z.object({}),
      }),
    ]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http'],
    });
    const method = records(document['methods'], 'document methods').find(
      (m) => m['name'] === 'weft.workflows.signal',
    )!;
    const params = records(method['params'], 'method params');
    const sortedNames = params
      .map((p) => {
        const name = p['name'];
        if (typeof name !== 'string') throw new Error('expected parameter name');
        return name;
      })
      .toSorted(byString);
    expect(sortedNames).toEqual(['id', 'name', 'payload']);
    for (const p of params) {
      expect(typeof record(p['schema'], 'parameter schema')).toBe('object');
    }
  });

  it('emits x-weft-paramsSchema with additionalProperties=false when unknownKeyPolicy.jsonRpc is reject', () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.workflows.get',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({}),
        unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      }),
    ]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http'],
    });
    const method = records(document['methods'], 'document methods')[0]!;
    const paramsSchema = record(method['x-weft-paramsSchema'], 'params schema');
    expect(paramsSchema).toBeDefined();
    expect(paramsSchema['type']).toBe('object');
    expect(paramsSchema['additionalProperties']).toBe(false);
  });

  it('emits parameterized access metadata for selector-scoped operations', () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.workflows.events',
        inputSchema: z.object({ selector: z.enum(['events', 'tokens']).optional() }),
        outputSchema: z.object({ subscriptionId: z.string() }),
        access: { kind: 'authenticated' },
        discoverable: true,
        parameterizedAccess: {
          discriminator: 'selector',
          defaultValue: 'events',
          variants: [
            {
              value: 'events',
              access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['events:read'] } },
            },
            {
              value: 'tokens',
              access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['streams:read'] } },
            },
          ],
        },
      }),
    ]);
    const document = generateOpenRpcDocument({ registry, transports: ['websocket'] });
    const method = records(document['methods'], 'document methods').find(
      (candidate) => candidate['name'] === 'weft.workflows.events',
    )!;

    expect(method['x-weft-parameterizedAccess']).toEqual({
      discriminator: 'selector',
      defaultValue: 'events',
      variants: [
        {
          value: 'events',
          access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['events:read'] } },
        },
        {
          value: 'tokens',
          access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['streams:read'] } },
        },
      ],
    });
  });

  it('emits parameterized access metadata for optional and alternative scope policies', () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.policy.example',
        inputSchema: z.object({ mode: z.enum(['optional', 'alternative']).optional() }),
        outputSchema: z.object({ ok: z.boolean() }),
        access: { kind: 'authenticated' },
        discoverable: true,
        parameterizedAccess: {
          discriminator: 'mode',
          variants: [
            {
              value: 'optional',
              access: {
                kind: 'optionalAuth',
                authenticatedScopes: { kind: 'anyOf', scopes: ['events:read'] },
              },
            },
            {
              value: 'alternative',
              access: {
                kind: 'scopedAlternatives',
                alternatives: [
                  { kind: 'anyOf', scopes: ['events:read'] },
                  { kind: 'anyOf', scopes: ['streams:read'] },
                ],
              },
            },
          ],
        },
      }),
    ]);

    const document = generateOpenRpcDocument({ registry, transports: ['http'] });
    const method = records(document['methods'], 'document methods').find(
      (candidate) => candidate['name'] === 'weft.policy.example',
    )!;

    expect(method['x-weft-parameterizedAccess']).toEqual({
      discriminator: 'mode',
      variants: [
        {
          value: 'optional',
          access: {
            kind: 'optionalAuth',
            authenticatedScopes: { kind: 'anyOf', scopes: ['events:read'] },
          },
        },
        {
          value: 'alternative',
          access: {
            kind: 'scopedAlternatives',
            alternatives: [
              { kind: 'anyOf', scopes: ['events:read'] },
              { kind: 'anyOf', scopes: ['streams:read'] },
            ],
          },
        },
      ],
    });
  });

  it('emits x-weft-paramsSchema with additionalProperties=true when unknownKeyPolicy.jsonRpc is strip or passthrough', () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.permissive.strip',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({}),
        unknownKeyPolicy: { http: 'reject', jsonRpc: 'strip' },
      }),
      makeOp({
        name: 'weft.permissive.passthrough',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({}),
        unknownKeyPolicy: { http: 'reject', jsonRpc: 'passthrough' },
      }),
    ]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http'],
    });
    const methods = records(document['methods'], 'document methods').filter(
      (m) => m['name'] !== 'rpc.discover',
    );
    expect(methods.length).toBe(2);
    for (const method of methods) {
      const paramsSchema = record(method['x-weft-paramsSchema'], 'params schema');
      expect(paramsSchema['additionalProperties']).toBe(true);
    }
  });

  it('ContentDescriptor names exactly match x-weft-paramsSchema properties (drift guard)', () => {
    const registry = createOperationRegistry([
      makeOp({
        name: 'weft.workflows.start',
        inputSchema: z.object({
          id: z.string(),
          input: z.unknown(),
          scheduleAt: z.number().optional(),
        }),
        outputSchema: z.object({}),
      }),
    ]);
    const document = generateOpenRpcDocument({
      registry,
      transports: ['http'],
    });
    const method = records(document['methods'], 'document methods')[0]!;
    const params = records(method['params'], 'method params');
    const paramsSchema = record(method['x-weft-paramsSchema'], 'params schema');
    const descriptorNames = params
      .map((p) => {
        const name = p['name'];
        if (typeof name !== 'string') throw new Error('expected parameter name');
        return name;
      })
      .toSorted(byString);
    const schemaProperties = Object.keys(
      record(paramsSchema['properties'], 'params properties'),
    ).toSorted(byString);
    expect(descriptorNames).toEqual(schemaProperties);
  });
});
