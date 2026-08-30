/**
 * AsyncAPI 3.0 document generator driven by the operation registry.
 *
 * @module server/asyncapi
 */

import { definitionSchemaToJsonSchema } from '../core/types/definition-schema-to-json.ts';
import { VERSION } from '../version.ts';
import {
  buildOperationEntry,
  buildSseChannel,
  buildSseMessages,
  buildWebSocketChannel,
  buildWebSocketMessages,
} from './asyncapi-channels.ts';
import { isDiscoverable } from './discovery-filter.ts';
import { applyDiscoveryInfo, type DiscoveryInfo } from './discovery-info.ts';
import { compareStrings, isPlainObject, normalizeJsonObject } from './json-schema-utilities.ts';
import { canonicalJson } from './openapi-canonical-json.ts';
import type { ErasedOperation, OperationRegistry } from './operation-catalog.ts';
import { createLiveRestBindings, type UnknownRestBinding } from './rest-bindings.ts';
import { toOpenApiPath } from './route-model.ts';

export type AsyncApiOptions = {
  registry: OperationRegistry;
  /** REST bindings used to resolve SSE channel addresses. Defaults to `createLiveRestBindings()`. */
  restBindings?: ReadonlyArray<UnknownRestBinding>;
  title?: string;
  version?: string;
  discoveryInfo?: DiscoveryInfo;
  serverUrl?: string;
};

const JSON_RPC_ERROR_SCHEMA: Record<string, unknown> = {
  additionalProperties: false,
  properties: {
    code: { type: 'number' },
    data: {},
    message: { type: 'string' },
  },
  required: ['code', 'message'],
  type: 'object',
};

/**
 * Generate an AsyncAPI 3.0 document from the operation registry.
 *
 * Only discoverable operations with kind `subscription` or `stream` are
 * listed. The returned object is deterministic: object keys are recursively
 * sorted, and identical component messages are deduplicated by canonical JSON.
 */
export function generateAsyncApiDocument(options: AsyncApiOptions): Record<string, unknown> {
  const channels: Record<string, unknown> = {};
  const operations: Record<string, unknown> = {};
  const messages: Record<string, Record<string, unknown>> = {};
  const messageAliases = new Map<string, string>();
  const messageNamesByCanonical = new Map<string, string>();

  const asyncOperations = options.registry
    .list()
    .filter(isAsyncApiOperation)
    .toSorted((left, right) => compareStrings(left.name, right.name));

  const restBindings = options.restBindings ?? createLiveRestBindings();
  const sseAddressByOperationName = new Map<string, string>();
  for (const binding of restBindings) {
    if (binding.transportKind === 'sse') {
      sseAddressByOperationName.set(binding.operationName, toOpenApiPath(binding.path));
    }
  }

  for (const operation of asyncOperations) {
    const channelName = channelNameForOperation(operation);
    const operationName = operationNameForOperation(operation);
    const channel =
      operation.kind === 'subscription'
        ? buildWebSocketChannel(operation)
        : buildSseChannel(operation, sseAddressByOperationName.get(operation.name));
    const operationMessages =
      operation.kind === 'subscription'
        ? buildWebSocketMessages(operation, definitionSchemaToJsonSchema)
        : buildSseMessages(operation, definitionSchemaToJsonSchema);

    for (const [messageName, message] of Object.entries(operationMessages).toSorted(
      ([left], [right]) => compareStrings(left, right),
    )) {
      const canonical = canonicalJson(message);
      const existingName = messageNamesByCanonical.get(canonical);
      const aliasedName = existingName ?? messageName;
      messageAliases.set(messageName, aliasedName);
      if (existingName === undefined) {
        messageNamesByCanonical.set(canonical, messageName);
        messages[messageName] = normalizeJsonObject(message);
      }
    }

    channels[channelName] = channel;
    operations[operationName] = buildOperationEntry(operation, channelName, operation.kind);
  }

  const document: Record<string, unknown> = {
    asyncapi: '3.0.0',
    info: buildAsyncApiInfo(options),
    channels: replaceMessageReferences(channels, messageAliases),
    operations: replaceMessageReferences(operations, messageAliases),
    components: {
      messages,
      schemas: {
        JsonRpcError: JSON_RPC_ERROR_SCHEMA,
      },
    },
  };

  applyAsyncApiDocumentOptions(document, options);

  return normalizeJsonObject(document);
}

function buildAsyncApiInfo(options: AsyncApiOptions): Record<string, unknown> {
  return applyDiscoveryInfo(
    {
      title: options.title ?? 'Weft Workflow Engine',
      version: options.version ?? VERSION,
    },
    options.discoveryInfo,
  );
}

function applyAsyncApiDocumentOptions(
  document: Record<string, unknown>,
  options: AsyncApiOptions,
): void {
  if (options.serverUrl !== undefined) {
    document['servers'] = {
      default: createAsyncApiServer(options.serverUrl),
    };
  }
  if (options.discoveryInfo?.externalDocs !== undefined) {
    document['externalDocs'] = { ...options.discoveryInfo.externalDocs };
  }
}

function isAsyncApiOperation(operation: ErasedOperation): operation is ErasedOperation & {
  readonly kind: 'subscription' | 'stream';
} {
  return (
    isDiscoverable(operation) && (operation.kind === 'subscription' || operation.kind === 'stream')
  );
}

function channelNameForOperation(operation: ErasedOperation): string {
  return operation.name.replaceAll('.', '/');
}

function operationNameForOperation(operation: ErasedOperation): string {
  return operation.name.replaceAll('.', '_');
}

function replaceMessageReferences(value: unknown, aliases: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => replaceMessageReferences(entry, aliases));
  }
  if (!isPlainObject(value)) return value;

  const reference = value['$ref'];
  if (typeof reference === 'string' && reference.startsWith('#/components/messages/')) {
    const messageName = reference.slice('#/components/messages/'.length);
    const aliasedName = aliases.get(messageName) ?? messageName;
    return { ...value, $ref: `#/components/messages/${aliasedName}` };
  }

  const replaced: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    replaced[key] = replaceMessageReferences(entry, aliases);
  }
  return replaced;
}

function createAsyncApiServer(serverUrl: string): Record<string, string> {
  try {
    const parsedServerUrl = new URL(serverUrl);
    return {
      host: parsedServerUrl.host,
      protocol:
        parsedServerUrl.protocol === 'https:' || parsedServerUrl.protocol === 'wss:' ? 'wss' : 'ws',
    };
  } catch {
    return {
      host: serverUrl,
      protocol: 'ws',
    };
  }
}
