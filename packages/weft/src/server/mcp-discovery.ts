/**
 * Generator for Weft's `/.well-known/mcp.json` MCP discovery document.
 *
 * @module server/mcp-discovery
 */

import {
  externalApiPath,
  MCP_STREAMABLE_HTTP_PATH,
  MCP_TOOLS_LIST_METHOD,
} from "../embedded/backchannel/src/internals.ts";
import {
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
  MCP_RESOURCE_TEMPLATES_LIST_METHOD,
  MCP_RESOURCES_LIST_METHOD,
} from '../mcp/protocol.ts';
import { VERSION } from '../version.ts';

export {
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
  MCP_RESOURCE_TEMPLATES_LIST_METHOD,
  MCP_RESOURCES_LIST_METHOD,
  MCP_TOOLS_LIST_METHOD,
};
/**
 * The SDK serves every MCP exchange as one POST: the 2026-07-28 lane carries
 * each request's own envelope, and the 2025-era lane is stateless, so there is
 * no session to stream (GET) or terminate (DELETE).
 */
export const MCP_STREAMABLE_HTTP_METHODS = ['POST'] as const;
export const MCP_STDIO_COMMAND = 'weft-mcp';

export type McpDiscoveryOptions = {
  /** Absolute server origin, e.g. `https://api.example.com`. */
  readonly origin: string;
};

type StreamableHttpTransport = {
  readonly url: string;
  readonly methods: typeof MCP_STREAMABLE_HTTP_METHODS;
  readonly protocolVersionHeader: 'Mcp-Protocol-Version';
};

type StdioTransport = {
  readonly command: typeof MCP_STDIO_COMMAND;
};

export type McpDiscoveryDocument = {
  /**
   * 2 since COR-1311: the endpoint keeps no session, so the Streamable HTTP
   * transport lists only POST and no longer names a session header.
   */
  readonly schemaVersion: 2;
  readonly protocol: 'model-context-protocol';
  readonly protocolVersion: typeof MCP_PROTOCOL_VERSION;
  /** The 2025-era revision the endpoint also serves, through the `initialize` handshake. */
  readonly legacyProtocolVersion: typeof MCP_LEGACY_PROTOCOL_VERSION;
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
    schemaVersion: 2,
    protocol: 'model-context-protocol',
    protocolVersion: MCP_PROTOCOL_VERSION,
    legacyProtocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
    serverInfo: {
      name: 'weft',
      version: VERSION,
    },
    transports: {
      streamableHttp: {
        url: `${origin}${externalApiPath(MCP_STREAMABLE_HTTP_PATH)}`,
        methods: MCP_STREAMABLE_HTTP_METHODS,
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
