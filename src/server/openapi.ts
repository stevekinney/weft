/**
 * OpenAPI 3.1 document generator driven from the operation and direct-route
 * models.
 *
 * Produces a JSON-serializable OpenAPI document for the REST-ish HTTP
 * surface. Both `handleRequest()` and `serve()` expose this at
 * `GET /openapi.json`. Every operation-catalog binding carries the canonical
 * `x-weft-access` metadata and, when applicable,
 * `x-weft-parameterizedAccess`; direct infrastructure routes do not.
 *
 * @module server/openapi
 */

import { definitionSchemaToJsonSchema } from '../core/types/definition-schema-to-json.ts';
import { VERSION } from '../version.ts';
import { serializeAccessPolicy, serializeParameterizedAccess } from './access-policy-metadata.ts';
import { isDiscoverable } from './discovery-filter.ts';
import { applyDiscoveryInfo, type DiscoveryInfo } from './discovery-info.ts';
import { asPlainObject, compareStrings } from './json-schema-utilities.ts';
import { buildErrorResponses, ERROR_SCHEMA } from './openapi-error-responses.ts';
import { extractComponentsSchemas, type OpenApiSchemaHelper } from './openapi-schemas.ts';
import type { ErasedOperation, OperationRegistry } from './operation-catalog.ts';
import type { ParamSource } from './rest-binding.ts';
import type { UnknownRestBinding } from './rest-bindings.ts';
import { createLiveOperationRegistry, createLiveRestBindings } from './rest-bindings.ts';
import {
  DIRECT_HTTP_ROUTES,
  externalApiPath,
  toOpenApiPath,
  type DirectHttpRouteDefinition,
  type DirectRouteResponseContent,
} from './route-model.ts';

export type OpenApiSecuritySchemeName = 'bearerAuth' | 'apiKeyAuth';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for customizing the generated OpenAPI document. */
export type OpenApiOptions = {
  /** API title. Defaults to `'Weft Workflow Engine'`. */
  title?: string;
  /** API version. Defaults to the current Weft package version. */
  version?: string;
  /** Operator-supplied discovery metadata applied to the generated document. */
  discoveryInfo?: DiscoveryInfo;
  /** Operation registry used to emit operation-backed REST bindings. */
  registry?: OperationRegistry;
  /**
   * REST bindings used to emit OpenAPI path items. Defaults to
   * `createLiveRestBindings()`. Servers that override their binding set
   * (e.g. for a restricted subset) should pass the same set here so
   * `/openapi.json` matches the live HTTP surface.
   */
  restBindings?: ReadonlyArray<UnknownRestBinding>;
  /** Server URL. When omitted, no `servers` array is included. */
  serverUrl?: string;
  /**
   * Security schemes the live server actually supports. When omitted,
   * emit both current API-key scheme names so generated clients can choose
   * either header-oriented convention.
   */
  supportedSchemes?: ReadonlySet<OpenApiSecuritySchemeName>;
};

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

type OpenApiSchema = Record<string, unknown>;

const DEFAULT_SCHEMA_HELPER: OpenApiSchemaHelper = {
  components: {},
  refFor() {
    return undefined;
  },
};
const JSON_MEDIA_TYPE = 'application/json';
const OCTET_STREAM_MEDIA_TYPE = 'application/octet-stream';

/** Build path parameter metadata for an Express-style route pattern. */
function buildPathParameters(paramNames: readonly string[]): Array<Record<string, unknown>> {
  return paramNames.map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: name === 'step' ? 'integer' : 'string' },
  }));
}

function inputSourceEntries(binding: UnknownRestBinding): Array<[string, ParamSource]> {
  return Object.entries(binding.inputSources)
    .filter((entry): entry is [string, ParamSource] => entry[1] !== undefined)
    .toSorted(([left], [right]) => compareStrings(left, right));
}

function inputJsonSchema(operation: ErasedOperation): OpenApiSchema {
  return definitionSchemaToJsonSchema(operation.inputSchema);
}

function fieldSchema(operation: ErasedOperation, field: string): OpenApiSchema {
  const properties = asPlainObject(inputJsonSchema(operation)['properties']);
  return asPlainObject(properties[field]);
}

function requiredInputFields(operation: ErasedOperation): Set<string> {
  const required = inputJsonSchema(operation)['required'];
  if (!Array.isArray(required)) return new Set();
  return new Set(required.filter((entry): entry is string => typeof entry === 'string'));
}

function binaryBodySchema(): OpenApiSchema {
  return { type: 'string', format: 'binary' };
}

function streamingResponseSchema(mediaType: string): OpenApiSchema {
  if (mediaType === OCTET_STREAM_MEDIA_TYPE) return binaryBodySchema();
  return { type: 'string' };
}

function directRouteContentSchema(content: DirectRouteResponseContent): OpenApiSchema {
  if (content.schema === 'string') return { type: 'string' };
  return { type: 'object' };
}

function outputCanBeNull(operation: ErasedOperation): boolean {
  try {
    return operation.outputSchema.safeParse(null).success;
  } catch {
    return false;
  }
}

function buildBindingParameters(
  binding: UnknownRestBinding,
  operation: ErasedOperation,
): Array<Record<string, unknown>> {
  const parameters = buildPathParameters(binding.pathParamNames);
  const seen = new Set(
    parameters.map((parameter) => `${String(parameter['in'])}:${String(parameter['name'])}`),
  );

  for (const [field, source] of inputSourceEntries(binding)) {
    if (source.kind !== 'query' && source.kind !== 'header') continue;
    const parameter = {
      name: source.kind === 'query' ? source.queryParam : source.headerName,
      in: source.kind,
      required: false,
      schema: fieldSchema(operation, field),
    };
    const key = `${parameter.in}:${parameter.name}`;
    if (seen.has(key)) continue;
    parameters.push(parameter);
    seen.add(key);
  }

  return parameters;
}

function buildRequestBodyFromInputSources(
  binding: UnknownRestBinding,
  operation: ErasedOperation,
): Record<string, unknown> | undefined {
  const entries = inputSourceEntries(binding);
  const bodyEntry = entries.find((entry) => entry[1].kind === 'body');
  if (bodyEntry !== undefined) {
    const [field, source] = bodyEntry;
    if (source.kind !== 'body') return undefined;
    const mediaType = source.mediaType ?? JSON_MEDIA_TYPE;
    const schema =
      mediaType === OCTET_STREAM_MEDIA_TYPE ? binaryBodySchema() : fieldSchema(operation, field);
    return {
      required: true,
      content: { [mediaType]: { schema } },
    };
  }

  const bodyFieldEntries = entries.filter(
    (entry): entry is [string, Extract<ParamSource, { kind: 'body-field' }>] =>
      entry[1].kind === 'body-field',
  );
  if (bodyFieldEntries.length === 0) return undefined;

  const requiredFields = requiredInputFields(operation);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [field, source] of bodyFieldEntries) {
    properties[source.bodyField] = fieldSchema(operation, field);
    if (requiredFields.has(field)) required.push(source.bodyField);
  }

  const schema: OpenApiSchema = {
    type: 'object',
    properties,
    additionalProperties: operation.unknownKeyPolicy.http !== 'reject',
  };
  if (required.length > 0) schema['required'] = required.toSorted(compareStrings);

  return {
    required: true,
    content: { [JSON_MEDIA_TYPE]: { schema } },
  };
}

function buildRequestBody(
  binding: UnknownRestBinding,
  operation: ErasedOperation,
  schemaHelper: OpenApiSchemaHelper,
): Record<string, unknown> | undefined {
  const requestBody = buildRequestBodyFromInputSources(binding, operation);
  if (requestBody !== undefined) return requestBody;
  if (inputSourceEntries(binding).length > 0) return undefined;
  if (binding.method !== 'POST' && binding.method !== 'PUT' && binding.method !== 'PATCH') {
    return undefined;
  }

  return {
    content: {
      [JSON_MEDIA_TYPE]: {
        schema: schemaHelper.refFor(operation.name, 'Input') ?? { type: 'object' },
      },
    },
  };
}

/**
 * Build the success-response object for a binding, branching on its
 * declared `success.kind`. JSON bindings emit `application/json` with
 * the operation's output schema. Streaming bindings emit the binding's
 * declared `mediaType` and document the payload as either binary or a
 * string. Empty (204) bindings emit a no-content response.
 */
function buildSuccessResponse(
  binding: UnknownRestBinding,
  operation: ErasedOperation,
  schemaHelper: OpenApiSchemaHelper,
): Record<string, unknown> {
  const success = binding.success;
  if (success.kind === 'empty') {
    return {
      [String(success.status)]: {
        description: 'No content',
      },
    };
  }
  if (success.kind === 'streaming') {
    const responses: Record<string, unknown> = {
      '200': {
        description: 'Streaming response',
        content: {
          [success.mediaType]: {
            schema: streamingResponseSchema(success.mediaType),
          },
        },
      },
    };
    if (success.mediaType === OCTET_STREAM_MEDIA_TYPE && outputCanBeNull(operation)) {
      responses['404'] = { description: 'Storage key not found' };
    }
    return responses;
  }
  return {
    [String(success.status)]: {
      description: 'Successful response',
      content: {
        [JSON_MEDIA_TYPE]: {
          schema: schemaHelper.refFor(operation.name, 'Output') ?? { type: 'object' },
        },
      },
    },
  };
}

/**
 * Emit REST bindings into the OpenAPI paths map. Exported for tests;
 * `generateOpenApiDocument` is the production entry point.
 *
 * @internal
 */
export function emitBindings(
  paths: Record<string, Record<string, unknown>>,
  tagSet: Set<string>,
  bindings: ReadonlyArray<UnknownRestBinding> = createLiveRestBindings(),
  registry: OperationRegistry = createLiveOperationRegistry(),
  schemaHelper: OpenApiSchemaHelper = DEFAULT_SCHEMA_HELPER,
): void {
  for (const binding of bindings) {
    tryRegisterBinding(paths, tagSet, binding, registry, schemaHelper);
  }
}

function tryRegisterBinding(
  paths: Record<string, Record<string, unknown>>,
  tagSet: Set<string>,
  binding: UnknownRestBinding,
  registry: OperationRegistry,
  schemaHelper: OpenApiSchemaHelper,
): void {
  const operation: ErasedOperation | undefined = registry.get(binding.operationName);
  if (operation === undefined) return;
  if (!isDiscoverable(operation)) return;

  // Operation-backed REST endpoints are served under the external `/api`
  // prefix; direct routes (health/metrics/spec/well-known) stay at the origin
  // root and are emitted unprefixed by `emitDirectRoutes`.
  const openApiPath = externalApiPath(toOpenApiPath(binding.path));
  if (!paths[openApiPath]) paths[openApiPath] = {};

  paths[openApiPath][binding.method.toLowerCase()] = buildBindingEntry(
    binding,
    operation,
    schemaHelper,
  );
  for (const tag of operation.tags) tagSet.add(tag);
}

function buildBindingEntry(
  binding: UnknownRestBinding,
  operation: ErasedOperation,
  schemaHelper: OpenApiSchemaHelper,
): Record<string, unknown> {
  const parameters = buildBindingParameters(binding, operation);
  const successResponse = buildSuccessResponse(binding, operation, schemaHelper);
  const entry: Record<string, unknown> = {
    summary: operation.summary,
    operationId: operation.name,
    tags: operation.tags,
    'x-weft-access': serializeAccessPolicy(operation.access),
    responses: {
      ...successResponse,
      ...buildErrorResponses(operation),
    },
  };
  if (operation.parameterizedAccess !== undefined) {
    entry['x-weft-parameterizedAccess'] = serializeParameterizedAccess(
      operation.parameterizedAccess,
    );
  }
  if (operation.description !== undefined) entry['description'] = operation.description;
  if (parameters.length > 0) entry['parameters'] = parameters;

  const requestBody = buildRequestBody(binding, operation, schemaHelper);
  if (requestBody !== undefined) entry['requestBody'] = requestBody;

  return entry;
}

function buildDirectRouteResponses(route: DirectHttpRouteDefinition): Record<string, unknown> {
  const responses: Record<string, unknown> = {};
  for (const routeResponse of route.responses) {
    const response: Record<string, unknown> = {
      description: routeResponse.description,
    };
    if (routeResponse.content !== undefined) {
      const content: Record<string, { schema: OpenApiSchema }> = {};
      for (const contentVariant of routeResponse.content) {
        content[contentVariant.mediaType] = {
          schema: directRouteContentSchema(contentVariant),
        };
      }
      response['content'] = content;
    }
    responses[String(routeResponse.status)] = response;
  }
  return responses;
}

function buildDirectRouteSecurity(route: DirectHttpRouteDefinition): [] | undefined {
  return route.access === 'public' ? [] : undefined;
}

function emitDirectRoutes(
  paths: Record<string, Record<string, unknown>>,
  tagSet: Set<string>,
): void {
  for (const route of DIRECT_HTTP_ROUTES) {
    const openApiPath = toOpenApiPath(route.path);
    if (!paths[openApiPath]) paths[openApiPath] = {};

    const parameters = buildPathParameters(route.paramNames);
    const entry: Record<string, unknown> = {
      summary: route.summary,
      operationId: route.handler,
      tags: route.tags,
      responses: buildDirectRouteResponses(route),
    };
    const security = buildDirectRouteSecurity(route);
    if (security !== undefined) entry['security'] = security;
    if (parameters.length > 0) entry['parameters'] = parameters;

    paths[openApiPath][route.method.toLowerCase()] = entry;
    for (const tag of route.tags) tagSet.add(tag);
  }
}

export function generateOpenApiDocument(options?: OpenApiOptions): Record<string, unknown> {
  const title = options?.title ?? 'Weft Workflow Engine';
  const version = options?.version ?? VERSION;
  const infoBlock = applyDiscoveryInfo({ title, version }, options?.discoveryInfo);
  const registry = options?.registry ?? createLiveOperationRegistry();
  const schemaHelper = extractComponentsSchemas(registry);

  const { paths, tags } = buildOpenApiPaths(options, registry, schemaHelper);
  const { security, securitySchemes } = buildSecurityBlock(options?.supportedSchemes);

  const document: Record<string, unknown> = {
    openapi: '3.1.0',
    info: infoBlock,
    paths,
    tags,
    security,
    components: {
      schemas: {
        ...schemaHelper.components,
        Error: ERROR_SCHEMA,
      },
      securitySchemes,
    },
  };

  applyOpenApiExtras(document, options);
  return document;
}

function buildOpenApiPaths(
  options: OpenApiOptions | undefined,
  registry: OperationRegistry,
  schemaHelper: OpenApiSchemaHelper,
): { paths: Record<string, Record<string, unknown>>; tags: Array<{ name: string }> } {
  const paths: Record<string, Record<string, unknown>> = {};
  const tagSet = new Set<string>();

  emitBindings(paths, tagSet, options?.restBindings, registry, schemaHelper);
  // Direct routes are reserved infrastructure endpoints, so they are emitted
  // after bindings and overwrite any conflicting user binding documentation.
  emitDirectRoutes(paths, tagSet);

  const tags = [...tagSet].toSorted().map((name) => ({ name }));
  return { paths, tags };
}

const SECURITY_SCHEME_DEFINITIONS: Record<OpenApiSecuritySchemeName, Record<string, string>> = {
  bearerAuth: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  },
  apiKeyAuth: {
    type: 'apiKey',
    in: 'header',
    name: 'x-api-key',
  },
};

function buildSecurityBlock(supportedSchemes?: ReadonlySet<OpenApiSecuritySchemeName>): {
  security: Array<Record<OpenApiSecuritySchemeName, never[]>>;
  securitySchemes: Record<string, Record<string, string>>;
} {
  const schemes =
    supportedSchemes ?? new Set<OpenApiSecuritySchemeName>(['bearerAuth', 'apiKeyAuth']);
  const security = [...schemes].map(
    (schemeName) => ({ [schemeName]: [] }) as Record<OpenApiSecuritySchemeName, never[]>,
  );
  const securitySchemes = Object.fromEntries(
    [...schemes].map((schemeName) => [schemeName, SECURITY_SCHEME_DEFINITIONS[schemeName]]),
  );
  return { security, securitySchemes };
}

function applyOpenApiExtras(
  document: Record<string, unknown>,
  options: OpenApiOptions | undefined,
): void {
  if (options?.serverUrl) {
    document['servers'] = [{ url: options.serverUrl }];
  }
  if (options?.discoveryInfo?.externalDocs !== undefined) {
    document['externalDocs'] = { ...options.discoveryInfo.externalDocs };
  }
}
