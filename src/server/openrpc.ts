/**
 * OpenRPC 1.3.2 document generator driven from the transport-neutral
 * `OperationRegistry`. Produces a JSON-serializable OpenRPC document
 * that reflects exactly the operations that the running server will
 * dispatch over JSON-RPC — intersected with the live
 * `ServeOptions.jsonRpc` flag AND each operation's transport
 * availability.
 *
 * Track 8 design decisions 8, 9, and "OpenAPI / OpenRPC generation":
 *
 *   - `jsonRpc.enabled: false` → zero methods (discovery describes the
 *     live server, not the build).
 *   - `jsonRpc.transports: ['http']` → WebSocket-only methods are
 *     omitted (calling `weft.workflows.subscribe` over HTTP would
 *     return `UnsupportedTransport`, so the method should not appear
 *     in the HTTP-only document).
 *   - Every listed method carries `paramStructure: 'by-name'`, per-field
 *     `ContentDescriptor`s for human-readable surface, AND an
 *     `x-weft-paramsSchema` extension whose `additionalProperties` is
 *     computed from `unknownKeyPolicy.jsonRpc` (`'reject'` → false;
 *     `'strip'` / `'passthrough'` → true). The extension is the
 *     authoritative top-level object schema used by runtime enforcement
 *     and generator tooling; the per-field descriptors cannot drift
 *     from it by the "names match" invariant enforced in tests.
 *   - `rpc.discover` is itself emitted as a method so clients can
 *     locate the document via JSON-RPC.
 *
 * @module server/openrpc
 */

import { z } from 'zod';

import type { ErasedOperation, OperationRegistry } from './operation-catalog.ts';

/** Transports that MAY be enabled in `ServeOptions.jsonRpc.transports`. */
export type OpenRpcTransport = 'http' | 'websocket' | 'stdio';

export type OpenRpcJsonRpcRuntime = {
  readonly enabled: boolean;
  readonly transports: ReadonlyArray<OpenRpcTransport>;
};

export type OpenRpcOptions = {
  /** Live operation registry. Only operations from this registry can be listed. */
  readonly registry: OperationRegistry;
  /** Live JSON-RPC runtime state — drives the runtime-aware filter. */
  readonly jsonRpc: OpenRpcJsonRpcRuntime;
  /** Document title. Defaults to `'Weft Workflow Engine'`. */
  readonly title?: string;
  /** Document version. Defaults to `'0.0.1'`. */
  readonly version?: string;
  /** Optional server URL; emitted as a single-entry `servers` array. */
  readonly serverUrl?: string;
};

type ContentDescriptor = {
  name: string;
  schema: Record<string, unknown>;
  required: boolean;
};

type OpenRpcMethod = {
  name: string;
  summary?: string;
  tags?: Array<{ name: string }>;
  paramStructure: 'by-name';
  params: ContentDescriptor[];
  result: ContentDescriptor;
  'x-weft-paramsSchema': Record<string, unknown>;
};

/**
 * Generate an OpenRPC 1.3.2 document. See module doc-comment for the
 * runtime-filtering contract.
 */
export function generateOpenRpcDocument(options: OpenRpcOptions): Record<string, unknown> {
  const title = options.title ?? 'Weft Workflow Engine';
  const version = options.version ?? '0.0.1';

  const methods: OpenRpcMethod[] = [];

  if (options.jsonRpc.enabled) {
    for (const operation of options.registry.list()) {
      if (!isOperationLiveOnJsonRpc(operation, options.jsonRpc.transports)) continue;
      methods.push(buildMethod(operation));
    }
    methods.push(buildDiscoverMethod());
  }

  const document: Record<string, unknown> = {
    openrpc: '1.3.2',
    info: { title, version },
    methods,
  };
  if (options.serverUrl) {
    document['servers'] = [{ url: options.serverUrl }];
  }
  return document;
}

function isOperationLiveOnJsonRpc(
  operation: ErasedOperation,
  transports: ReadonlyArray<OpenRpcTransport>,
): boolean {
  const available = operation.transports;
  for (const transport of transports) {
    if (transport === 'http' && available.jsonRpcHttp) return true;
    if (transport === 'websocket' && available.jsonRpcWebSocket) return true;
    if (transport === 'stdio' && available.jsonRpcStdio) return true;
  }
  return false;
}

function buildMethod(operation: ErasedOperation): OpenRpcMethod {
  const inputSchema = operation.inputSchema as z.ZodObject;
  const paramsSchema = zodObjectToJsonSchema(inputSchema, operation.unknownKeyPolicy.jsonRpc);
  const descriptors = buildContentDescriptors(paramsSchema);
  const resultSchema = zodToJsonSchema(operation.outputSchema);

  const method: OpenRpcMethod = {
    name: operation.name,
    paramStructure: 'by-name',
    params: descriptors,
    result: { name: 'result', schema: resultSchema, required: true },
    'x-weft-paramsSchema': paramsSchema,
  };
  if (operation.summary) method.summary = operation.summary;
  if (operation.tags.length > 0) {
    method.tags = [...operation.tags].toSorted(byString).map((name) => ({ name }));
  }
  return method;
}

function buildDiscoverMethod(): OpenRpcMethod {
  return {
    name: 'rpc.discover',
    summary: 'Return the OpenRPC document for this server',
    paramStructure: 'by-name',
    params: [],
    result: {
      name: 'openRpcDocument',
      schema: { type: 'object' },
      required: true,
    },
    'x-weft-paramsSchema': {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  };
}

/**
 * Convert a `z.ZodObject` to a top-level JSON Schema for OpenRPC
 * `params`. The shape's own keys and required fields come from zod;
 * `additionalProperties` is stamped per `unknownKeyPolicy.jsonRpc`.
 * Nested objects retain whatever `additionalProperties` zod emits
 * from their own strict / strip / passthrough modes.
 */
function zodObjectToJsonSchema(
  schema: z.ZodObject,
  jsonRpcPolicy: 'reject' | 'strip' | 'passthrough',
): Record<string, unknown> {
  const base = zodToJsonSchema(schema);
  return {
    ...base,
    additionalProperties: jsonRpcPolicy !== 'reject',
  };
}

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // Zod 4 ships native JSON Schema conversion.
  const result = z.toJSONSchema(schema) as Record<string, unknown>;
  // Strip the `$schema` key — it's noise inside a bigger OpenRPC
  // document, and it's the same constant for every call.
  if ('$schema' in result) {
    const { $schema: _unused, ...rest } = result;
    return rest;
  }
  return result;
}

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function buildContentDescriptors(paramsSchema: Record<string, unknown>): ContentDescriptor[] {
  const properties = (paramsSchema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
  const requiredList = new Set((paramsSchema['required'] ?? []) as string[]);
  const names = Object.keys(properties).toSorted(byString);
  return names.map((name) => ({
    name,
    schema: properties[name] ?? {},
    required: requiredList.has(name),
  }));
}
