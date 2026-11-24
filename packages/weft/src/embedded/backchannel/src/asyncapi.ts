/**
 * AsyncAPI 3.0 document generator driven by the operation registry.
 *
 * @module server/asyncapi
 */

import {
  buildOperationEntry,
  buildSseChannel,
  buildSseMessages,
  buildWebSocketChannel,
  buildWebSocketMessages,
} from './asyncapi-channels.ts';
import { isDiscoverable } from './discovery-filter.ts';
import {
  applyDiscoveryInfo,
  resolveDocumentTitleAndVersion,
  type DiscoveryInfo,
} from './discovery-info.ts';
import { compareStrings, isPlainObject, normalizeJsonObject } from './json-schema-utilities.ts';
import { canonicalJson } from './openapi-canonical-json.ts';
import type { ErasedOperation, OperationRegistry } from './operation-catalog.ts';
import type { RestBindingDescription } from './rest-binding.ts';
import { GENERIC_SUBSCRIPTION_ROUTE_PREFIX, toOpenApiPath } from './route-model.ts';
import { zodToJsonSchema } from './zod-json-schema.ts';

/** Options for generating an AsyncAPI document from an {@link OperationRegistry}. */
export type AsyncApiOptions = {
  /** The operations to describe. */
  registry: OperationRegistry;
  /** REST bindings used to resolve SSE channel addresses. Unused with `subscriptionTransport: 'http-route'`. */
  restBindings: ReadonlyArray<RestBindingDescription>;
  /** The document title. */
  title?: string;
  /** The document version. */
  version?: string;
  /** The facts the document reports, such as the server URL. */
  discoveryInfo?: DiscoveryInfo;
  /** The server URL to list. */
  serverUrl?: string;
  /**
   * How subscription operations are served. `'websocket'` (the default) is
   * Weft's server: each subscription gets the JSON-RPC WebSocket channel.
   * `'http-route'` is the engine-independent handler: only subscriptions that
   * declare `transports.http` are listed, each as a Server-Sent Events channel
   * at `/v1/subscriptions/<operation name>`, and stream operations (which that
   * handler has no route for) are left out.
   */
  subscriptionTransport?: 'websocket' | 'http-route';
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

  const httpRoute = options.subscriptionTransport === 'http-route';
  const asyncOperations = options.registry
    .list()
    .filter(isAsyncApiOperation)
    .filter((operation) => !httpRoute || isServedOverSubscriptionRoute(operation))
    .toSorted((left, right) => compareStrings(left.name, right.name));

  const restBindings = httpRoute ? [] : options.restBindings;
  const sseAddressByOperationName = new Map<string, string>();
  for (const binding of restBindings) {
    if (binding.transportKind === 'sse') {
      sseAddressByOperationName.set(binding.operationName, toOpenApiPath(binding.path));
    }
  }

  for (const operation of asyncOperations) {
    const channelName = channelNameForOperation(operation);
    const operationName = operationNameForOperation(operation);
    const { channel, messageKind, operationMessages } = describeAsyncOperation(
      operation,
      httpRoute,
      sseAddressByOperationName,
    );

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
    operations[operationName] = buildOperationEntry(operation, channelName, messageKind);
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
    resolveDocumentTitleAndVersion(options, options.discoveryInfo),
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

type AsyncOperationDescription = {
  readonly channel: Record<string, unknown>;
  /** Which message family the operation entry references. */
  readonly messageKind: 'subscription' | 'stream';
  readonly operationMessages: Record<string, Record<string, unknown>>;
};

/**
 * Over the subscription route a subscription is an SSE stream like any other,
 * so it takes the SSE channel, messages, and operation entry. Otherwise a
 * subscription is a JSON-RPC WebSocket channel and a stream is an SSE channel
 * at its REST binding.
 */
function describeAsyncOperation(
  operation: ErasedOperation & { readonly kind: 'subscription' | 'stream' },
  httpRoute: boolean,
  sseAddressByOperationName: ReadonlyMap<string, string>,
): AsyncOperationDescription {
  if (httpRoute) {
    return {
      channel: buildSseChannel(
        operation,
        `${GENERIC_SUBSCRIPTION_ROUTE_PREFIX}/${operation.name}`,
        (path) => path,
      ),
      messageKind: 'stream',
      operationMessages: buildSseMessages(operation, zodToJsonSchema),
    };
  }
  if (operation.kind === 'subscription') {
    return {
      channel: buildWebSocketChannel(operation),
      messageKind: 'subscription',
      operationMessages: buildWebSocketMessages(operation, zodToJsonSchema),
    };
  }
  return {
    channel: buildSseChannel(operation, sseAddressByOperationName.get(operation.name)),
    messageKind: 'stream',
    operationMessages: buildSseMessages(operation, zodToJsonSchema),
  };
}

function isServedOverSubscriptionRoute(operation: ErasedOperation): boolean {
  return operation.kind === 'subscription' && operation.transports.http;
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
