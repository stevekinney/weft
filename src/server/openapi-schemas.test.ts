import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { StandardJSONSchemaV1 } from '../core/types/definition-schema.ts';
import { extractComponentsSchemas } from './openapi-schemas.ts';
import {
  createOperationRegistry,
  type ErasedOperation,
  type OperationRegistry,
  type RegistrableOperation,
} from './operation-catalog.ts';
import { defineOperation } from './operation-registry.ts';

function makeOperation(options: {
  readonly name: string;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly eventSchema?: z.ZodType;
}): RegistrableOperation {
  // The discriminated union on `defineOperation` requires `eventSchema`
  // to coexist with `kind: 'stream' | 'subscription'`. Operations declaring
  // an eventSchema are streaming by construction; the test factory makes
  // that explicit so the type system narrows correctly.
  if (options.eventSchema !== undefined) {
    return defineOperation({
      name: options.name,
      mcpExposable: false,
      destructive: false,
      kind: 'stream',
      summary: 'test operation',
      tags: ['Tests'],
      inputSchema: options.inputSchema,
      outputSchema: options.outputSchema,
      eventSchema: options.eventSchema,
      access: { kind: 'public' },
      transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async () => {
        async function* iter() {}
        return iter();
      },
    });
  }
  return defineOperation({
    name: options.name,
    mcpExposable: false,
    destructive: false,
    summary: 'test operation',
    tags: ['Tests'],
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
    access: { kind: 'public' },
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    invoke: async () => ({}),
  });
}

function eraseOperation(operation: RegistrableOperation): ErasedOperation {
  const registry = createOperationRegistry([operation]);
  const erasedOperation = registry.get(operation.name);
  if (erasedOperation === undefined) {
    throw new Error(`operation was not registered: ${operation.name}`);
  }
  return erasedOperation;
}

function isReference(value: unknown): value is { readonly $ref: string } {
  return value !== null && typeof value === 'object' && '$ref' in value;
}

function makeDirectionalSchema(
  vendor: string,
  inputShape: Record<string, unknown>,
  outputShape: Record<string, unknown>,
): StandardJSONSchemaV1 {
  return {
    '~standard': {
      version: 1,
      vendor,
      jsonSchema: {
        input: () => inputShape,
        output: () => outputShape,
      },
    },
  };
}

describe('extractComponentsSchemas', () => {
  it('hoists duplicate schemas to one component and returns refs for both owners', () => {
    const registry = createOperationRegistry([
      makeOperation({
        name: 'weft.alpha.one',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ firstResult: z.string() }),
      }),
      makeOperation({
        name: 'weft.beta.two',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ secondResult: z.string() }),
      }),
    ]);

    const helper = extractComponentsSchemas(registry);

    expect(Object.keys(helper.components)).toEqual(['WeftAlphaOneInput']);
    expect(helper.refFor('weft.alpha.one', 'Input')).toEqual({
      $ref: '#/components/schemas/WeftAlphaOneInput',
    });
    expect(helper.refFor('weft.beta.two', 'Input')).toEqual({
      $ref: '#/components/schemas/WeftAlphaOneInput',
    });
  });

  it('returns inline schemas for single-use schemas', () => {
    const registry = createOperationRegistry([
      makeOperation({
        name: 'weft.single.use',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ ok: z.boolean() }),
      }),
    ]);

    const helper = extractComponentsSchemas(registry);
    const inputSchema = helper.refFor('weft.single.use', 'Input');

    expect(helper.components).toEqual({});
    expect(isReference(inputSchema)).toBe(false);
    expect(inputSchema).toEqual(
      expect.objectContaining({
        type: 'object',
        properties: expect.objectContaining({
          id: expect.objectContaining({ type: 'string' }),
        }),
      }),
    );
  });

  it('generates byte-identical components across repeated extraction', () => {
    const registry = createOperationRegistry([
      makeOperation({
        name: 'weft.alpha.one',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ firstResult: z.string() }),
      }),
      makeOperation({
        name: 'weft.beta.two',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ secondResult: z.string() }),
      }),
    ]);

    const first = extractComponentsSchemas(registry);
    const second = extractComponentsSchemas(registry);

    expect(JSON.stringify(first.components)).toBe(JSON.stringify(second.components));
  });

  it('handles event schemas when present', () => {
    const eventSchema = z.object({ sequence: z.number(), value: z.string() });
    const registry = createOperationRegistry([
      makeOperation({
        name: 'weft.events.alpha',
        inputSchema: z.object({ alpha: z.string() }),
        outputSchema: z.object({ alphaStarted: z.boolean() }),
        eventSchema,
      }),
      makeOperation({
        name: 'weft.events.beta',
        inputSchema: z.object({ beta: z.string() }),
        outputSchema: z.object({ betaStarted: z.boolean() }),
        eventSchema,
      }),
    ]);

    const helper = extractComponentsSchemas(registry);

    expect(helper.components).toHaveProperty('WeftEventsAlphaEvent');
    expect(helper.refFor('weft.events.alpha', 'Event')).toEqual({
      $ref: '#/components/schemas/WeftEventsAlphaEvent',
    });
    expect(helper.refFor('weft.events.beta', 'Event')).toEqual({
      $ref: '#/components/schemas/WeftEventsAlphaEvent',
    });
  });

  it('uses output-direction JSON Schema for Output and Event slots', () => {
    const outputSchema = makeDirectionalSchema(
      'output-slot-test',
      { type: 'object', properties: { accepted: { type: 'boolean' } } },
      { type: 'string' },
    );
    const eventSchema = makeDirectionalSchema(
      'event-slot-test',
      { type: 'object', properties: { sequence: { type: 'number' } } },
      { type: 'integer' },
    );
    const registry = createOperationRegistry([
      makeOperation({
        name: 'weft.directional.stream',
        inputSchema: z.object({ id: z.string() }),
        outputSchema: outputSchema as unknown as z.ZodType,
        eventSchema: eventSchema as unknown as z.ZodType,
      }),
    ]);

    const helper = extractComponentsSchemas(registry);

    expect(helper.refFor('weft.directional.stream', 'Output')).toEqual({ type: 'string' });
    expect(helper.refFor('weft.directional.stream', 'Event')).toEqual({ type: 'integer' });
  });

  it('suffixes colliding component names when different duplicate groups share one base name', () => {
    const alphaSchema = z.object({ alphaId: z.string() });
    const betaSchema = z.object({ betaId: z.number() });
    const operations = [
      eraseOperation(
        makeOperation({
          name: 'weft.alpha.one',
          inputSchema: alphaSchema,
          outputSchema: z.object({ ok: z.boolean() }),
        }),
      ),
      eraseOperation(
        makeOperation({
          name: 'weft.alpha.one',
          inputSchema: z.object({ singleUse: z.boolean() }),
          outputSchema: alphaSchema,
        }),
      ),
      eraseOperation(
        makeOperation({
          name: 'weft.alpha.one',
          inputSchema: betaSchema,
          outputSchema: z.object({ other: z.boolean() }),
        }),
      ),
      eraseOperation(
        makeOperation({
          name: 'weft.alpha.one',
          inputSchema: z.object({ differentSingleUse: z.boolean() }),
          outputSchema: betaSchema,
        }),
      ),
    ];
    // The helper accepts the registry interface directly, so keep this guard
    // covered against custom registries that return colliding owner names.
    const registry: OperationRegistry = {
      get() {
        return undefined;
      },
      list() {
        return operations;
      },
    };

    const helper = extractComponentsSchemas(registry);

    expect(Object.keys(helper.components).toSorted()).toEqual([
      'WeftAlphaOneInput',
      'WeftAlphaOneInput_2',
    ]);
    expect(helper.components['WeftAlphaOneInput']).toEqual({
      additionalProperties: false,
      properties: { alphaId: { type: 'string' } },
      required: ['alphaId'],
      type: 'object',
    });
    expect(helper.components['WeftAlphaOneInput_2']).toEqual({
      additionalProperties: false,
      properties: { betaId: { type: 'number' } },
      required: ['betaId'],
      type: 'object',
    });
  });
});
