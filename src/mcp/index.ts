/**
 * MCP server support for Weft.
 *
 * This subpath is server/runtime-oriented. Browser-safe entry points remain
 * under `@lostgradient/weft`, `@lostgradient/weft/client`, and `@lostgradient/weft/service-worker`.
 *
 * @module mcp
 */

export {
  anonymousPrincipal,
  principalFromApiKey,
  principalFromJwtClaims,
  principalFromMutualTls,
  principalFromStdioLocal,
} from '../server/principal.ts';
export type {
  AuthenticatedPrincipal,
  JwtClaims,
  Principal,
  UnauthenticatedPrincipal,
} from '../server/principal.ts';
export { handleMcpHttpRequest } from './http.ts';
export type { McpHttpRequestOptions } from './http.ts';
export { DEFAULT_MCP_MAX_BODY_BYTES, MCP_PROTOCOL_VERSION } from './protocol.ts';
export { McpSession, McpSessionManager, createMcpSessionManager } from './session.ts';
export type { McpSessionManagerOptions, McpSessionPhase } from './session.ts';
export { runMcpStdioSession } from './stdio.ts';
export type { McpStdioAdmission, McpStdioSessionOptions, McpStdioSessionResult } from './stdio.ts';
