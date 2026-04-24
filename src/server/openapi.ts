/**
 * OpenAPI 3.1 document generator driven from the shared route model.
 *
 * Produces a JSON-serializable OpenAPI document that reflects the exact
 * routes registered in `route-model.ts`. Both `handleRequest()` and
 * `serve()` expose this at `GET /openapi.json`.
 *
 * @module server/openapi
 */

import { createLiveOperationRegistry, REST_BINDINGS } from './rest-bindings.ts';
import { ROUTES, toOpenApiPath } from './route-model.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for customizing the generated OpenAPI document. */
export type OpenApiOptions = {
  /** API title. Defaults to `'Weft Workflow Engine'`. */
  title?: string;
  /** API version. Defaults to `'0.0.1'`. */
  version?: string;
  /** Server URL. When omitted, no `servers` array is included. */
  serverUrl?: string;
};

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/**
 * Generate an OpenAPI 3.1 JSON document from the shared route definitions.
 *
 * Each route in `ROUTES` becomes a path item with the appropriate HTTP
 * method, summary, tags, and path parameters.
 */
function buildPathParameters(paramNames: readonly string[]): Array<Record<string, unknown>> {
  return paramNames.map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: name === 'step' ? 'integer' : 'string' },
  }));
}

function emitBindings(
  paths: Record<string, Record<string, unknown>>,
  tagSet: Set<string>,
): Set<string> {
  const registry = createLiveOperationRegistry();
  const boundMethodPaths = new Set<string>();
  for (const binding of REST_BINDINGS) {
    const operation = registry.get(binding.operationName);
    if (operation === undefined) continue;
    const openApiPath = toOpenApiPath(binding.path);
    boundMethodPaths.add(`${binding.method} ${openApiPath}`);
    if (!paths[openApiPath]) paths[openApiPath] = {};

    const parameters = buildPathParameters(binding.pathParamNames);
    const entry: Record<string, unknown> = {
      summary: operation.summary,
      operationId: operation.name,
      tags: operation.tags,
      responses: { '200': { description: 'Successful response' } },
    };
    if (parameters.length > 0) entry['parameters'] = parameters;

    paths[openApiPath][binding.method.toLowerCase()] = entry;
    for (const tag of operation.tags) tagSet.add(tag);
  }
  return boundMethodPaths;
}

function emitRoutes(
  paths: Record<string, Record<string, unknown>>,
  tagSet: Set<string>,
  boundMethodPaths: Set<string>,
): void {
  for (const route of ROUTES) {
    if (route.handler === 'openApiDocument') continue;
    const openApiPath = toOpenApiPath(route.path);
    if (boundMethodPaths.has(`${route.method} ${openApiPath}`)) continue;
    if (!paths[openApiPath]) paths[openApiPath] = {};

    const parameters = buildPathParameters(route.paramNames);
    const entry: Record<string, unknown> = {
      summary: route.summary,
      operationId: route.handler,
      tags: route.tags,
      responses: { '200': { description: 'Successful response' } },
    };
    if (parameters.length > 0) entry['parameters'] = parameters;

    if (route.method === 'POST' || route.method === 'PUT' || route.method === 'PATCH') {
      entry['requestBody'] = {
        content: { 'application/json': { schema: { type: 'object' } } },
      };
    }

    paths[openApiPath][route.method.toLowerCase()] = entry;
    for (const tag of route.tags) tagSet.add(tag);
  }
}

export function generateOpenApiDocument(options?: OpenApiOptions): Record<string, unknown> {
  const title = options?.title ?? 'Weft Workflow Engine';
  const version = options?.version ?? '0.0.1';

  const paths: Record<string, Record<string, unknown>> = {};
  const tagSet = new Set<string>();

  // REST_BINDINGS win against any stale ROUTES entry covering the same
  // (method, path) — a migrated operation owns its OpenAPI description.
  const boundMethodPaths = emitBindings(paths, tagSet);
  emitRoutes(paths, tagSet, boundMethodPaths);

  const tags = [...tagSet].toSorted().map((name) => ({ name }));

  const document: Record<string, unknown> = {
    openapi: '3.1.0',
    info: { title, version },
    paths,
    tags,
  };

  if (options?.serverUrl) {
    document['servers'] = [{ url: options.serverUrl }];
  }

  return document;
}
