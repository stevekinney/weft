/**
 * The browser-safe client entry: the catalog client factory, its transport seam and error, the
 * JSON-RPC HTTP transport, the subscription client and its Server-Sent Events transport, and the
 * chunk parser. It imports no Bun or Node API
 * and the HTTP and SSE transports can also be bundled independently of the in-process dispatcher.
 *
 * @module client
 */

export {
  CatalogClientError,
  createCatalogClient,
  type CatalogCallOptions,
  type CatalogClient,
  type CatalogFetch,
  type CatalogTransport,
  type ClientRestOperationBinding,
  type JsonRpcCallResult,
  type JsonRpcErrorObject,
} from './catalog-client.ts';
export {
  inProcessCatalogTransport,
  inProcessSubscriptionTransport,
  type InProcessTransportOptions,
} from './in-process-transport.ts';
export {
  callJsonRpc,
  httpJsonRpcTransport,
  jsonRpcHttpEndpoint,
  type JsonRpcHttpCall,
  type JsonRpcHttpConnection,
} from './json-rpc-http-transport.ts';
export {
  parseServerSentEventChunk,
  type ServerSentEventFrame,
  type ServerSentEventParseResult,
} from './server-sent-event-parser.ts';
export {
  sseSubscriptionTransport,
  subscriptionUrl,
  type SseSubscriptionConnection,
} from './sse-subscription-transport.ts';
export {
  createSubscriptionClient,
  type SubscriptionCallOptions,
  type SubscriptionClient,
  type SubscriptionMessage,
  type SubscriptionTransport,
} from './subscription-client.ts';
