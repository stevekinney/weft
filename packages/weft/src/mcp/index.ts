/**
 * MCP server support for Weft.
 *
 * This subpath is server/runtime-oriented. The browser-safe entry points are
 * the root `@lostgradient/weft`, `@lostgradient/weft/client`, and
 * `@lostgradient/weft/service-worker`.
 *
 * @module mcp
 */

export {
  McpEndpoint,
  createMcpEndpoint,
  handleMcpHttpRequest,
  type McpEndpointOptions,
  type McpHttpRequestOptions,
} from './http.ts';
export {
  DEFAULT_MCP_MAX_BODY_BYTES,
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
} from './protocol.ts';
export type { McpServerContext, McpServerRegistrar } from './server.ts';
export {
  runMcpStdioSession,
  type McpStdioAdmission,
  type McpStdioSessionOptions,
  type McpStdioSessionResult,
} from './stdio.ts';
