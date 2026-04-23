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
  let registryProvidesDiscover = false;

  if (options.jsonRpc.enabled) {
    for (const operation of options.registry.list()) {
      if (!isOperationLiveOnJsonRpc(operation, options.jsonRpc.transports)) continue;
      if (operation.name === DISCOVER_METHOD_NAME) {
        // Consumers may register their own `rpc.discover` operation —
        // use theirs verbatim and skip the synthetic one so we never
        // emit duplicate method names.
        registryProvidesDiscover = true;
      }
      methods.push(buildMethod(operation));
    }
    if (!registryProvidesDiscover) {
      methods.push(buildDiscoverMethod());
    }
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

const DISCOVER_METHOD_NAME = 'rpc.discover';

function isOperationLiveOnJsonRpc(
  operation: ErasedOperation,
  transports: ReadonlyArray<OpenRpcTransport>,
): boolean {
  const available = operation.transports;
  for (const transport of transports) {
    if (transportIsAvailable(transport, available)) return true;
  }
  return false;
}

function transportIsAvailable(
  transport: OpenRpcTransport,
  available: ErasedOperation['transports'],
): boolean {
  switch (transport) {
    case 'http':
      return available.jsonRpcHttp;
    case 'websocket':
      return available.jsonRpcWebSocket;
    case 'stdio':
      return available.jsonRpcStdio;
    default:
      // Exhaustiveness check: a new `OpenRpcTransport` literal will
      // cause a compile error here instead of silently being
      // blackholed as "unavailable" for every operation.
      transport satisfies never;
      return false;
  }
}

function buildMethod(operation: ErasedOperation): OpenRpcMethod {
  // The registry's `createOperationRegistry` enforces that every
  // `inputSchema` is a `z.ZodObject` at construction; this cast is
  // safe by construction. Fail fast if something downstream ever
  // violates that invariant — a silent `params: []` would produce a
  // misleading discovery document.
  if (!(operation.inputSchema instanceof z.ZodObject)) {
    throw new Error(
      `openrpc: operation ${operation.name} has non-object inputSchema; generator requires z.ZodObject`,
    );
  }
  const inputSchema = operation.inputSchema;
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
  const properties = asPlainObject(paramsSchema['properties']);
  const requiredList = asStringArray(paramsSchema['required']);
  // If the parent schema carries `$defs` (zod emits this for reused or
  // recursive nested types), propagate it onto every descriptor so
  // `$ref` pointers inside the property schema resolve locally. Without
  // this, a property whose JSON Schema is `{ $ref: '#/$defs/X' }` would
  // be emitted as a dangling reference under `params[].schema` while
  // only the sibling `x-weft-paramsSchema` extension remained valid.
  const defs = asPlainObjectOrUndefined(paramsSchema['$defs']);
  const names = Object.keys(properties).toSorted(byString);
  const requiredSet = new Set(requiredList);
  return names.map((name) => {
    const baseSchema = asPlainObject(properties[name]);
    const schema = defs ? { ...baseSchema, $defs: defs } : baseSchema;
    return { name, schema, required: requiredSet.has(name) };
  });
}

function asPlainObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asPlainObjectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}
