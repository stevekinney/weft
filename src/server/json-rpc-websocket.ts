/**
 * WebSocket JSON-RPC session adapter.
 *
 * Each `/jsonrpc` WebSocket connection gets one `JsonRpcWebSocketSession`
 * that binds the authenticated principal at upgrade time and reuses it
 * for every frame. The session:
 *   - Parses incoming frames as single JSON-RPC requests (batches over
 *     WS are rejected per Track 8 design decision 13).
 *   - Dispatches `weft.workflows.subscribe` / `weft.workflows.unsubscribe`
 *     as first-class session primitives against the `WorkflowEventFeed`.
 *   - Delegates all other methods to the standard `dispatchJsonRpc`.
 *   - Emits live envelopes as `weft.events.deliver` notifications keyed
 *     by the assigned `subscriptionId`.
 *   - Guarantees every active subscription is torn down on `close()`
 *     (or socket disconnect at the transport layer).
 */

import { dispatchJsonRpc } from './json-rpc-dispatch.ts';
import { JSON_RPC_ERROR_CODES, JSON_RPC_VERSION, type JsonRpcId } from './json-rpc-protocol.ts';
import type { OperationRegistry } from './operation-catalog.ts';
import type { Principal } from './principal.ts';
import type {
  Cursor,
  EventEnvelope,
  EventSelector,
  WorkflowEventFeed,
} from './workflow-event-feed.ts';

/** Emitter interface: any `send(string)`-shaped object. */
export type JsonRpcWebSocketEmitter = {
  send(message: string): void;
};

export type JsonRpcWebSocketSessionOptions = {
  readonly registry: OperationRegistry;
  readonly engine: unknown;
  readonly principal: Principal;
  readonly emitter: JsonRpcWebSocketEmitter;
  readonly feed: WorkflowEventFeed;
};

export type JsonRpcWebSocketSession = {
  /** Process one incoming WS frame (UTF-8 text). */
  handleMessage(frame: string): Promise<void>;
  /** Tear down every active subscription and release resources. */
  close(): Promise<void>;
};

type ActiveSubscription = {
  readonly id: string;
  readonly controller: AbortController;
  readonly pump: Promise<void>;
};

/**
 * Method names handled directly by the session (not routed through the
 * standard operation dispatcher). These exist as session primitives
 * because subscribe/unsubscribe need per-frame correlation and live
 * state that doesn't fit the dispatch pipeline.
 */
const SESSION_METHODS = {
  SUBSCRIBE: 'weft.workflows.subscribe',
  UNSUBSCRIBE: 'weft.workflows.unsubscribe',
  DELIVER: 'weft.events.deliver',
  TERMINATED: 'weft.events.terminated',
} as const;

let nextSubscriptionSequence = 0;
function generateSubscriptionId(): string {
  nextSubscriptionSequence += 1;
  return `sub_${Date.now().toString(36)}_${nextSubscriptionSequence.toString(36)}`;
}

export function createJsonRpcWebSocketSession(
  options: JsonRpcWebSocketSessionOptions,
): JsonRpcWebSocketSession {
  const { registry, engine, principal, emitter, feed } = options;
  const subscriptions = new Map<string, ActiveSubscription>();
  let closed = false;

  function emit(message: object): void {
    if (closed) return;
    emitter.send(JSON.stringify(message));
  }

  async function handleSubscribe(
    id: JsonRpcId | undefined,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    const workflowId = params?.['workflowId'];
    const rawSelector = params?.['selector'];
    const rawFromCursor = params?.['fromCursor'];
    if (typeof workflowId !== 'string' || workflowId.length === 0) {
      emit({
        jsonrpc: JSON_RPC_VERSION,
        error: {
          code: JSON_RPC_ERROR_CODES.INVALID_PARAMS,
          message: 'params.workflowId must be a non-empty string',
          data: { weftCode: 'InvalidParams', httpStatus: 400 },
        },
        id: id ?? null,
      });
      return;
    }
    if (rawSelector !== 'events' && rawSelector !== 'tokens') {
      emit({
        jsonrpc: JSON_RPC_VERSION,
        error: {
          code: JSON_RPC_ERROR_CODES.INVALID_PARAMS,
          message: "params.selector must be 'events' or 'tokens'",
          data: { weftCode: 'InvalidParams', httpStatus: 400 },
        },
        id: id ?? null,
      });
      return;
    }
    const selector: EventSelector = rawSelector;
    let fromCursor: Cursor | undefined;
    if (rawFromCursor !== undefined) {
      if (typeof rawFromCursor !== 'string') {
        emit({
          jsonrpc: JSON_RPC_VERSION,
          error: {
            code: JSON_RPC_ERROR_CODES.INVALID_PARAMS,
            message: 'params.fromCursor must be a string when present',
            data: { weftCode: 'InvalidParams', httpStatus: 400 },
          },
          id: id ?? null,
        });
        return;
      }
      fromCursor = rawFromCursor;
    }

    const subscriptionId = generateSubscriptionId();
    const controller = new AbortController();
    const startingCursor: Cursor = fromCursor ?? '0';

    emit({
      jsonrpc: JSON_RPC_VERSION,
      result: { subscriptionId, cursor: startingCursor },
      id: id ?? null,
    });

    const pump = pumpSubscription(
      subscriptionId,
      workflowId,
      selector,
      fromCursor,
      controller.signal,
    );
    subscriptions.set(subscriptionId, { id: subscriptionId, controller, pump });
  }

  async function pumpSubscription(
    subscriptionId: string,
    workflowId: string,
    selector: EventSelector,
    fromCursor: Cursor | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const iterable = feed.subscribe({
        workflowId,
        selector,
        ...(fromCursor === undefined ? {} : { fromCursor }),
        signal,
      });
      for await (const envelope of iterable) {
        if (signal.aborted) break;
        deliver(subscriptionId, envelope);
      }
      // Natural termination (feed closed normally — buffer overflow
      // or abort — we only emit terminated for the overflow path
      // since the consumer already asked for abort or shutdown).
      if (!signal.aborted && !closed) {
        emit({
          jsonrpc: JSON_RPC_VERSION,
          method: SESSION_METHODS.TERMINATED,
          params: { subscriptionId, reason: 'overflow' },
        });
      }
    } catch (error) {
      // Unexpected error in the subscription pump — surface a
      // server-closed terminated notification, then fall through.
      if (!closed) {
        emit({
          jsonrpc: JSON_RPC_VERSION,
          method: SESSION_METHODS.TERMINATED,
          params: {
            subscriptionId,
            reason: 'server-closed',
            fault: {
              code: 'EngineFailure',
              message: error instanceof Error ? 'internal error' : 'internal error',
              data: {},
            },
          },
        });
      }
    } finally {
      subscriptions.delete(subscriptionId);
    }
  }

  function deliver(subscriptionId: string, envelope: EventEnvelope): void {
    emit({
      jsonrpc: JSON_RPC_VERSION,
      method: SESSION_METHODS.DELIVER,
      params: { subscriptionId, envelope },
    });
  }

  function handleUnsubscribe(
    id: JsonRpcId | undefined,
    params: Record<string, unknown> | undefined,
  ): void {
    const subscriptionId = params?.['subscriptionId'];
    if (typeof subscriptionId !== 'string') {
      emit({
        jsonrpc: JSON_RPC_VERSION,
        error: {
          code: JSON_RPC_ERROR_CODES.INVALID_PARAMS,
          message: 'params.subscriptionId must be a string',
          data: { weftCode: 'InvalidParams', httpStatus: 400 },
        },
        id: id ?? null,
      });
      return;
    }
    const active = subscriptions.get(subscriptionId);
    if (!active) {
      emit({
        jsonrpc: JSON_RPC_VERSION,
        error: {
          code: JSON_RPC_ERROR_CODES.NOT_FOUND,
          message: 'subscription not found',
          data: {
            weftCode: 'NotFound',
            httpStatus: 404,
            resource: 'subscription',
            identifier: subscriptionId,
          },
        },
        id: id ?? null,
      });
      return;
    }
    active.controller.abort();
    subscriptions.delete(subscriptionId);
    // Success response (empty result per spec — the side-effect IS
    // the termination notification that follows).
    emit({ jsonrpc: JSON_RPC_VERSION, result: {}, id: id ?? null });
    emit({
      jsonrpc: JSON_RPC_VERSION,
      method: SESSION_METHODS.TERMINATED,
      params: { subscriptionId, reason: 'client-unsubscribed' },
    });
  }

  async function handleMessage(frame: string): Promise<void> {
    if (closed) return;

    // Quick peek at the parsed shape to route subscribe/unsubscribe
    // before the dispatcher would classify them as "unknown method".
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame);
    } catch {
      emit({
        jsonrpc: JSON_RPC_VERSION,
        error: { code: JSON_RPC_ERROR_CODES.PARSE_ERROR, message: 'Parse error' },
        id: null,
      });
      return;
    }

    if (Array.isArray(parsed)) {
      emit({
        jsonrpc: JSON_RPC_VERSION,
        error: {
          code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
          message: 'batch frames are not supported over WebSocket',
        },
        id: null,
      });
      return;
    }

    if (!isPlainObject(parsed)) {
      emit({
        jsonrpc: JSON_RPC_VERSION,
        error: {
          code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
          message: 'request must be a JSON object',
        },
        id: null,
      });
      return;
    }

    const method = parsed['method'];
    if (method === SESSION_METHODS.SUBSCRIBE) {
      await handleSubscribe(
        parsed['id'] as JsonRpcId | undefined,
        parsed['params'] as Record<string, unknown> | undefined,
      );
      return;
    }
    if (method === SESSION_METHODS.UNSUBSCRIBE) {
      handleUnsubscribe(
        parsed['id'] as JsonRpcId | undefined,
        parsed['params'] as Record<string, unknown> | undefined,
      );
      return;
    }

    // Standard dispatch — the dispatcher handles parse-error / invalid-
    // request / notification elision / success / error mapping.
    const result = await dispatchJsonRpc(parsed, {
      registry,
      engine,
      principal,
      transport: 'jsonRpcWebSocket',
    });

    if (result.kind === 'single') {
      emit(result.response);
    }
    // Notifications over WS are fire-and-forget (no response frame).
    // Batch / notification-batch paths are unreachable because we
    // rejected arrays above.
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    const pending: Promise<void>[] = [];
    for (const sub of subscriptions.values()) {
      sub.controller.abort();
      pending.push(sub.pump.catch(() => {}));
    }
    subscriptions.clear();
    await Promise.all(pending);
  }

  return { handleMessage, close };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
