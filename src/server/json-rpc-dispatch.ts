/**
 * Transport-neutral JSON-RPC dispatcher. Every JSON-RPC transport adapter
 * (HTTP POST, WebSocket frame, stdio session) calls `dispatchJsonRpc`
 * with the raw body and a dispatch context; the dispatcher parses the
 * body, resolves each request via `executeOperation`, and produces the
 * wire-level response shape.
 *
 * Track 8 design decision 13: batches dispatch SEQUENTIALLY in request
 * order. Response order matches request order by construction —
 * notifications are dropped from the response array, so the returned
 * indices are the non-notification request indices.
 *
 * Notifications invoke the operation (for side effects) but produce no
 * response. An all-notification batch returns `kind: 'notification-batch'`
 * so transport adapters can translate it to HTTP 204 / no-response
 * appropriately.
 */

import { faultToJsonRpcError } from './fault-to-json-rpc.ts';
import { parseJsonRpcRequest, type ParsedBatchItem, type ParseResult } from './json-rpc-parse.ts';
import {
  JSON_RPC_VERSION,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './json-rpc-protocol.ts';
import { executeOperation, type OperationRegistry } from './operation-catalog.ts';
import { type TransportKind } from './operation-fault.ts';
import { type Principal } from './principal.ts';

export type DispatchJsonRpcContext = {
  readonly principal: Principal;
  readonly engine: unknown;
  readonly transport: Extract<TransportKind, 'jsonRpcHttp' | 'jsonRpcWebSocket' | 'jsonRpcStdio'>;
  readonly registry: OperationRegistry;
};

/**
 * Result of dispatching a JSON-RPC body. Shapes:
 *   - `single`: a single request → one response (success or error).
 *   - `notification`: a single notification → no response.
 *   - `batch`: a batch with at least one non-notification → an array of
 *     responses in request order.
 *   - `notification-batch`: a batch where every item is a notification
 *     → no response body on the wire (HTTP 204, etc.).
 */
export type DispatchJsonRpcResult =
  | { readonly kind: 'single'; readonly response: JsonRpcResponse }
  | { readonly kind: 'notification' }
  | { readonly kind: 'batch'; readonly responses: ReadonlyArray<JsonRpcResponse> }
  | { readonly kind: 'notification-batch' };

/** Parse the raw body and dispatch each request. */
export async function dispatchJsonRpc(
  body: unknown,
  context: DispatchJsonRpcContext,
): Promise<DispatchJsonRpcResult> {
  const parsed = parseJsonRpcRequest(body);

  if (parsed.kind === 'parse-error') {
    return {
      kind: 'single',
      response: {
        jsonrpc: JSON_RPC_VERSION,
        error: { code: parsed.code, message: parsed.message },
        id: null,
      },
    };
  }

  if (parsed.kind === 'invalid-request') {
    return {
      kind: 'single',
      response: {
        jsonrpc: JSON_RPC_VERSION,
        error: { code: parsed.code, message: parsed.message },
        id: parsed.id,
      },
    };
  }

  if (parsed.kind === 'single') {
    if (parsed.isNotification) {
      // Dispatch for side effects, but drop the result.
      await dispatchOne(parsed.request, context);
      return { kind: 'notification' };
    }
    const response = await dispatchOne(parsed.request, context);
    return { kind: 'single', response };
  }

  return dispatchBatch(parsed, context);
}

async function dispatchBatch(
  parsed: Extract<ParseResult, { kind: 'batch' }>,
  context: DispatchJsonRpcContext,
): Promise<DispatchJsonRpcResult> {
  // Batch size cap enforcement lives in `parseJsonRpcRequest` — the
  // parser rejects batches over `MAX_JSON_RPC_BATCH_ITEMS` (100) with
  // an `invalid-request` result BEFORE dispatch. Any batch that reaches
  // this function is already within the cap.
  const responses: JsonRpcResponse[] = [];
  // Sequential dispatch in request order — Track 8 decision 13.
  for (const item of parsed.items) {
    const response = await dispatchBatchItem(item, context);
    if (response !== undefined) responses.push(response);
  }
  if (responses.length === 0) {
    return { kind: 'notification-batch' };
  }
  return { kind: 'batch', responses };
}

async function dispatchBatchItem(
  item: ParsedBatchItem,
  context: DispatchJsonRpcContext,
): Promise<JsonRpcResponse | undefined> {
  if (item.kind === 'invalid') {
    return {
      jsonrpc: JSON_RPC_VERSION,
      error: { code: item.code, message: item.message },
      id: item.id,
    };
  }
  if (item.isNotification) {
    // Fire for side effects; drop the response.
    await dispatchOne(item.request, context);
    return undefined;
  }
  return dispatchOne(item.request, context);
}

async function dispatchOne(
  request: JsonRpcRequest,
  context: DispatchJsonRpcContext,
): Promise<JsonRpcResponse> {
  const id: JsonRpcId = request.id ?? null;
  const result = await executeOperation(request.method, request.params ?? {}, {
    principal: context.principal,
    engine: context.engine,
    transport: context.transport,
    registry: context.registry,
  });
  if (result.ok) {
    return { jsonrpc: JSON_RPC_VERSION, result: result.value, id };
  }
  const error = faultToJsonRpcError(result.fault);
  return {
    jsonrpc: JSON_RPC_VERSION,
    error: { code: error.code, message: error.message, data: error.data },
    id,
  };
}
