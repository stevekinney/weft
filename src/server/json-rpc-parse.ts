/**
 * JSON-RPC 2.0 request parser — accepts a raw body (string or already-
 * parsed JSON) and returns a discriminated-union `ParseResult` that
 * describes what the transport should dispatch.
 *
 * Track 8 design decisions this parser enforces:
 *   - `params` MUST be absent or a JSON object. Array-form positional
 *     params are rejected with `InvalidRequest` (-32600). This matches
 *     OpenRPC's `paramStructure: "by-name"` contract and eliminates a
 *     whole class of drift between REST (which has no positional form)
 *     and JSON-RPC.
 *   - `jsonrpc` MUST be the literal string `"2.0"`. No auto-upgrade
 *     from 1.0 or 1.1.
 *   - `method` MUST be a non-empty string. The name regex
 *     (`validateOperationName` in `operation-catalog.ts`) is NOT
 *     enforced here — the dispatcher treats an unknown name as
 *     `MethodNotFound`, which is the spec's intended semantics.
 *   - Notifications are requests with no `id` key. Explicit `id: null`
 *     is a real request (not a notification) per spec — the parser
 *     surfaces this via `isNotification: false`.
 *
 * The result is transport-neutral: HTTP POST, WebSocket frames, and
 * stdio sessions all consume the same `ParseResult`.
 */

import {
  JSON_RPC_ERROR_CODES,
  JSON_RPC_VERSION,
  isValidJsonRpcId,
  type JsonRpcId,
  type JsonRpcRequest,
} from './json-rpc-protocol.ts';

/**
 * A request body that has been parsed successfully. Either a single
 * request, a batch of per-item parse results, or a body-level error.
 */
export type ParseResult =
  | {
      readonly kind: 'parse-error';
      readonly code: typeof JSON_RPC_ERROR_CODES.PARSE_ERROR;
      readonly message: string;
    }
  | {
      readonly kind: 'invalid-request';
      readonly code: typeof JSON_RPC_ERROR_CODES.INVALID_REQUEST;
      readonly message: string;
      readonly id: JsonRpcId;
    }
  | {
      readonly kind: 'single';
      readonly request: JsonRpcRequest;
      readonly isNotification: boolean;
    }
  | {
      readonly kind: 'batch';
      readonly items: ReadonlyArray<ParsedBatchItem>;
    };

export type ParsedBatchItem =
  | {
      readonly kind: 'valid';
      readonly request: JsonRpcRequest;
      readonly isNotification: boolean;
    }
  | {
      readonly kind: 'invalid';
      readonly code: typeof JSON_RPC_ERROR_CODES.INVALID_REQUEST;
      readonly message: string;
      readonly id: JsonRpcId;
    };

/**
 * Parse a raw body into a transport-neutral `ParseResult`. Accepts
 * either a string (will be JSON.parse'd) or an already-parsed value.
 */
export function parseJsonRpcRequest(body: unknown): ParseResult {
  let parsed: unknown;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      return {
        kind: 'parse-error',
        code: JSON_RPC_ERROR_CODES.PARSE_ERROR,
        message: 'Parse error',
      };
    }
  } else {
    parsed = body;
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return {
        kind: 'invalid-request',
        code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        message: 'Batch must contain at least one request',
        id: null,
      };
    }
    return {
      kind: 'batch',
      items: parsed.map(parseBatchItem),
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      kind: 'invalid-request',
      code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
      message: 'Request must be a JSON object or batch array',
      id: null,
    };
  }

  return parseSingleObject(parsed);
}

function parseBatchItem(item: unknown): ParsedBatchItem {
  if (!isPlainObject(item)) {
    return {
      kind: 'invalid',
      code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
      message: 'Batch item must be a JSON object',
      id: null,
    };
  }
  const result = parseSingleObject(item);
  if (result.kind === 'single') {
    return { kind: 'valid', request: result.request, isNotification: result.isNotification };
  }
  if (result.kind === 'invalid-request') {
    return {
      kind: 'invalid',
      code: result.code,
      message: result.message,
      id: result.id,
    };
  }
  // `parse-error` and `batch` cannot be produced by `parseSingleObject`
  // — it always returns `single` or `invalid-request`.
  return {
    kind: 'invalid',
    code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
    message: 'Invalid request',
    id: null,
  };
}

function parseSingleObject(
  object: Record<string, unknown>,
): Extract<ParseResult, { kind: 'single' | 'invalid-request' }> {
  // Grab the raw id early so we can echo it in any error response.
  // The spec requires `id: null` when the incoming id was invalid, so
  // we only echo the id if it's actually valid.
  const rawId: unknown = object['id'];
  const hasIdKey = 'id' in object;
  const idForError: JsonRpcId = isValidJsonRpcId(rawId) ? rawId : null;

  if (object['jsonrpc'] !== JSON_RPC_VERSION) {
    return {
      kind: 'invalid-request',
      code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
      message: `jsonrpc field must be exactly "${JSON_RPC_VERSION}"`,
      id: idForError,
    };
  }

  const method = object['method'];
  if (typeof method !== 'string' || method.length === 0) {
    return {
      kind: 'invalid-request',
      code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
      message: 'method field must be a non-empty string',
      id: idForError,
    };
  }

  const rawParams = object['params'];
  const hasParamsKey = 'params' in object;
  let params: Record<string, unknown> | undefined;
  if (hasParamsKey) {
    if (Array.isArray(rawParams)) {
      return {
        kind: 'invalid-request',
        code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        message:
          'positional params are not supported; use named params (params must be a JSON object)',
        id: idForError,
      };
    }
    if (!isPlainObject(rawParams)) {
      return {
        kind: 'invalid-request',
        code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        message: 'params must be a JSON object (named params) or absent',
        id: idForError,
      };
    }
    params = rawParams;
  }

  if (hasIdKey && !isValidJsonRpcId(rawId)) {
    return {
      kind: 'invalid-request',
      code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
      message: 'id must be a string, finite number, or null',
      id: null,
    };
  }

  // Notifications omit the `id` key entirely. `id: null` is a real
  // request per the JSON-RPC 2.0 spec.
  const isNotification = !hasIdKey;

  const request: JsonRpcRequest = {
    jsonrpc: JSON_RPC_VERSION,
    method,
    ...(params === undefined ? {} : { params }),
    ...(hasIdKey ? { id: rawId as JsonRpcId } : {}),
  };

  return { kind: 'single', request, isNotification };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
