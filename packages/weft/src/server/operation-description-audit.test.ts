/**
 * Guard for COR-1749: every discoverable operation in Weft's catalog, and
 * every parameter of it, carries a description that reaches OpenAPI and
 * OpenRPC. The helper under test is exported so another catalog runs the same
 * check over its own registry.
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { defineOperation, findUndescribedOperations } from "../embedded/backchannel/src/index.ts";
import {
  createOperationRegistry,
  generateOpenRpcDocument,
} from "../embedded/backchannel/src/internals.ts";
import { createLiveOperationRegistry } from './rest-bindings.ts';

function operation(options: {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: z.ZodObject;
  readonly access?: 'public' | 'scoped';
  readonly discoverable?: boolean;
}) {
  const inputSchema = options.inputSchema ?? z.object({ id: z.string().describe('The id.') });
  return defineOperation({
    name: options.name,
    mcpExposable: false,
    destructive: false,
    summary: 'summary',
    ...(options.description === undefined ? {} : { description: options.description }),
    inputSchema,
    outputSchema: z.object({ ok: z.boolean() }),
    access:
      options.access === 'scoped'
        ? { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['workflows:read'] } }
        : { kind: 'public' },
    ...(options.discoverable === undefined ? {} : { discoverable: options.discoverable }),
    transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async () => ({ ok: true }),
  });
}

describe('weft operation catalog descriptions', () => {
  it('describes every discoverable operation and each of its parameters', () => {
    expect(findUndescribedOperations(createLiveOperationRegistry())).toEqual([]);
  });

  it('puts each parameter description into the OpenRPC document', () => {
    const document = generateOpenRpcDocument({
      registry: createLiveOperationRegistry(),
      transports: ['http'],
    });
    const methods = document['methods'] as ReadonlyArray<{
      name: string;
      params: ReadonlyArray<{ name: string; schema: { description?: string } }>;
    }>;
    const get = methods.find((method) => method.name === 'weft.workflows.get');
    expect(get?.params.find((param) => param.name === 'workflowId')?.schema.description).toBe(
      'Id of the workflow whose state is read.',
    );
  });
});

describe('findUndescribedOperations', () => {
  it('reports an operation with no description', () => {
    const operations = [operation({ name: 'weft.test.nodescription' })];
    expect(findUndescribedOperations(operations)).toEqual([
      'weft.test.nodescription: missing description',
    ]);
  });

  it('reports a blank description as missing', () => {
    const operations = [operation({ name: 'weft.test.blank', description: '   ' })];
    expect(findUndescribedOperations(operations)).toEqual(['weft.test.blank: missing description']);
  });

  it('reports each parameter that lacks a description', () => {
    const operations = [
      operation({
        name: 'weft.test.parameters',
        description: 'Described.',
        inputSchema: z.object({
          described: z.string().describe('A described field.'),
          bare: z.string(),
          bareOptional: z.number().optional(),
        }),
      }),
    ];
    expect(findUndescribedOperations(operations)).toEqual([
      'weft.test.parameters: parameter "bare" missing description',
      'weft.test.parameters: parameter "bareOptional" missing description',
    ]);
  });

  it('accepts a description set before or after optional()', () => {
    const operations = [
      operation({
        name: 'weft.test.optional',
        description: 'Described.',
        inputSchema: z.object({
          before: z.string().describe('Before.').optional(),
          after: z.string().optional().describe('After.'),
        }),
      }),
    ];
    expect(findUndescribedOperations(operations)).toEqual([]);
  });

  it('requires describe() after nullable() for the text to reach the field', () => {
    const operations = [
      operation({
        name: 'weft.test.nullable',
        description: 'Described.',
        inputSchema: z.object({
          inside: z.string().describe('Inside.').nullable(),
          outside: z.string().nullable().describe('Outside.'),
        }),
      }),
    ];
    expect(findUndescribedOperations(operations)).toEqual([
      'weft.test.nullable: parameter "inside" missing description',
    ]);
  });

  it('accepts a described reused schema that is emitted as a reference', () => {
    const shared = z.string().describe('Shared id.');
    const operations = [
      operation({
        name: 'weft.test.reused',
        description: 'Described.',
        inputSchema: z.object({ first: shared, second: shared }),
      }),
    ];
    expect(findUndescribedOperations(operations)).toEqual([]);
  });

  it('accepts a parameter whose referenced definition carries the description', () => {
    const identifier = z.string().describe('Shared id.').meta({ id: 'SharedIdentifier' });
    const operations = [
      operation({
        name: 'weft.test.definition',
        description: 'Described.',
        inputSchema: z.object({ first: identifier, second: identifier }),
      }),
    ];
    expect(findUndescribedOperations(operations)).toEqual([]);
  });

  it('reports a parameter whose referenced definition has no description', () => {
    const identifier = z.string().meta({ id: 'BareIdentifier' });
    const operations = [
      operation({
        name: 'weft.test.baredefinition',
        description: 'Described.',
        inputSchema: z.object({ id: identifier }),
      }),
    ];
    expect(findUndescribedOperations(operations)).toEqual([
      'weft.test.baredefinition: parameter "id" missing description',
    ]);
  });

  it('reports a parameter that refers back to the root schema', () => {
    type Node = { readonly child?: Node | undefined };
    const node: z.ZodType<Node> = z.object({ child: z.lazy(() => node).optional() });
    const operations = [
      operation({
        name: 'weft.test.recursive',
        description: 'Described.',
        inputSchema: z.object({ root: node }),
      }),
    ];
    expect(findUndescribedOperations(operations)).toEqual([
      'weft.test.recursive: parameter "root" missing description',
    ]);
  });

  it('skips an operation that discovery does not list', () => {
    const operations = [
      operation({
        name: 'weft.test.hidden',
        access: 'scoped',
        inputSchema: z.object({ id: z.string() }),
      }),
    ];
    expect(findUndescribedOperations(operations)).toEqual([]);
  });

  it('audits a non-public operation that opts into discovery', () => {
    const operations = [
      operation({
        name: 'weft.test.optin',
        access: 'scoped',
        discoverable: true,
        inputSchema: z.object({ id: z.string() }),
      }),
    ];
    expect(findUndescribedOperations(operations)).toEqual([
      'weft.test.optin: missing description',
      'weft.test.optin: parameter "id" missing description',
    ]);
  });

  it('accepts a registry as well as a list of operations', () => {
    const registry = createOperationRegistry([operation({ name: 'weft.test.registry' })]);
    expect(findUndescribedOperations(registry)).toEqual([
      'weft.test.registry: missing description',
    ]);
  });
});
