import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { VERSION } from '../version.ts';
import { emitBindings, generateOpenApiDocument } from './openapi.ts';
import { createOperationRegistry } from './operation-catalog.ts';
import { defineOperation } from './operation-registry.ts';
import type { UnknownRestBinding } from './rest-bindings.ts';
import { DIRECT_HTTP_ROUTES, externalApiPath, toOpenApiPath, toRegex } from './route-model.ts';

describe('OpenAPI document generation', () => {
  const document = generateOpenApiDocument();

  it('/openapi.json is a full OpenAPI 3.1 contract for the REST-ish HTTP surface. It includes path and query parameters, request bodies, response schemas by status code, shared error objects, and security declarations.', () => {
    expect(document).toHaveProperty('openapi', '3.1.0');
    expect(document).toHaveProperty('info');
    expect(document).toHaveProperty('paths');
    expect(document).toHaveProperty('tags');

    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    expect(paths['/api/v1/workflows/{id}/signal/{name}']?.['post']?.['parameters']).toBeDefined();
    expect(paths['/api/v1/workflows']?.['post']).toHaveProperty('requestBody');

    const components = document['components'] as Record<string, unknown> | undefined;
    expect(
      document['security'] !== undefined || components?.['securitySchemes'] !== undefined,
    ).toBe(true);
  });

  it('emits operation bindings under /api/v1 and keeps root-stable direct routes unprefixed', () => {
    const paths = document['paths'] as Record<string, unknown>;
    const pathKeys = Object.keys(paths);

    // Every operation-backed REST binding is advertised under `/api`.
    expect(pathKeys).toContain('/api/v1/workflows');
    expect(pathKeys.some((key) => key.startsWith('/api/v1/'))).toBe(true);

    // Root-stable direct routes are NOT moved under `/api` (RFC 9264 /
    // observability convention). These probes must resolve at the origin root.
    // Note `/v1/metrics` (Prometheus, direct route, stays) is distinct from the
    // JSON metrics *operation* at `/v1/metrics/json`, which legitimately moves
    // to `/api/v1/metrics/json`; so we assert on the exact root-stable keys.
    expect(pathKeys).toContain('/v1/health');
    expect(pathKeys).toContain('/v1/metrics');
    expect(pathKeys).not.toContain('/api/v1/health');
    expect(pathKeys).not.toContain('/api/v1/metrics');

    // The externalApiPath guard prevents double-prefixing.
    expect(pathKeys.some((key) => key.startsWith('/api/api'))).toBe(false);
  });

  it('uses default title and version', () => {
    const info = document['info'] as Record<string, unknown>;
    expect(info['title']).toBe('Weft Workflow Engine');
    expect(info['version']).toBe(VERSION);
  });

  it('accepts custom options', () => {
    const custom = generateOpenApiDocument({
      title: 'Custom API',
      version: '2.0.0',
      serverUrl: 'https://api.example.com',
    });
    const info = custom['info'] as Record<string, unknown>;
    expect(info['title']).toBe('Custom API');
    expect(info['version']).toBe('2.0.0');
    const servers = custom['servers'] as Array<{ url: string }>;
    expect(servers[0]!.url).toBe('https://api.example.com');
  });

  it('includes all direct routes as path items', () => {
    const paths = document['paths'] as Record<string, unknown>;

    for (const route of DIRECT_HTTP_ROUTES) {
      const openApiPath = toOpenApiPath(route.path);
      expect(paths[openApiPath]).toBeDefined();

      const pathItem = paths[openApiPath] as Record<string, unknown>;
      const method = route.method.toLowerCase();
      expect(pathItem).toHaveProperty(method);
    }
  });

  it('correctly extracts path parameters', () => {
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const signalPath = paths['/api/v1/workflows/{id}/signal/{name}'];
    expect(signalPath).toBeDefined();

    const operation = signalPath!['post']!;
    const parameters = operation['parameters'] as Array<{ name: string; in: string }>;
    expect(parameters).toHaveLength(2);
    expect(parameters[0]!.name).toBe('id');
    expect(parameters[0]!.in).toBe('path');
    expect(parameters[1]!.name).toBe('name');
  });

  it('marks step parameter as integer type', () => {
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const checkpointPath = paths['/api/v1/workflows/{id}/checkpoints/{step}'];
    expect(checkpointPath).toBeDefined();

    const operation = checkpointPath!['get']!;
    const parameters = operation['parameters'] as Array<{
      name: string;
      schema: { type: string };
    }>;
    const stepParam = parameters.find((p) => p.name === 'step');
    expect(stepParam!.schema.type).toBe('integer');
  });

  it('marks replay step parameter as integer type', () => {
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const replayPath = paths['/api/v1/workflows/{id}/replay/{step}'];
    expect(replayPath).toBeDefined();

    const operation = replayPath!['get']!;
    const parameters = operation['parameters'] as Array<{
      name: string;
      schema: { type: string };
    }>;
    const stepParam = parameters.find((parameter) => parameter.name === 'step');
    expect(stepParam!.schema.type).toBe('integer');
  });

  it('includes tags sorted alphabetically', () => {
    const tags = document['tags'] as Array<{ name: string }>;
    expect(tags.length).toBeGreaterThan(0);
    const names = tags.map((t) => t.name);
    expect(names).toEqual([...names].toSorted());
  });

  it('adds requestBody for POST/PUT/PATCH routes', () => {
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const startPath = paths['/api/v1/workflows'];
    expect(startPath).toBeDefined();
    const operation = startPath!['post']!;
    expect(operation).toHaveProperty('requestBody');
  });

  it('does not add requestBody for POST bindings whose inputs come from the path only', () => {
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const pausePath = paths['/api/v1/schedules/{id}/pause'];
    expect(pausePath).toBeDefined();

    const operation = pausePath!['post']!;
    expect(operation).not.toHaveProperty('requestBody');
  });

  it('does not add requestBody for GET routes', () => {
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const healthPath = paths['/v1/health'];
    expect(healthPath).toBeDefined();
    const operation = healthPath!['get']!;
    expect(operation).not.toHaveProperty('requestBody');
  });

  it('documents direct public meta routes with their response media types and public security', () => {
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;

    const metricsOperation = paths['/v1/metrics']!['get']!;
    expect(metricsOperation['security']).toEqual([]);
    const metricsResponses = metricsOperation['responses'] as Record<
      string,
      Record<string, unknown>
    >;
    const metricsContent = metricsResponses['200']!['content'] as Record<string, unknown>;
    expect(metricsContent).toHaveProperty('text/plain');
    const metricsFailureContent = metricsResponses['503']!['content'] as Record<string, unknown>;
    expect(metricsFailureContent).toHaveProperty('application/json');

    const healthOperation = paths['/v1/health']!['get']!;
    const healthResponses = healthOperation['responses'] as Record<string, Record<string, unknown>>;
    const healthContent = healthResponses['200']!['content'] as Record<string, unknown>;
    expect(healthContent).toHaveProperty('application/json');
    expect(healthContent).toHaveProperty('application/msgpack');

    const catalogOperation = paths['/.well-known/api-catalog']!['get']!;
    expect(catalogOperation['security']).toEqual([]);
    const catalogResponses = catalogOperation['responses'] as Record<
      string,
      Record<string, unknown>
    >;
    const catalogContent = catalogResponses['200']!['content'] as Record<string, unknown>;
    expect(catalogContent).toHaveProperty('application/linkset+json');
    const catalogMisdirectedContent = catalogResponses['421']!['content'] as Record<
      string,
      unknown
    >;
    expect(catalogMisdirectedContent).toHaveProperty('application/json');
    const catalogUnavailableContent = catalogResponses['503']!['content'] as Record<
      string,
      unknown
    >;
    expect(catalogUnavailableContent).toHaveProperty('application/json');

    const mcpDiscoveryOperation = paths['/.well-known/mcp.json']!['get']!;
    expect(mcpDiscoveryOperation['security']).toEqual([]);
    const mcpDiscoveryResponses = mcpDiscoveryOperation['responses'] as Record<
      string,
      Record<string, unknown>
    >;
    const mcpDiscoveryContent = mcpDiscoveryResponses['200']!['content'] as Record<string, unknown>;
    expect(mcpDiscoveryContent).toHaveProperty('application/json');

    const asyncApiOperation = paths['/asyncapi.json']!['get']!;
    expect(asyncApiOperation['security']).toEqual([]);
    const asyncApiResponses = asyncApiOperation['responses'] as Record<
      string,
      Record<string, unknown>
    >;
    const asyncApiContent = asyncApiResponses['200']!['content'] as Record<string, unknown>;
    expect(asyncApiContent).toHaveProperty('application/json');
  });

  it('documents storage REST bindings with their non-JSON wire formats', () => {
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const storageItemPath = paths['/api/v1/storage/{key}'];
    const storageScanPath = paths['/api/v1/storage'];
    const storageBatchPath = paths['/api/v1/storage/-/batch'];
    const storageConditionalBatchPath = paths['/api/v1/storage/-/conditional-batch'];

    const getOperation = storageItemPath!['get']!;
    const getResponses = getOperation['responses'] as Record<string, Record<string, unknown>>;
    const getOkContent = getResponses['200']!['content'] as Record<string, unknown>;
    expect(getOkContent).toHaveProperty('application/octet-stream');
    expect(getResponses).toHaveProperty('404');

    const putOperation = storageItemPath!['put']!;
    const putRequestBody = putOperation['requestBody'] as Record<string, Record<string, unknown>>;
    const putContent = putRequestBody['content'] as Record<string, unknown>;
    expect(putContent).toHaveProperty('application/octet-stream');
    const putResponses = putOperation['responses'] as Record<string, unknown>;
    expect(putResponses).toHaveProperty('204');

    const scanOperation = storageScanPath!['get']!;
    const queryParameters = scanOperation['parameters'] as Array<{ in: string; name: string }>;
    expect(
      queryParameters
        .filter((parameter) => parameter.in === 'query')
        .map((parameter) => parameter.name),
    ).toEqual(['gt', 'gte', 'limit', 'lt', 'lte', 'prefix', 'reverse']);
    const scanResponses = scanOperation['responses'] as Record<string, Record<string, unknown>>;
    const scanOkContent = scanResponses['200']!['content'] as Record<string, unknown>;
    expect(scanOkContent).toHaveProperty('application/x-ndjson');

    const batchOperation = storageBatchPath!['post']!;
    const batchRequestBody = batchOperation['requestBody'] as Record<
      string,
      Record<string, unknown>
    >;
    const batchContent = batchRequestBody['content'] as Record<string, unknown>;
    expect(batchContent).toHaveProperty('application/json');
    const batchResponses = batchOperation['responses'] as Record<string, unknown>;
    expect(batchResponses).toHaveProperty('204');

    const conditionalBatchOperation = storageConditionalBatchPath!['post']!;
    const conditionalBatchResponses = conditionalBatchOperation['responses'] as Record<
      string,
      Record<string, unknown>
    >;
    const conditionalBatchOkContent = conditionalBatchResponses['200']!['content'] as Record<
      string,
      unknown
    >;
    expect(conditionalBatchOkContent).toHaveProperty('application/json');
  });
});

// Exercises `emitBindings` with a synthetic POST/PUT/PATCH binding so
// the body-emitting branch is covered before any production REST
// operation lives on that method. Without this, the first POST binding
// added to REST_BINDINGS would silently lose its `requestBody` entry.
describe('emitBindings — body-accepting methods', () => {
  for (const method of ['POST', 'PUT', 'PATCH'] as const) {
    it(`adds requestBody for ${method} bindings`, () => {
      const operation = defineOperation({
        name: 'weft.test.bodysuffix',
        mcpExposable: false,
        destructive: false,
        summary: 'body-accepting test op',
        inputSchema: z.object({ payload: z.unknown() }),
        outputSchema: z.unknown(),
        access: { kind: 'public' },
        transports: {
          http: true,
          jsonRpcHttp: false,
          jsonRpcWebSocket: false,
          jsonRpcStdio: false,
        },
        unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
        invoke: async () => ({}),
      });
      const binding: UnknownRestBinding = {
        method,
        path: '/v1/test/bodysuffix',
        pathParamNames: [],
        operationName: 'weft.test.bodysuffix',
        inputSources: { payload: { kind: 'body' } },
        extractInput: async (request) => ({ payload: await request.json() }),
        success: { kind: 'json', status: 200 },
      };
      const registry = createOperationRegistry([operation]);
      const paths: Record<string, Record<string, unknown>> = {};
      emitBindings(paths, new Set(), [binding], registry);

      const entry = paths['/api/v1/test/bodysuffix']?.[method.toLowerCase()] as
        | Record<string, unknown>
        | undefined;
      expect(entry).toBeDefined();
      expect(entry).toHaveProperty('requestBody');
    });
  }

  it('does not add requestBody for GET bindings', () => {
    const operation = defineOperation({
      name: 'weft.test.getread',
      mcpExposable: false,
      destructive: false,
      summary: 'get-only test op',
      inputSchema: z.object({ id: z.string() }),
      outputSchema: z.unknown(),
      access: { kind: 'public' },
      transports: { http: true, jsonRpcHttp: false, jsonRpcWebSocket: false, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
      invoke: async () => ({}),
    });
    const binding: UnknownRestBinding = {
      method: 'GET',
      path: '/v1/test/getread/:id',
      pathParamNames: ['id'],
      operationName: 'weft.test.getread',
      inputSources: { id: { kind: 'path', pathParam: 'id' } },
      extractInput: async (_request, pathParams) => ({ id: pathParams['id'] ?? '' }),
      success: { kind: 'json', status: 200 },
    };
    const registry = createOperationRegistry([operation]);
    const paths: Record<string, Record<string, unknown>> = {};
    emitBindings(paths, new Set(), [binding], registry);

    const entry = paths['/api/v1/test/getread/{id}']?.['get'] as
      | Record<string, unknown>
      | undefined;
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('requestBody');
  });

  it('keeps reserved direct routes documented when a non-discoverable binding also matches', () => {
    const operation = defineOperation({
      name: 'weft.test.hiddenhealth',
      mcpExposable: false,
      destructive: false,
      summary: 'hidden health binding',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      access: { kind: 'authenticated' },
      discoverable: false,
      transports: { http: true, jsonRpcHttp: false, jsonRpcWebSocket: false, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async () => ({ ok: true }),
    });
    const binding: UnknownRestBinding = {
      method: 'GET',
      path: '/v1/health',
      pathParamNames: [],
      operationName: 'weft.test.hiddenhealth',
      inputSources: {},
      extractInput: async () => ({}),
      success: { kind: 'json', status: 200 },
    };
    const document = generateOpenApiDocument({
      registry: createOperationRegistry([operation]),
      restBindings: [binding],
    });

    const reservedHealthRoute = (document['paths'] as Record<string, Record<string, unknown>>)[
      '/v1/health'
    ]?.['get'] as Record<string, unknown> | undefined;
    expect(reservedHealthRoute?.['operationId']).toBe('healthCheck');
  });

  it('keeps reserved direct route documentation ahead of discoverable binding collisions', () => {
    const operation = defineOperation({
      name: 'weft.test.visiblehealth',
      mcpExposable: false,
      destructive: false,
      summary: 'visible health binding',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      access: { kind: 'authenticated' },
      transports: { http: true, jsonRpcHttp: false, jsonRpcWebSocket: false, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async () => ({ ok: true }),
    });
    const binding: UnknownRestBinding = {
      method: 'GET',
      path: '/v1/health',
      pathParamNames: [],
      operationName: 'weft.test.visiblehealth',
      inputSources: {},
      extractInput: async () => ({}),
      success: { kind: 'json', status: 200 },
    };
    const document = generateOpenApiDocument({
      registry: createOperationRegistry([operation]),
      restBindings: [binding],
    });

    const reservedHealthRoute = (document['paths'] as Record<string, Record<string, unknown>>)[
      '/v1/health'
    ]?.['get'] as Record<string, unknown> | undefined;
    expect(reservedHealthRoute?.['operationId']).toBe('healthCheck');
    expect(reservedHealthRoute?.['security']).toEqual([]);
  });

  it('keeps the OpenAPI self-document reserved ahead of discoverable binding collisions', () => {
    const operation = defineOperation({
      name: 'weft.test.visibleopenapi',
      mcpExposable: false,
      destructive: false,
      summary: 'visible OpenAPI binding',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      access: { kind: 'authenticated' },
      transports: { http: true, jsonRpcHttp: false, jsonRpcWebSocket: false, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async () => ({ ok: true }),
    });
    const binding: UnknownRestBinding = {
      method: 'GET',
      path: '/openapi.json',
      pathParamNames: [],
      operationName: 'weft.test.visibleopenapi',
      inputSources: {},
      extractInput: async () => ({}),
      success: { kind: 'json', status: 200 },
    };
    const document = generateOpenApiDocument({
      registry: createOperationRegistry([operation]),
      restBindings: [binding],
    });

    const reservedOpenApiRoute = (document['paths'] as Record<string, Record<string, unknown>>)[
      '/openapi.json'
    ]?.['get'] as Record<string, unknown> | undefined;
    expect(reservedOpenApiRoute?.['operationId']).toBe('openApiDocument');
    expect(reservedOpenApiRoute?.['security']).toEqual([]);
  });

  it('treats output schemas with throwing safeParse implementations as non-nullable for octet-stream routes', () => {
    const operation = defineOperation({
      name: 'weft.storage.throwingoutput',
      mcpExposable: false,
      destructive: false,
      summary: 'throwing-output test op',
      inputSchema: z.object({ key: z.string() }),
      outputSchema: {
        safeParse() {
          throw new Error('unsafe output schema');
        },
      } as unknown as z.ZodType,
      access: { kind: 'public' },
      transports: { http: true, jsonRpcHttp: false, jsonRpcWebSocket: false, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async () => new Uint8Array(),
    });
    const binding: UnknownRestBinding = {
      method: 'GET',
      path: '/v1/test/throwingoutput/:key',
      pathParamNames: ['key'],
      operationName: 'weft.storage.throwingoutput',
      inputSources: { key: { kind: 'path', pathParam: 'key' } },
      extractInput: async (_request, pathParams) => ({ key: pathParams['key'] ?? '' }),
      success: { kind: 'streaming', mediaType: 'application/octet-stream' },
    };
    const registry = createOperationRegistry([operation]);
    const paths: Record<string, Record<string, unknown>> = {};
    emitBindings(paths, new Set(), [binding], registry);

    const pathItem = paths['/api/v1/test/throwingoutput/{key}'] as
      | Record<string, Record<string, unknown>>
      | undefined;
    const getOperation = pathItem?.['get'];
    const responses = getOperation?.['responses'] as Record<string, unknown>;
    expect(responses).toHaveProperty('200');
    expect(responses).not.toHaveProperty('404');
  });
});

describe('route-model helpers', () => {
  describe('externalApiPath', () => {
    it('adds the external API prefix to canonical root-relative paths', () => {
      expect(externalApiPath('/v1/workflows')).toBe('/api/v1/workflows');
      expect(externalApiPath('/mcp')).toBe('/api/mcp');
    });

    it('rejects paths without a leading slash', () => {
      expect(() => externalApiPath('v1/workflows')).toThrow(
        'externalApiPath requires a leading slash',
      );
    });

    it('rejects paths that are already externally prefixed', () => {
      expect(() => externalApiPath('/api/v1/workflows')).toThrow(
        'externalApiPath received an already-prefixed path',
      );
    });
  });

  describe('toOpenApiPath', () => {
    it('converts :param to {param}', () => {
      expect(toOpenApiPath('/v1/workflows/:id/signal/:name')).toBe(
        '/v1/workflows/{id}/signal/{name}',
      );
    });

    it('handles paths without parameters', () => {
      expect(toOpenApiPath('/v1/health')).toBe('/v1/health');
    });
  });

  describe('toRegex', () => {
    it('matches a path with parameters', () => {
      const regex = toRegex('/v1/workflows/:id/signal/:name');
      const match = regex.exec('/v1/workflows/abc/signal/done');
      expect(match).not.toBeNull();
      expect(match![1]).toBe('abc');
      expect(match![2]).toBe('done');
    });

    it('rejects non-matching paths', () => {
      const regex = toRegex('/v1/workflows/:id');
      expect(regex.exec('/v1/workflows/abc/extra')).toBeNull();
    });

    it('matches numeric :step parameter', () => {
      const regex = toRegex('/v1/workflows/:id/checkpoints/:step');
      expect(regex.exec('/v1/workflows/abc/checkpoints/42')).not.toBeNull();
      expect(regex.exec('/v1/workflows/abc/checkpoints/notanumber')).toBeNull();
    });

    it('matches paths without parameters', () => {
      const regex = toRegex('/v1/health');
      expect(regex.exec('/v1/health')).not.toBeNull();
      expect(regex.exec('/v1/health/extra')).toBeNull();
    });
  });
});

// MF5: Integration test that boots serve() with a JWT auth config, fetches
// /openapi.json, and asserts the document's security schemes match what the
// live server actually enforces.  A request without a Bearer token must be
// rejected (401), proving the document's bearerAuth claim is honest.
describe('OpenAPI security schemes — live server honesty', () => {
  it('serves /openapi.json with only the configured auth schemes for an api-key-only server', async () => {
    // Dynamic import to avoid pulling the full serve() dependency into every
    // openapi.test.ts import scope — the pattern matches authentication.test.ts.
    const { serve } = await import('./index.ts');

    const { Engine } = await import('../core/engine.ts');
    const { MemoryStorage } = await import('../storage/memory.ts');

    const engine = new Engine({ storage: new MemoryStorage() });
    const server = serve({
      engine,
      port: 0,
      auth: { apiKeys: ['test-key'] },
    });

    try {
      // 1. Fetch the OpenAPI document (unauthenticated — /openapi.json is
      //    explicitly a public meta-endpoint).
      const docResponse = await fetch(`${server.url}/openapi.json`);
      expect(docResponse.status).toBe(200);
      const doc = (await docResponse.json()) as Record<string, unknown>;

      // 2. The document must declare only the active API key scheme.
      const components = doc['components'] as Record<string, Record<string, unknown>> | undefined;
      const schemes = components?.['securitySchemes'];
      expect(schemes).toBeDefined();
      expect(schemes).toHaveProperty('apiKeyAuth');
      expect(schemes).not.toHaveProperty('bearerAuth');

      // 3. The document's top-level security array must reference only
      //    the configured API key scheme.
      const security = doc['security'] as Array<Record<string, unknown>> | undefined;
      expect(Array.isArray(security)).toBe(true);
      const schemeNames = (security ?? []).flatMap((entry) => Object.keys(entry));
      expect(schemeNames).toContain('apiKeyAuth');
      expect(schemeNames).not.toContain('bearerAuth');

      // 4. Verify the api-key-only claim is honest: a request to a
      //    protected endpoint WITHOUT credentials must be rejected with 401.
      const noAuthResponse = await fetch(`${server.url}/v1/workflows`, {
        headers: { accept: 'application/json' },
      });
      expect(noAuthResponse.status).toBe(401);

      // 5. A request WITH the valid API key passes through, proving apiKeyAuth
      //    is the active enforcement mechanism and the document is not lying.
      const authResponse = await fetch(`${server.url}/v1/workflows`, {
        headers: { 'x-api-key': 'test-key', accept: 'application/json' },
      });
      expect(authResponse.status).toBe(200);
    } finally {
      await server.stop();
      engine[Symbol.dispose]();
    }
  });
});
