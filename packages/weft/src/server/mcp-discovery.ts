/**
 * Generator for Weft's `/.well-known/mcp.json` MCP discovery document.
 *
 * @module server/mcp-discovery
 */

import {
  MCP_PROTOCOL_VERSION,
  MCP_RESOURCE_TEMPLATES_LIST_METHOD,
  MCP_RESOURCES_LIST_METHOD,
  MCP_TOOLS_LIST_METHOD,
} from '../mcp/protocol.ts';
import { VERSION } from '../version.ts';
import { externalApiPath } from './route-model.ts';

export {
  MCP_PROTOCOL_VERSION,
  MCP_RESOURCE_TEMPLATES_LIST_METHOD,
  MCP_RESOURCES_LIST_METHOD,
  MCP_TOOLS_LIST_METHOD,
};
/** Root-stable discovery document path (RFC 9264 / well-known convention). */
export const MCP_DISCOVERY_PATH = '/.well-known/mcp.json';
/**
 * Canonical, root-relative MCP streamable-HTTP path. Runtime routing matches
 * this form (after the front door strips the `/api` prefix). The discovery
 * document advertises the external `/api`-prefixed URL via `externalApiPath`.
 */
export const MCP_STREAMABLE_HTTP_PATH = '/mcp';
export const MCP_STREAMABLE_HTTP_METHODS = ['POST', 'GET', 'DELETE'] as const;
export const MCP_STDIO_COMMAND = 'weft-mcp';

export type McpDiscoveryOptions = {
  /** Absolute server origin, e.g. `https://api.example.com`. */
  readonly origin: string;
};

type StreamableHttpTransport = {
  readonly url: string;
  readonly methods: typeof MCP_STREAMABLE_HTTP_METHODS;
  readonly sessionHeader: 'Mcp-Session-Id';
  readonly protocolVersionHeader: 'Mcp-Protocol-Version';
};

type StdioTransport = {
  readonly command: typeof MCP_STDIO_COMMAND;
};

export type McpDiscoveryDocument = {
  readonly schemaVersion: 1;
  readonly protocol: 'model-context-protocol';
  readonly protocolVersion: typeof MCP_PROTOCOL_VERSION;
  readonly serverInfo: {
    readonly name: 'weft';
    readonly version: typeof VERSION;
  };
  readonly transports: {
    readonly streamableHttp: StreamableHttpTransport;
    readonly stdio: StdioTransport;
  };
  readonly discovery: {
    readonly openRpc: string;
    readonly tools: {
      readonly method: typeof MCP_TOOLS_LIST_METHOD;
      readonly canonical: true;
    };
    readonly resources: {
      readonly listMethod: typeof MCP_RESOURCES_LIST_METHOD;
      readonly templatesMethod: typeof MCP_RESOURCE_TEMPLATES_LIST_METHOD;
    };
  };
};

/** Generate the minimal MCP discovery document for build-time consumers. */
export function generateMcpDiscovery(options: McpDiscoveryOptions): McpDiscoveryDocument {
  const { origin } = options;
  return {
    schemaVersion: 1,
    protocol: 'model-context-protocol',
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverInfo: {
      name: 'weft',
      version: VERSION,
    },
    transports: {
      streamableHttp: {
        url: `${origin}${externalApiPath(MCP_STREAMABLE_HTTP_PATH)}`,
        methods: MCP_STREAMABLE_HTTP_METHODS,
        sessionHeader: 'Mcp-Session-Id',
        protocolVersionHeader: 'Mcp-Protocol-Version',
      },
      stdio: {
        command: MCP_STDIO_COMMAND,
      },
    },
    discovery: {
      openRpc: `${origin}/openrpc.json`,
      tools: {
        method: MCP_TOOLS_LIST_METHOD,
        canonical: true,
      },
      resources: {
        listMethod: MCP_RESOURCES_LIST_METHOD,
        templatesMethod: MCP_RESOURCE_TEMPLATES_LIST_METHOD,
      },
    },
  };
}
