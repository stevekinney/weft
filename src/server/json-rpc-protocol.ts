/**
 * JSON-RPC 2.0 protocol constants and shared types.
 *
 * Single source of truth for the wire-level representation every
 * JSON-RPC transport in this codebase consumes:
 *   - Parse helpers (`json-rpc-parse.ts`, Phase 8)
 *   - Dispatcher (`json-rpc-dispatch.ts`, Phase 8)
 *   - HTTP adapter (`json-rpc-http.ts`, Phase 11)
 *   - WebSocket adapter (`json-rpc-websocket.ts`, Phase 12)
 *   - Runtime stdio session (`stdio-session.ts`, Phase 13)
 *
 * Reserved-spec error codes (-32700..-32603) keep their JSON-RPC 2.0
 * meanings. Weft domain codes live in the -32010..-32099 band per
 * Track 8 design decision 4.
 */

/** Literal `"2.0"` — the only `jsonrpc` version this runtime accepts. */
export const JSON_RPC_VERSION = '2.0' as const;
export type JsonRpcVersion = typeof JSON_RPC_VERSION;

/**
 * Error codes carried on the wire in `JsonRpcError.code`.
 *
 * Reserved band (-32700..-32603) — JSON-RPC 2.0 spec.
 * Weft domain band (-32010..-32099) — see `OperationFault` +
 *   `fault-to-json-rpc.ts` for the mapping to `FaultCode`.
 */
export const JSON_RPC_ERROR_CODES = Object.freeze({
  // Spec-reserved.
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Weft domain.
  UNAUTHORIZED: -32010,
  FORBIDDEN: -32011,
  NOT_FOUND: -32020,
  CONFLICT: -32021,
  UNPROCESSABLE: -32022,
  TIMEOUT: -32023,
  RATE_LIMITED: -32024,
  NOT_IMPLEMENTED: -32025,
  UNSUPPORTED_TRANSPORT: -32030,
  SUBSCRIPTION_OVERFLOW: -32031,
  ENGINE_FAILURE: -32099,
} as const);

export type JsonRpcErrorCode = (typeof JSON_RPC_ERROR_CODES)[keyof typeof JSON_RPC_ERROR_CODES];

/**
 * A JSON-RPC request id. The spec allows string, number, or null.
 * `null` is only valid when returned in error responses for requests
 * whose id could not be parsed.
 */
export type JsonRpcId = string | number | null;

/** Total runtime guard for `JsonRpcId`. Rejects NaN, Infinity, booleans, objects. */
export function isValidJsonRpcId(value: unknown): value is JsonRpcId {
  if (value === null) return true;
  if (typeof value === 'string') return true;
  if (typeof value === 'number' && Number.isFinite(value)) return true;
  return false;
}

/** Raw JSON-RPC request shape (pre-parse, as it arrives on the wire). */
export type JsonRpcRequest = {
  readonly jsonrpc: JsonRpcVersion;
  readonly method: string;
  readonly params?: Record<string, unknown> | undefined;
  readonly id?: JsonRpcId | undefined;
};

/** JSON-RPC success response. */
export type JsonRpcSuccessResponse = {
  readonly jsonrpc: JsonRpcVersion;
  readonly result: unknown;
  readonly id: JsonRpcId;
};

/** JSON-RPC error response. */
export type JsonRpcErrorResponse = {
  readonly jsonrpc: JsonRpcVersion;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
  readonly id: JsonRpcId;
};

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
