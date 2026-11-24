/**
 * MCP protocol revision Weft's MCP endpoint serves first. The official SDK
 * serves it on its modern lane, where every request carries its own envelope.
 *
 * @example
 * ```ts
 * import { MCP_PROTOCOL_VERSION } from '@lostgradient/weft';
 *
 * const headers = new Headers({
 *   'Mcp-Protocol-Version': MCP_PROTOCOL_VERSION,
 * });
 * void headers;
 * ```
 */
export const MCP_PROTOCOL_VERSION = '2026-07-28';

/**
 * The 2025-era MCP protocol revision Weft's endpoint also serves, through the
 * SDK's stateless legacy lane over HTTP and a pinned connection over stdio. A
 * 2025-era client that asks for an older revision the SDK still supports (for
 * example `2025-03-26`) is answered in that revision.
 *
 * @example
 * ```ts
 * import { MCP_LEGACY_PROTOCOL_VERSION } from '@lostgradient/weft';
 *
 * const initialize = {
 *   jsonrpc: '2.0',
 *   id: 1,
 *   method: 'initialize',
 *   params: { protocolVersion: MCP_LEGACY_PROTOCOL_VERSION, capabilities: {} },
 * };
 * void initialize;
 * ```
 */
export const MCP_LEGACY_PROTOCOL_VERSION = '2025-11-25';

/** MCP method used for live tool introspection. */

/** MCP method used for live resource introspection. */
export const MCP_RESOURCES_LIST_METHOD = 'resources/list';

/** MCP method used for live resource-template introspection. */
export const MCP_RESOURCE_TEMPLATES_LIST_METHOD = 'resources/templates/list';

/**
 * Default MCP HTTP body limit. Mirrors the existing JSON-RPC adapter limit.
 *
 * @example
 * ```ts
 * import { DEFAULT_MCP_MAX_BODY_BYTES } from '@lostgradient/weft';
 *
 * const maxBodyBytes = DEFAULT_MCP_MAX_BODY_BYTES;
 * void maxBodyBytes;
 * ```
 */
export const DEFAULT_MCP_MAX_BODY_BYTES = 1_048_576;
