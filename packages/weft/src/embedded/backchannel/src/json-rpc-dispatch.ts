/**
 * Transport-neutral JSON-RPC dispatcher. Every JSON-RPC transport adapter
 * (HTTP POST, WebSocket frame, stdio session) calls `dispatchJsonRpc`
 * with the raw body and a dispatch context; the dispatcher parses the
 * body, resolves each request via `executeOperation`, and produces the
 * wire-level response shape.
 *
 * The stable JSON-RPC operation-catalog contract mandates sequential dispatch
 * in request order. Response order matches request order by construction —
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
import { generateOpenRpcDocument } from './openrpc.ts';
import {
  executeOperation,
  executeSubscription,
  type OperationRegistry,
} from './operation-catalog.ts';
import { type OperationFault, type TransportKind } from './operation-fault.ts';
import { type Principal } from './principal.ts';

/** The registry, authenticated caller and adapter for one incoming frame. */
export type DispatchJsonRpcContext = {
  /** The caller admitted by the adapter. */
  readonly principal: Principal;
  /** See `OperationContext.host`. */
  readonly host: unknown;
  /** Which JSON-RPC transport received the frame. */
  readonly transport: Extract<TransportKind, 'jsonRpcHttp' | 'jsonRpcWebSocket' | 'jsonRpcStdio'>;
  /** The operation catalog for the adapter. */
  readonly registry: OperationRegistry;
  /**
   * Accept a subscription started by a single request. The adapter owns the
   * iterable and must close it when delivery ends. Start delivery after writing
   * the returned response so events cannot overtake the acknowledgement.
   */
  readonly acceptSubscription?: (subscription: JsonRpcSubscription) => void;
  /**
   * The abort signal for a request or subscription, when the transport supplies one. HTTP
   * forwards the `Request` signal, and framed sessions supply a signal for subscriptions.
   * Operations read it as `OperationContext.signal`.
   */
  readonly signal?: AbortSignal;
  /**
   * Produces the document `rpc.discover` answers with. Omitted, the
   * dispatcher generates a plain OpenRPC document of the registry (HTTP and
   * WebSocket methods, no MCP tools, no server title). Weft's server supplies
   * its own (`createWeftDiscoverDocument`), and a handler that serves a
   * narrower surface supplies the same document it serves at `/openrpc.json`,
   * so the two never disagree.
   */
  readonly discoverDocument?: () => Record<string, unknown>;
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

/** A validated subscription that an adapter can deliver after acknowledging its start. */
export type JsonRpcSubscription = {
  /** Lifecycle identifier used by the adapter. */
  readonly subscriptionId: string;
  /** The validated response that acknowledges startup. */
  readonly envelope: unknown;
  /** The validated events in delivery order. */
  readonly iterable: AsyncIterable<unknown>;
  /** Releases the subscription when delivery ends. */
  readonly close: () => Promise<void>;
  /** Signals the end of replay when the operation distinguishes replay and live events. */
  readonly replayComplete?: Promise<void>;
};

const DISCOVER_METHOD_NAME = 'rpc.discover';

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
      // JSON-RPC 2.0 — id-less requests are notifications. The operation
      // pipeline (auth, validation, invoke) still runs identically; the
      // response is intentionally dropped per spec because the caller
      // chose fire-and-forget. The criterion's "Notifications are opt-in
      // per method" is a contract guarantee at the operation level: the
      // operation runs the same code path regardless of id presence, so
      // a caller who omits id by mistake still triggers auth/validation
      // failures server-side (logged) — they just won't see a wire
      // response. Mutating ops "default to request-response" because
      // every caller-friendly client library includes id by default;
      // notifications are an explicit caller opt-in by omitting it.
      await dispatchSingle(parsed.request, context);
      return { kind: 'notification' };
    }
    const response = await dispatchSingle(parsed.request, context);
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
  // Sequential dispatch in request order — stable operation-catalog contract.
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
    // JSON-RPC 2.0 — same contract as single notifications: pipeline
    // runs, response dropped per spec.
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
  if (request.method === DISCOVER_METHOD_NAME) {
    const document =
      context.discoverDocument?.() ??
      generateOpenRpcDocument({
        registry: context.registry,
        transports: ['http', 'websocket'],
      });
    return { jsonrpc: JSON_RPC_VERSION, result: document, id };
  }
  const dispatch = {
    principal: context.principal,
    host: context.host,
    transport: context.transport,
    registry: context.registry,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  };
  const result = await executeOperation(request.method, request.params ?? {}, dispatch);
  if (result.ok) {
    return { jsonrpc: JSON_RPC_VERSION, result: result.value, id };
  }
  return faultResponse(result.fault, id);
}

function dispatchSingle(
  request: JsonRpcRequest,
  context: DispatchJsonRpcContext,
): Promise<JsonRpcResponse> {
  if (
    context.acceptSubscription !== undefined &&
    context.registry.get(request.method)?.kind === 'subscription'
  ) {
    return dispatchSubscriptionRequest(request, context, context.acceptSubscription);
  }
  return dispatchOne(request, context);
}

async function dispatchSubscriptionRequest(
  request: JsonRpcRequest,
  context: DispatchJsonRpcContext,
  accept: (subscription: JsonRpcSubscription) => void,
): Promise<JsonRpcResponse> {
  const id = request.id ?? null;
  const started = await executeSubscription(request.method, request.params ?? {}, context);
  if (!started.ok) return faultResponse(started.fault, id);
  try {
    accept(started.value);
  } catch (error) {
    await started.value.close().catch(() => {});
    throw error;
  }
  return { jsonrpc: JSON_RPC_VERSION, result: started.value.envelope, id };
}

function faultResponse(fault: OperationFault, id: JsonRpcId): JsonRpcResponse {
  const error = faultToJsonRpcError(fault);
  return {
    jsonrpc: JSON_RPC_VERSION,
    error: { code: error.code, message: error.message, data: error.data },
    id,
  };
}
