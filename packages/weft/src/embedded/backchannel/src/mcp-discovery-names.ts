/**
 * The two names an OpenRPC document gives an MCP-aware server: where its MCP discovery document is
 * served and which MCP method lists its tools. Constants only, so the document generators need not
 * import the MCP discovery generator.
 *
 * @module server/mcp-discovery-names
 */

/** Root-stable discovery document path (RFC 9264 / well-known convention). */
export const MCP_DISCOVERY_PATH = '/.well-known/mcp.json';

/** MCP method used for live tool introspection. */
export const MCP_TOOLS_LIST_METHOD = 'tools/list';
