import {
  JSON_RPC_ERROR_CODES,
  JSON_RPC_VERSION,
  isValidJsonRpcId,
  type JsonRpcId,
} from './json-rpc-protocol.ts';
import { isPlainObject } from './json-schema-utilities.ts';
import type { Cursor, EventSelector } from './workflow-event-feed.ts';

type JsonRpcErrorPayload = {
  readonly code: number;
  readonly message: string;
  readonly data?: Record<string, unknown>;
};

export type SubscribeParamsValidation =
  | {
      readonly ok: true;
      readonly workflowId: string;
      readonly selector: EventSelector;
      readonly fromCursor: Cursor | undefined;
    }
  | { readonly ok: false; readonly error: JsonRpcErrorPayload };

export type MessageFrameValidation =
  | { readonly ok: false; readonly error: JsonRpcErrorPayload; readonly id: null }
  | {
      readonly ok: true;
      readonly parsed: Record<string, unknown>;
      readonly method: unknown;
      readonly id: JsonRpcId | undefined;
      readonly params: Record<string, unknown> | undefined;
      readonly hasRequestId: boolean;
      readonly rawId: unknown;
    };

type SubscribeSelectorValidation =
  | { readonly ok: true; readonly selector: EventSelector }
  | { readonly ok: false; readonly error: JsonRpcErrorPayload };

export function validateSubscribeParams(
  params: Record<string, unknown> | undefined,
): SubscribeParamsValidation {
  const workflowId = params?.['workflowId'];
  if (typeof workflowId !== 'string' || workflowId.length === 0) {
    return invalidParams('params.workflowId must be a non-empty string');
  }

  const selector = validateSubscribeSelector(params?.['selector']);
  if (!selector.ok) return selector;

  const fromCursor = params?.['fromCursor'];
  if (fromCursor !== undefined && typeof fromCursor !== 'string') {
    return invalidParams('params.fromCursor must be a string when present');
  }

  return { ok: true, workflowId, selector: selector.selector, fromCursor };
}

function validateSubscribeSelector(rawSelector: unknown): SubscribeSelectorValidation {
  if (rawSelector === undefined) return { ok: true, selector: 'events' };
  if (rawSelector === 'events' || rawSelector === 'tokens') {
    return { ok: true, selector: rawSelector };
  }
  return invalidParams("params.selector must be 'events' or 'tokens'");
}

export function validateMessageFrame(frame: string, maxFrameBytes: number): MessageFrameValidation {
  const frameByteLength = Buffer.byteLength(frame, 'utf8');
  if (frameByteLength > maxFrameBytes) {
    return {
      ok: false,
      error: {
        code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        message: `frame size exceeds limit of ${maxFrameBytes} bytes`,
      },
      id: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    return {
      ok: false,
      error: { code: JSON_RPC_ERROR_CODES.PARSE_ERROR, message: 'Parse error' },
      id: null,
    };
  }

  if (Array.isArray(parsed)) {
    return {
      ok: false,
      error: {
        code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        message: 'batch frames are not supported over WebSocket',
      },
      id: null,
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      error: {
        code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        message: 'request must be a JSON object',
      },
      id: null,
    };
  }

  const rawId = parsed['id'];
  const hasRequestId = Object.hasOwn(parsed, 'id');
  return {
    ok: true,
    parsed,
    method: parsed['method'],
    id: isValidJsonRpcId(rawId) ? rawId : undefined,
    params: isPlainObject(parsed['params']) ? parsed['params'] : undefined,
    hasRequestId,
    rawId,
  };
}

export function validateSessionPrimitiveFrame(
  frame: Extract<MessageFrameValidation, { ok: true }>,
): { readonly error: JsonRpcErrorPayload; readonly id: JsonRpcId | null } | null {
  if (frame.parsed['jsonrpc'] !== JSON_RPC_VERSION) {
    return {
      error: {
        code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        message: `jsonrpc field must be exactly "${JSON_RPC_VERSION}"`,
      },
      id: frame.id ?? null,
    };
  }
  if (frame.hasRequestId && !isValidJsonRpcId(frame.rawId)) {
    return {
      error: {
        code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        message: 'id must be a string, number, null, or absent',
      },
      id: null,
    };
  }
  if (
    Object.hasOwn(frame.parsed, 'params') &&
    frame.parsed['params'] !== undefined &&
    !isPlainObject(frame.parsed['params'])
  ) {
    return {
      error: {
        code: JSON_RPC_ERROR_CODES.INVALID_PARAMS,
        message: 'params must be an object when present',
        data: { weftCode: 'InvalidParams', httpStatus: 400 },
      },
      id: frame.id ?? null,
    };
  }
  return null;
}

function invalidParams(message: string): SubscribeParamsValidation {
  return {
    ok: false,
    error: {
      code: JSON_RPC_ERROR_CODES.INVALID_PARAMS,
      message,
      data: { weftCode: 'InvalidParams', httpStatus: 400 },
    },
  };
}
