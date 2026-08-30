/**
 * OpenRPC 1.3.2 document generator driven from the transport-neutral
 * `OperationRegistry`. Produces a JSON-serializable OpenRPC document
 * listing every operation whose transport availability intersects
 * `OpenRpcOptions.transports`.
 *
 *   - `transports: ['http']` → WebSocket-only methods are omitted
 *     (calling `weft.workflows.subscribe` over HTTP would return
 *     `UnsupportedTransport`, so the method should not appear in the
 *     HTTP-only document).
 *   - Every listed method carries `paramStructure: 'by-name'`, per-field
 *     `ContentDescriptor`s for human-readable surface, AND an
 *     `x-weft-paramsSchema` extension whose `additionalProperties` is
 *     computed from `unknownKeyPolicy.jsonRpc` (`'reject'` → false;
 *     `'strip'` / `'passthrough'` → true). The extension is the
 *     authoritative top-level object schema used by runtime enforcement
 *     and generator tooling; the per-field descriptors cannot drift
 *     from it by the "names match" invariant enforced in tests.
 *   - Every operation-catalog method carries the canonical `x-weft-access`
 *     metadata and, when applicable, `x-weft-parameterizedAccess`. The
 *     synthetic `rpc.discover` method is not an operation-catalog entry,
 *     but advertises its dispatcher-enforced public access posture explicitly.
 *   - `rpc.discover` is itself emitted as a method so clients can
 *     locate the document via JSON-RPC.
 *
 * @module server/openrpc
 */

import { z } from 'zod';

import type { FaultCode } from '../core/fault-code.ts';
import { definitionSchemaToJsonSchema } from '../core/types/definition-schema-to-json.ts';
import type { McpToolDefinition } from '../mcp/tools.ts';
import { VERSION } from '../version.ts';
import {
  serializeAccessPolicy,
  serializeParameterizedAccess,
  type AccessPolicyMetadata,
  type ParameterizedAccessMetadata,
} from './access-policy-metadata.ts';
import { isDiscoverable } from './discovery-filter.ts';
import { applyDiscoveryInfo, type DiscoveryInfo } from './discovery-info.ts';
import { asPlainObject, compareStrings } from './json-schema-utilities.ts';
import { MCP_DISCOVERY_PATH, MCP_TOOLS_LIST_METHOD } from './mcp-discovery.ts';
import { OpenRpcDocumentSchema } from './openrpc-document-schema.ts';
import { buildOpenRpcComponentsErrors } from './openrpc-errors.ts';
import {
  UNIVERSAL_FAULT_DEFAULTS,
  type ErasedOperation,
  type OperationRegistry,
} from './operation-catalog.ts';

/** Transports that MAY be listed in `OpenRpcOptions.transports`. */
export type OpenRpcTransport = 'http' | 'websocket' | 'stdio';

export type OpenRpcOptions = {
  /** Live operation registry. Only operations from this registry can be listed. */
  readonly registry: OperationRegistry;
  /** JSON-RPC transports whose methods should be included in the document. */
  readonly transports: ReadonlyArray<OpenRpcTransport>;
  /** Document title. Defaults to `'Weft Workflow Engine'`. */
  readonly title?: string;
  /** Document version. Defaults to the current Weft package version. */
  readonly version?: string;
  /** Operator-supplied discovery metadata applied to the `info` object. */
  readonly discoveryInfo?: DiscoveryInfo;
  /** Optional server URL; emitted as a single-entry `servers` array. */
  readonly serverUrl?: string;
  /**
   * Live MCP `tools/list` output. Required when any listed operation is
   * `mcpExposable`, because live MCP tool naming owns workflow-name collision
   * handling.
   */
  readonly mcpTools?: ReadonlyArray<Pick<McpToolDefinition, 'name' | 'title'>>;
};

type ContentDescriptor = {
  name: string;
  schema: Record<string, unknown>;
  required: boolean;
};

type OpenRpcMethod = {
  name: string;
  summary?: string;
  description?: string;
  tags?: Array<{ name: string }>;
  paramStructure: 'by-name';
  params: ContentDescriptor[];
  result: ContentDescriptor;
  errors?: Array<{ $ref: string }>;
  'x-weft-paramsSchema': Record<string, unknown>;
  'x-weft-access': AccessPolicyMetadata;
  'x-weft-parameterizedAccess'?: ParameterizedAccessMetadata;
  'x-weft-mcp'?: OpenRpcMcpMethodMetadata;
};

type OpenRpcMcpMethodMetadata = {
  workflowType: string;
  toolName: string;
  toolDiscovery: {
    method: typeof MCP_TOOLS_LIST_METHOD;
    source: 'live';
  };
};

type OpenRpcMcpToolReference = {
  toolName: string;
};

/**
 * Generate an OpenRPC 1.3.2 document. See module doc-comment for the
 * runtime-filtering contract.
 */
export function generateOpenRpcDocument(options: OpenRpcOptions): Record<string, unknown> {
  const methods: OpenRpcMethod[] = [];
  const mcpTools: OpenRpcMcpToolReference[] = [];
  let registryProvidesDiscover = false;

  for (const operation of options.registry.list()) {
    if (!isOperationLiveOnJsonRpc(operation, options.transports)) continue;
    if (!isDiscoverable(operation)) continue;
    if (operation.name === DISCOVER_METHOD_NAME) {
      // Consumers may register their own `rpc.discover` operation —
      // use theirs verbatim and skip the synthetic one so we never
      // emit duplicate method names.
      registryProvidesDiscover = true;
    }
    const method = buildMethod(operation);
    if (operation.mcpExposable) {
      const metadata = buildMethodMcpMetadata(operation, options.mcpTools);
      method['x-weft-mcp'] = metadata;
      mcpTools.push({ toolName: metadata.toolName });
    }
    methods.push(method);
  }
  if (!registryProvidesDiscover && options.transports.length > 0) {
    methods.push(buildDiscoverMethod());
  }

  const document: Record<string, unknown> = {
    openrpc: '1.3.2',
    info: buildOpenRpcInfo(options),
    methods,
    components: {
      errors: buildOpenRpcComponentsErrors(),
    },
    'x-weft-mcp': buildDocumentMcpMetadata(mcpTools),
  };
  applyOpenRpcServer(document, options.serverUrl);
  return document;
}

const DISCOVER_METHOD_NAME = 'rpc.discover';

function buildOpenRpcInfo(options: OpenRpcOptions): Record<string, unknown> {
  const title = options.title ?? 'Weft Workflow Engine';
  const version = options.version ?? VERSION;
  const infoBlock = applyDiscoveryInfo({ title, version }, options.discoveryInfo);
  if (options.discoveryInfo?.externalDocs !== undefined) {
    infoBlock['externalDocs'] = { ...options.discoveryInfo.externalDocs };
  }
  return infoBlock;
}

function applyOpenRpcServer(
  document: Record<string, unknown>,
  serverUrl: string | undefined,
): void {
  if (serverUrl) {
    document['servers'] = [{ url: serverUrl }];
  }
}

function buildDocumentMcpMetadata(
  tools: ReadonlyArray<OpenRpcMcpToolReference>,
): Record<string, unknown> {
  return {
    discoveryPath: MCP_DISCOVERY_PATH,
    toolDiscoveryMethod: MCP_TOOLS_LIST_METHOD,
    toolNames: [...tools].map((tool) => tool.toolName).toSorted(compareStrings),
  };
}

function buildMethodMcpMetadata(
  operation: ErasedOperation,
  mcpTools: OpenRpcOptions['mcpTools'],
): OpenRpcMcpMethodMetadata {
  const workflowType = operation.mcpTool?.workflowType;
  if (workflowType === undefined) {
    throw new Error(
      `openrpc: operation ${operation.name} is mcpExposable but lacks mcpTool.workflowType metadata`,
    );
  }
  const toolName = resolveLiveMcpToolName(operation.name, workflowType, mcpTools);
  return {
    workflowType,
    toolName,
    toolDiscovery: {
      method: MCP_TOOLS_LIST_METHOD,
      source: 'live',
    },
  };
}

function resolveLiveMcpToolName(
  operationName: string,
  workflowType: string,
  mcpTools: OpenRpcOptions['mcpTools'],
): string {
  if (mcpTools === undefined) {
    throw new Error(
      `openrpc: operation ${operationName} is mcpExposable but no live MCP tools/list metadata was provided`,
    );
  }
  const matches = mcpTools.filter((tool) => tool.title === workflowType);
  if (matches.length !== 1) {
    throw new Error(
      `openrpc: operation ${operationName} maps to workflow "${workflowType}", but live MCP tools/list returned ${matches.length} matching tools`,
    );
  }
  return matches[0]!.name;
}

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
  const resultSchema = definitionSchemaToJsonSchema(operation.outputSchema, 'output');

  const method: OpenRpcMethod = {
    name: operation.name,
    paramStructure: 'by-name',
    params: descriptors,
    result: { name: 'result', schema: resultSchema, required: true },
    'x-weft-paramsSchema': paramsSchema,
    'x-weft-access': serializeAccessPolicy(operation.access),
  };
  if (operation.summary) method.summary = operation.summary;
  if (operation.description !== undefined) method.description = operation.description;
  if (operation.tags.length > 0) {
    method.tags = [...operation.tags].toSorted(compareStrings).map((name) => ({ name }));
  }
  if (operation.parameterizedAccess !== undefined) {
    method['x-weft-parameterizedAccess'] = serializeParameterizedAccess(
      operation.parameterizedAccess,
    );
  }
  method.errors = buildMethodErrorReferences(operation);
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
      schema: definitionSchemaToJsonSchema(OpenRpcDocumentSchema),
      required: true,
    },
    errors: buildUniversalErrorReferences(),
    'x-weft-paramsSchema': {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    'x-weft-access': { kind: 'public' },
  };
}

const UNIVERSAL_FAULT_CODES: ReadonlyArray<FaultCode> = [...UNIVERSAL_FAULT_DEFAULTS];

function buildMethodErrorReferences(operation: ErasedOperation): Array<{ $ref: string }> {
  const faultCodes = new Set<FaultCode>(UNIVERSAL_FAULT_CODES);
  for (const faultCode of operation.producibleFaults ?? []) {
    faultCodes.add(faultCode);
  }
  return [...faultCodes].map((faultCode) => ({
    $ref: `#/components/errors/${faultCode}`,
  }));
}

function buildUniversalErrorReferences(): Array<{ $ref: string }> {
  return UNIVERSAL_FAULT_CODES.map((faultCode) => ({
    $ref: `#/components/errors/${faultCode}`,
  }));
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
  const base = definitionSchemaToJsonSchema(schema);
  return {
    ...base,
    additionalProperties: jsonRpcPolicy !== 'reject',
  };
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
  const names = Object.keys(properties).toSorted(compareStrings);
  const requiredSet = new Set(requiredList);
  return names.map((name) => {
    const baseSchema = asPlainObject(properties[name]);
    const schema = defs ? { ...baseSchema, $defs: defs } : baseSchema;
    return { name, schema, required: requiredSet.has(name) };
  });
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
