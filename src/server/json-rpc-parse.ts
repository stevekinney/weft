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
import { isPlainObject } from './json-schema-utilities.ts';

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
/**
 * Hard upper bound on batch size. A well-behaved client will stay well
 * below this; the limit exists to make a hostile client's first attempt
 * at memory/CPU exhaustion cheap to fail. Transport adapters (Phase 11
 * HTTP, Phase 12 WebSocket, Phase 13 stdio) SHOULD enforce their own
 * body/frame byte limits in addition to this item cap.
 */
export const MAX_JSON_RPC_BATCH_ITEMS = 100;

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
        message: 'Invalid Request',
        id: null,
      };
    }
    if (parsed.length > MAX_JSON_RPC_BATCH_ITEMS) {
      return {
        kind: 'invalid-request',
        code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        message: `Invalid Request: batch size ${parsed.length} exceeds limit ${MAX_JSON_RPC_BATCH_ITEMS}`,
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
  return {
    kind: 'invalid',
    code: result.code,
    message: result.message,
    id: result.id,
  };
}

type InvalidRequest = Extract<ParseResult, { kind: 'invalid-request' }>;

function parseSingleObject(
  object: Record<string, unknown>,
): Extract<ParseResult, { kind: 'single' | 'invalid-request' }> {
  // Grab the raw id early so we can echo it in any error response.
  // The spec requires `id: null` when the incoming id was invalid, so
  // we only echo the id if it's actually valid.
  const rawId: unknown = object['id'];
  const hasIdKey = 'id' in object;
  const idForError: JsonRpcId = isValidJsonRpcId(rawId) ? rawId : null;

  const versionRejection = checkJsonRpcVersion(object, idForError);
  if (versionRejection !== null) return versionRejection;

  const method = object['method'];
  const methodRejection = checkMethodField(method, idForError);
  if (methodRejection !== null) return methodRejection;

  const paramsResult = parseParamsField(object, idForError);
  if (paramsResult.kind === 'invalid-request') return paramsResult;

  const idRejection = checkIdField(rawId, hasIdKey);
  if (idRejection !== null) return idRejection;

  // Notifications omit the `id` key entirely. `id: null` is a real
  // request per the JSON-RPC 2.0 spec.
  const isNotification = !hasIdKey;

  const request: JsonRpcRequest = {
    jsonrpc: JSON_RPC_VERSION,
    method: method as string,
    ...(paramsResult.params === undefined ? {} : { params: paramsResult.params }),
    ...(hasIdKey ? { id: rawId as JsonRpcId } : {}),
  };

  return { kind: 'single', request, isNotification };
}

function checkJsonRpcVersion(
  object: Record<string, unknown>,
  idForError: JsonRpcId,
): InvalidRequest | null {
  if (object['jsonrpc'] === JSON_RPC_VERSION) return null;
  return {
    kind: 'invalid-request',
    code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
    message: `jsonrpc field must be exactly "${JSON_RPC_VERSION}"`,
    id: idForError,
  };
}

function checkMethodField(method: unknown, idForError: JsonRpcId): InvalidRequest | null {
  if (typeof method === 'string' && method.length > 0) return null;
  return {
    kind: 'invalid-request',
    code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
    message: 'method field must be a non-empty string',
    id: idForError,
  };
}

type ParamsParseResult =
  | { readonly kind: 'ok'; readonly params: Record<string, unknown> | undefined }
  | InvalidRequest;

function parseParamsField(
  object: Record<string, unknown>,
  idForError: JsonRpcId,
): ParamsParseResult {
  if (!('params' in object)) return { kind: 'ok', params: undefined };
  const rawParams = object['params'];
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
  // `params` is passed through verbatim. Prototype-pollution keys
  // (`__proto__` / `constructor` / `prototype`) are NOT stripped
  // here — the authoritative defense is `executeOperation`'s
  // `UNSAFE_PROTOTYPE_KEYS` filter plus the registry-time rejection
  // of schema-declared unsafe keys. Sanitizing at the parse layer
  // would duplicate that policy and force the transport-neutral
  // parser to know about operation-catalog internals. The security
  // boundary is the pipeline, not the parser — this comment exists
  // so a future reviewer sees the decision is deliberate.
  return { kind: 'ok', params: rawParams };
}

function checkIdField(rawId: unknown, hasIdKey: boolean): InvalidRequest | null {
  if (!hasIdKey || isValidJsonRpcId(rawId)) return null;
  return {
    kind: 'invalid-request',
    code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
    message: 'id must be a string, finite number, or null',
    id: null,
  };
}
