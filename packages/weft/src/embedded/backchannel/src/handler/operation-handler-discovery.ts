import { generateAsyncApiDocument } from '../asyncapi.ts';
import type { DiscoveryInfo } from '../discovery-info.ts';
import { generateOpenApiDocument, type OpenApiSecuritySchemeName } from '../openapi.ts';
import { generateOpenRpcDocument } from '../openrpc.ts';
import type { OperationRegistry } from '../operation-catalog.ts';

export type OperationHandlerDocuments = {
  readonly openApi: () => Record<string, unknown>;
  readonly openRpc: () => Record<string, unknown>;
  readonly asyncApi: () => Record<string, unknown>;
};

/**
 * The three discovery documents for the handler's own registry, and for the
 * surface the handler really serves, which is narrower than Weft's:
 *
 * - OpenAPI lists the direct routes the handler answers (health and the three
 *   documents), none of Weft's REST bindings, and not metrics, `api-catalog`,
 *   or `mcp.json`.
 * - OpenRPC declares `http` and `websocket`, carries no MCP metadata, and is
 *   the document `rpc.discover` answers with.
 * - AsyncAPI lists each `transports.http` subscription as a Server-Sent Events
 *   channel at `/v1/subscriptions/<operation name>` and nothing else.
 *
 * Generated on first use and kept: the registry is immutable once the handler
 * is constructed.
 */
export function createOperationHandlerDocuments(options: {
  readonly registry: OperationRegistry;
  readonly discoveryInfo: DiscoveryInfo | undefined;
  readonly authenticates: boolean;
  /** The resolved public paths; the OpenAPI document marks only these as needing no credentials. */
  readonly publicPaths: ReadonlySet<string>;
}): OperationHandlerDocuments {
  const { registry, discoveryInfo } = options;
  const info = discoveryInfo === undefined ? {} : { discoveryInfo };
  // Anonymous-only handlers advertise no credential scheme.
  const supportedSchemes: ReadonlySet<OpenApiSecuritySchemeName> | undefined = options.authenticates
    ? undefined
    : new Set<OpenApiSecuritySchemeName>();

  return {
    openApi: lazily(() =>
      generateOpenApiDocument({
        registry,
        restBindings: [],
        directRoutes: ['healthCheck', 'openApiDocument', 'openRpcDocument', 'asyncApiDocument'],
        publicPaths: options.publicPaths,
        ...(supportedSchemes === undefined ? {} : { supportedSchemes }),
        ...info,
      }),
    ),
    openRpc: lazily(() =>
      generateOpenRpcDocument({
        registry,
        transports: ['http', 'websocket'],
        includeMcpMetadata: false,
        ...info,
      }),
    ),
    asyncApi: lazily(() =>
      generateAsyncApiDocument({
        registry,
        restBindings: [],
        subscriptionTransport: 'http-route',
        ...info,
      }),
    ),
  };
}

function lazily(generate: () => Record<string, unknown>): () => Record<string, unknown> {
  let document: Record<string, unknown> | undefined;
  return () => {
    document ??= generate();
    return document;
  };
}
