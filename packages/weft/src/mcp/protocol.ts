import {
  JSON_RPC_ERROR_CODES,
  JSON_RPC_VERSION,
  type JsonRpcId,
} from '../server/json-rpc-protocol.ts';

/**
 * MCP protocol version implemented by Weft's MCP transport adapters.
 *
 * @example
 * ```ts
 * import { MCP_PROTOCOL_VERSION } from '@lostgradient/weft/mcp';
 *
 * const headers = new Headers({
 *   'Mcp-Protocol-Version': MCP_PROTOCOL_VERSION,
 * });
 * void headers;
 * ```
 */
export const MCP_PROTOCOL_VERSION = '2025-11-25';

/** MCP method used for live tool introspection. */
export const MCP_TOOLS_LIST_METHOD = 'tools/list';

/** MCP notification emitted when the live tools/list output changes. */
export const MCP_TOOLS_LIST_CHANGED_NOTIFICATION = 'notifications/tools/list_changed';

/** MCP method used for live resource introspection. */
export const MCP_RESOURCES_LIST_METHOD = 'resources/list';

/** MCP method used for live resource-template introspection. */
export const MCP_RESOURCE_TEMPLATES_LIST_METHOD = 'resources/templates/list';

/**
 * Default MCP HTTP body limit. Mirrors the existing JSON-RPC adapter limit.
 *
 * @example
 * ```ts
 * import { DEFAULT_MCP_MAX_BODY_BYTES } from '@lostgradient/weft/mcp';
 *
 * const maxBodyBytes = DEFAULT_MCP_MAX_BODY_BYTES;
 * void maxBodyBytes;
 * ```
 */
export const DEFAULT_MCP_MAX_BODY_BYTES = 1_048_576;

/** JSON-RPC request accepted by the MCP dispatcher. */
export type McpRequest = {
  readonly jsonrpc: '2.0';
  readonly id?: JsonRpcId | undefined;
  readonly method: string;
  readonly params?: unknown;
};

/** JSON-RPC response emitted by the MCP dispatcher. */
export type McpResponse = {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
};

/** Result of handling one MCP message. */
export type McpDispatchResult =
  | { readonly kind: 'response'; readonly response: McpResponse }
  | { readonly kind: 'accepted' };

/** Build a JSON-RPC success response. */
export function successResponse(id: JsonRpcId, result: unknown): McpResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, result };
}

/** Build a JSON-RPC error response. */
export function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): McpResponse {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

/** Invalid params error response. */
export function invalidParams(id: JsonRpcId, message: string, data?: unknown): McpResponse {
  return errorResponse(id, JSON_RPC_ERROR_CODES.INVALID_PARAMS, message, data);
}

/** Method not found error response. */
export function methodNotFound(id: JsonRpcId, method: string): McpResponse {
  return errorResponse(id, JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND, `Unknown MCP method: ${method}`, {
    method,
  });
}

/** Internal error response with masked details. */
export function internalError(id: JsonRpcId): McpResponse {
  return errorResponse(id, JSON_RPC_ERROR_CODES.INTERNAL_ERROR, 'Internal error');
}

/** Resource-not-found response using the MCP resource error convention. */
export function resourceNotFound(id: JsonRpcId, uri: string): McpResponse {
  return errorResponse(id, -32002, 'Resource not found', { uri });
}

/** Forbidden response. */
export function forbidden(id: JsonRpcId, reason: string): McpResponse {
  return errorResponse(id, -32011, reason, { reason });
}

/** True when a value is a JSON-RPC object with a method field. */
export function isMcpRequest(value: unknown): value is McpRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record['jsonrpc'] !== JSON_RPC_VERSION) return false;
  return typeof record['method'] === 'string';
}

/** True when a JSON-RPC request is a notification. */
export function isNotification(request: McpRequest): boolean {
  return request.id === undefined;
}

/** Convert a request id to a stable map key. */
export function requestIdKey(id: JsonRpcId | undefined): string | undefined {
  if (id === undefined || id === null) return undefined;
  return typeof id === 'number' ? `number:${String(id)}` : `string:${id}`;
}

/** Parse one JSON text payload into an MCP request or a protocol response. */
export function parseMcpMessage(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** True when an HTTP content type is JSON. */
export function isJsonContentType(contentType: string): boolean {
  const [type = ''] = contentType.trim().toLowerCase().split(';');
  return type.trim() === 'application/json';
}

/** True when an Accept header allows the requested MIME type. */
export function accepts(acceptHeader: string | null, mimeType: string): boolean {
  if (acceptHeader === null || acceptHeader.trim().length === 0) return true;
  return acceptHeader
    .split(',')
    .map((entry) => entry.split(';')[0]?.trim().toLowerCase() ?? '')
    .some((entry) => entry === '*/*' || entry === mimeType);
}
