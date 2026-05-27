import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { Engine } from '../core/engine.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { serve, type WeftServer } from './index.ts';
import { generateOpenApiDocument } from './openapi.ts';
import { createOperationRegistry } from './operation-catalog.ts';
import { defineOperation } from './operation-registry.ts';

describe('OpenAPI hydration', () => {
  const servers: WeftServer[] = [];
  const engines: Engine[] = [];

  afterEach(async () => {
    while (servers.length > 0) await servers.pop()?.stop();
    while (engines.length > 0) engines.pop()?.[Symbol.dispose]();
  });

  it('requestBody for weft.workflows.start has real schema instead of the old stub', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engines.push(engine);
    const server = serve({ engine, port: 0 });
    servers.push(server);

    const response = await fetch(`${server.url}/openapi.json`);
    expect(response.status).toBe(200);
    const document = (await response.json()) as Record<string, unknown>;

    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const startOperation = paths['/api/v1/workflows']?.['post'];
    expect(startOperation).toBeDefined();
    const requestBody = startOperation!['requestBody'] as Record<string, unknown>;
    const content = requestBody['content'] as Record<string, Record<string, unknown>>;
    const schema = content['application/json']?.['schema'];

    expect(schema).not.toEqual({ type: 'object' });
    expect(schema !== null && typeof schema === 'object').toBe(true);
    expect('$ref' in (schema as object) || 'properties' in (schema as object)).toBe(true);
  });

  it('responses include universal-default error codes for every cataloged operation', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engines.push(engine);
    const server = serve({ engine, port: 0 });
    servers.push(server);

    const response = await fetch(`${server.url}/openapi.json`);
    const document = (await response.json()) as Record<string, unknown>;
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const universalStatuses = ['400', '401', '403', '500'];

    for (const [path, pathItem] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (typeof operation['operationId'] !== 'string') continue;
        if (!operation['operationId'].startsWith('weft.')) continue;

        const responses = operation['responses'] as Record<string, unknown> | undefined;
        expect(responses).toBeDefined();
        for (const status of universalStatuses) {
          expect(
            responses,
            `Path ${path} method ${method} missing status ${status}`,
          ).toHaveProperty(status);
        }
      }
    }
  });

  it('components.schemas has Error schema', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engines.push(engine);
    const server = serve({ engine, port: 0 });
    servers.push(server);

    const response = await fetch(`${server.url}/openapi.json`);
    const document = (await response.json()) as Record<string, unknown>;
    const components = document['components'] as Record<string, unknown> | undefined;
    const schemas = components?.['schemas'] as Record<string, unknown> | undefined;

    expect(schemas).toBeDefined();
    expect(schemas).toHaveProperty('Error');
  });

  it('streaming bindings document text/event-stream, not application/json', async () => {
    // Bugbot regression: every binding's 200 response was hardcoded to
    // `application/json`. SSE bindings declare
    // `success: { kind: 'streaming', mediaType: 'text/event-stream' }`
    // and that media type must surface in the OpenAPI document so
    // generated clients don't try to parse the SSE stream as JSON.
    const engine = new Engine({ storage: new MemoryStorage() });
    engines.push(engine);
    const server = serve({ engine, port: 0 });
    servers.push(server);

    const response = await fetch(`${server.url}/openapi.json`);
    const document = (await response.json()) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };

    const sseGet = document.paths['/api/v1/workflows/{id}/sse']?.['get'];
    expect(sseGet).toBeDefined();
    const sseResponses = sseGet!['responses'] as Record<string, Record<string, unknown>>;
    const sseSuccess = sseResponses['200'] as { content: Record<string, unknown> };
    expect(sseSuccess.content).toHaveProperty('text/event-stream');
    expect(sseSuccess.content).not.toHaveProperty('application/json');
  });

  it('document is deterministic across two generations', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engines.push(engine);
    const server = serve({ engine, port: 0 });
    servers.push(server);

    const firstResponse = await fetch(`${server.url}/openapi.json`);
    const secondResponse = await fetch(`${server.url}/openapi.json`);

    expect(await firstResponse.text()).toBe(await secondResponse.text());
  });

  it('weft.workflows.start POST body matches a hand-authored expected fragment', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    engines.push(engine);
    const server = serve({ engine, port: 0 });
    servers.push(server);

    const response = await fetch(`${server.url}/openapi.json`);
    const document = (await response.json()) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components?: { schemas?: Record<string, unknown> };
    };

    const startOperation = document.paths['/api/v1/workflows']?.['post'];
    expect(startOperation).toBeDefined();

    // The operation ID, summary, and tags are stable contract surface.
    expect(startOperation!['operationId']).toBe('weft.workflows.start');
    expect(startOperation!['summary']).toBe('Start a new workflow');
    expect(startOperation!['tags']).toEqual(['Workflows']);

    // Inspect requestBody's resolved schema (either inline or via $ref).
    const requestBody = startOperation!['requestBody'] as {
      content: { 'application/json': { schema: Record<string, unknown> } };
    };
    const inlineOrRef = requestBody.content['application/json'].schema;
    const resolvedSchema =
      typeof inlineOrRef['$ref'] === 'string'
        ? resolveRef(document, inlineOrRef['$ref'])
        : inlineOrRef;

    // The schema must be an object describing the start-workflow params.
    expect(resolvedSchema['type']).toBe('object');
    const properties = resolvedSchema['properties'] as Record<string, unknown>;

    // weft.workflows.start declares 7 input fields. Verify every one is
    // present — the snapshot guards against silent schema regression.
    for (const expected of [
      'type',
      'input',
      'id',
      'executionTimeout',
      'startAt',
      'startAfter',
      'tags',
    ]) {
      expect(properties).toHaveProperty(expected);
    }

    // Responses cover the universal-default fault set + any operation-
    // specific producibleFaults. start-workflow declares Conflict (409)
    // explicitly.
    const responses = startOperation!['responses'] as Record<string, unknown>;
    for (const status of ['400', '401', '403', '409', '500']) {
      expect(responses, `weft.workflows.start missing status ${status}`).toHaveProperty(status);
    }
  });

  it('discovery filter excludes private operations while including their public siblings', () => {
    // Two operations + two REST bindings drive the generator. The public
    // operation MUST appear in the document; the private one MUST NOT.
    // This exercises the filter directly — an `restBindings: []` test
    // would be vacuously true because no paths are emitted at all.
    const publicOperation = defineOperation({
      name: 'weft.test.publicoperation',
      summary: 'public fixture',
      mcpExposable: false,
      destructive: false,
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      access: { kind: 'public' },
      transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
      unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
      invoke: async () => ({ ok: true }),
    });
    const privateOperation = defineOperation({
      name: 'weft.test.privateoperation',
      summary: 'private fixture',
      mcpExposable: false,
      destructive: false,
      inputSchema: z.object({ secret: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      access: { kind: 'authenticated' },
      transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
      unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
      // discoverable defaults to false; without it (and without public access)
      // the filter must hide this operation from /openapi.json.
      invoke: async () => ({ ok: true }),
    });

    const registry = createOperationRegistry([publicOperation, privateOperation]);
    const restBindings = [
      {
        method: 'POST' as const,
        path: '/v1/test/public',
        pathParamNames: [] as readonly string[],
        operationName: 'weft.test.publicoperation',
        inputSources: { value: { kind: 'body-field' as const, bodyField: 'value' } },
        extractInput: async (request: Request) => ({
          value: ((await request.json()) as Record<string, unknown>)['value'],
        }),
        success: { kind: 'json' as const, status: 200 },
      },
      {
        method: 'POST' as const,
        path: '/v1/test/private',
        pathParamNames: [] as readonly string[],
        operationName: 'weft.test.privateoperation',
        inputSources: { secret: { kind: 'body-field' as const, bodyField: 'secret' } },
        extractInput: async (request: Request) => ({
          secret: ((await request.json()) as Record<string, unknown>)['secret'],
        }),
        success: { kind: 'json' as const, status: 200 },
      },
    ];

    const document = generateOpenApiDocument({ registry, restBindings });
    const paths = (document['paths'] as Record<string, unknown>) ?? {};

    // The document must contain the PUBLIC binding (proving it isn't
    // empty due to a different filter or bug) and must NOT contain the
    // PRIVATE binding (proving the filter actually excludes it).
    let sawPublic = false;
    for (const pathItem of Object.values(paths)) {
      const item = pathItem as Record<string, Record<string, unknown>>;
      for (const operation of Object.values(item)) {
        if (operation['operationId'] === 'weft.test.publicoperation') {
          sawPublic = true;
        }
        expect(operation['operationId']).not.toBe('weft.test.privateoperation');
      }
    }
    expect(sawPublic).toBe(true);
  });
});

function resolveRef(
  document: { components?: { schemas?: Record<string, unknown> } },
  ref: string,
): Record<string, unknown> {
  const match = /^#\/components\/schemas\/(.+)$/.exec(ref);
  if (!match) throw new Error(`unexpected $ref shape: ${ref}`);
  const name = match[1] as string;
  const target = document.components?.schemas?.[name];
  if (target === undefined) throw new Error(`no such component schema: ${name}`);
  return target as Record<string, unknown>;
}
