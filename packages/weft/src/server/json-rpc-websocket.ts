/**
 * WebSocket JSON-RPC session adapter.
 *
 * Each `/jsonrpc` WebSocket connection gets one `JsonRpcWebSocketSession`
 * that binds the authenticated principal at upgrade time and reuses it
 * for every frame. The session:
 *   - Parses incoming frames as single JSON-RPC requests (batches over
 *     WS are rejected per stable operation-catalog contract).
 *   - Dispatches `weft.workflows.subscribe` / `weft.workflows.unsubscribe`
 *     as first-class session primitives against the `WorkflowEventFeed`.
 *   - Delegates all other methods to the standard `dispatchJsonRpc`.
 *   - Emits live envelopes as `weft.events.deliver` notifications keyed
 *     by the assigned `subscriptionId`.
 *   - Guarantees every active subscription is torn down on `close()`
 *     (or socket disconnect at the transport layer).
 */

import { faultToJsonRpcError } from './fault-to-json-rpc.ts';
import { dispatchJsonRpc } from './json-rpc-dispatch.ts';
import { JSON_RPC_ERROR_CODES, JSON_RPC_VERSION, type JsonRpcId } from './json-rpc-protocol.ts';
import { pumpSubscriptionIterable } from './json-rpc-websocket-subscription-pump.ts';
import {
  FLEET_EVENTS_OPERATION_NAME,
  SESSION_METHODS,
  WORKFLOW_EVENTS_OPERATION_NAME,
} from './json-rpc-websocket-subscriptions.ts';
import type {
  JsonRpcWebSocketSession,
  JsonRpcWebSocketSessionOptions,
} from './json-rpc-websocket-types.ts';
import {
  validateMessageFrame,
  validateSessionPrimitiveFrame,
  validateSubscribeParams,
} from './json-rpc-websocket-validation.ts';
import {
  executeSubscription,
  type DispatchResult,
  type SubscriptionStartEnvelope,
} from './operation-catalog.ts';

export type {
  JsonRpcWebSocketEmitter,
  JsonRpcWebSocketSession,
  JsonRpcWebSocketSessionOptions,
} from './json-rpc-websocket-types.ts';

const DEFAULT_MAX_SUBSCRIPTIONS = 100;
const DEFAULT_MAX_FRAME_BYTES = 1 * 1024 * 1024;

type ActiveSubscription = {
  readonly id: string;
  readonly controller: AbortController;
  readonly pump: Promise<void>;
  isTerminating: boolean;
};

type SessionRequest = {
  readonly id: JsonRpcId | undefined;
  readonly expectsResponse: boolean;
};

type SubscriptionExecution = Promise<
  DispatchResult<{
    envelope: unknown;
    iterable: AsyncIterable<unknown>;
    close: () => Promise<void>;
  }>
>;

function isSubscriptionStartEnvelope(value: unknown): value is SubscriptionStartEnvelope {
  if (value === null || typeof value !== 'object') return false;
  if (!('subscriptionId' in value) || !('cursor' in value)) return false;
  return typeof value.subscriptionId === 'string' && typeof value.cursor === 'string';
}

function isSessionPrimitive(method: unknown): boolean {
  return (
    method === SESSION_METHODS.SUBSCRIBE ||
    method === WORKFLOW_EVENTS_OPERATION_NAME ||
    method === SESSION_METHODS.FLEET_SUBSCRIBE ||
    method === SESSION_METHODS.UNSUBSCRIBE
  );
}

export function createJsonRpcWebSocketSession(
  options: JsonRpcWebSocketSessionOptions,
): JsonRpcWebSocketSession {
  const { registry, engine, principal, emitter, feed, fleetFeed } = options;
  const maxSubscriptions = options.maxSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const transport = options.transport ?? 'jsonRpcWebSocket';
  const subscriptions = new Map<string, ActiveSubscription>();
  // `emitterBroken` tracks the emitter's liveness — set to `true` only
  // when `emitter.send` (or `JSON.stringify`) throws. `disposed`
  // tracks whether `close()` ran — drives subscription teardown.
  // Keeping them separate means a broken emitter does NOT skip the
  // cleanup path in `close()`; background pumps would otherwise leak
  // feed listeners indefinitely, spinning `deliver` → no-op `emit`.
  let emitterBroken = false;
  let disposed = false;

  /**
   * Send a frame on the wire. Guards against emitter failures: a
   * thrown `JSON.stringify` (circular reference) or a thrown
   * `emitter.send` (closed socket) cannot bubble into background
   * subscription pumps as an unhandled rejection — swallowed here
   * with `emitterBroken` set so subsequent emits are silent no-ops.
   * Critically this does NOT set `disposed`: `close()` must still run
   * its cleanup path to abort active subscriptions; otherwise the
   * pumps leak feed listeners indefinitely.
   */
  function emit(message: Record<string, unknown>): void {
    if (disposed || emitterBroken) return;
    try {
      emitter.send(JSON.stringify(message));
    } catch {
      emitterBroken = true;
    }
  }

  function shouldSuppressOutput(): boolean {
    return disposed || emitterBroken;
  }

  function emitResponse(request: SessionRequest, message: Record<string, unknown>): void {
    if (request.expectsResponse) emit(message);
  }

  // AUDIT-EXEMPT: stateful WebSocket session lifecycle primitive. Listed in
  // `src/server/operation-catalog/dispatch-allowlist.ts`. The cataloged
  // `weft.workflows.events` subscription operation (introduced in PR 3) will
  // route through `executeSubscription`; this handler remains the lifecycle
  // wrapper.
  async function handleSubscribe(
    request: SessionRequest,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    const validation = validateSubscribeParams(params);
    if (!validation.ok) {
      emitResponse(request, {
        jsonrpc: JSON_RPC_VERSION,
        error: validation.error,
        id: request.id ?? null,
      });
      return;
    }

    await startSubscription(request, () =>
      executeSubscription(
        WORKFLOW_EVENTS_OPERATION_NAME,
        {
          workflowId: validation.workflowId,
          selector: validation.selector,
          ...(validation.fromCursor === undefined ? {} : { fromCursor: validation.fromCursor }),
        },
        {
          principal,
          engine: { feed },
          // Subscribe is a session primitive, but the transport identity still
          // needs to reflect the adapter reusing this implementation so
          // availability checks enforce stdio-only and websocket-only policies.
          transport,
          registry,
        },
      ),
    );
  }

  async function handleFleetSubscribe(
    request: SessionRequest,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    await startSubscription(request, () =>
      executeSubscription(FLEET_EVENTS_OPERATION_NAME, params ?? {}, {
        principal,
        engine: { fleetFeed },
        transport,
        registry,
      }),
    );
  }

  async function startSubscription(
    request: SessionRequest,
    execute: () => SubscriptionExecution,
  ): Promise<void> {
    if (subscriptions.size >= maxSubscriptions) {
      emitResponse(request, {
        jsonrpc: JSON_RPC_VERSION,
        error: {
          code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
          message: `maximum concurrent subscriptions per session (${maxSubscriptions}) exceeded`,
          data: {
            weftCode: 'Unprocessable',
            httpStatus: 422,
            reason: 'per-session subscription cap exceeded',
          },
        },
        id: request.id ?? null,
      });
      return;
    }

    const controller = new AbortController();
    const result = await execute();
    if (!result.ok) {
      const error = faultToJsonRpcError(result.fault);
      emitResponse(request, {
        jsonrpc: JSON_RPC_VERSION,
        error: { code: error.code, message: error.message, data: error.data },
        id: request.id ?? null,
      });
      return;
    }

    const { envelope, iterable, close: closeSubscription } = result.value;
    if (!isSubscriptionStartEnvelope(envelope)) {
      await closeSubscription().catch(() => {});
      emitResponse(request, {
        jsonrpc: JSON_RPC_VERSION,
        error: { code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR, message: 'internal error' },
        id: request.id ?? null,
      });
      return;
    }
    const { subscriptionId, cursor } = envelope;

    emitResponse(request, {
      jsonrpc: JSON_RPC_VERSION,
      result: { subscriptionId, cursor },
      id: request.id ?? null,
    });

    const pump = pumpSubscriptionIterable({
      subscriptionId,
      iterable,
      signal: controller.signal,
      closeSubscription,
      shouldSuppressOutput,
      emit,
      onComplete: () => subscriptions.delete(subscriptionId),
    });
    subscriptions.set(subscriptionId, {
      id: subscriptionId,
      controller,
      pump,
      isTerminating: false,
    });
  }

  // AUDIT-EXEMPT: stateful WebSocket session lifecycle primitive. Listed in
  // `src/server/operation-catalog/dispatch-allowlist.ts`. The cataloged
  // `weft.workflows.events` subscription operation (introduced in PR 3) will
  // route through `executeSubscription`; this handler remains the lifecycle
  // wrapper.
  function handleUnsubscribe(
    request: SessionRequest,
    params: Record<string, unknown> | undefined,
  ): void {
    const subscriptionId = params?.['subscriptionId'];
    if (typeof subscriptionId !== 'string') {
      emitResponse(request, {
        jsonrpc: JSON_RPC_VERSION,
        error: {
          code: JSON_RPC_ERROR_CODES.INVALID_PARAMS,
          message: 'params.subscriptionId must be a string',
          data: { weftCode: 'InvalidParams', httpStatus: 400 },
        },
        id: request.id ?? null,
      });
      return;
    }
    const active = subscriptions.get(subscriptionId);
    if (!active || active.isTerminating) {
      emitResponse(request, {
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
        id: request.id ?? null,
      });
      return;
    }
    active.isTerminating = true;
    active.controller.abort();
    // Success response (empty result per spec — the side-effect IS
    // the termination notification that follows).
    emitResponse(request, { jsonrpc: JSON_RPC_VERSION, result: {}, id: request.id ?? null });
    emit({
      jsonrpc: JSON_RPC_VERSION,
      method: SESSION_METHODS.TERMINATED,
      params: { subscriptionId, reason: 'client-unsubscribed' },
    });
  }

  async function handleSessionPrimitive(
    validation: ReturnType<typeof validateMessageFrame> & { ok: true },
  ): Promise<void> {
    const sessionPrimitiveError = validateSessionPrimitiveFrame(validation);
    if (sessionPrimitiveError !== null) {
      emit({
        jsonrpc: JSON_RPC_VERSION,
        error: sessionPrimitiveError.error,
        id: sessionPrimitiveError.id,
      });
      return;
    }
    const request: SessionRequest = {
      id: validation.id,
      expectsResponse: validation.hasRequestId,
    };
    if (
      validation.method === SESSION_METHODS.SUBSCRIBE ||
      validation.method === WORKFLOW_EVENTS_OPERATION_NAME
    ) {
      await handleSubscribe(request, validation.params);
    } else if (validation.method === SESSION_METHODS.FLEET_SUBSCRIBE) {
      await handleFleetSubscribe(request, validation.params);
    } else {
      handleUnsubscribe(request, validation.params);
    }
  }

  async function handleMessage(frame: string): Promise<void> {
    if (disposed || emitterBroken) return;

    const validation = validateMessageFrame(frame, maxFrameBytes);
    if (!validation.ok) {
      emit({
        jsonrpc: JSON_RPC_VERSION,
        error: validation.error,
        id: validation.id,
      });
      return;
    }

    if (isSessionPrimitive(validation.method)) {
      await handleSessionPrimitive(validation);
      return;
    }

    // Standard dispatch — the dispatcher handles parse-error / invalid-
    // request / notification elision / success / error mapping.
    const result = await dispatchJsonRpc(validation.parsed, {
      registry,
      engine,
      principal,
      transport,
    });

    if (result.kind === 'single') {
      emit(result.response);
    }
    // Notifications over WS are fire-and-forget (no response frame).
    // Batch / notification-batch paths are unreachable because we
    // rejected arrays above.
  }

  async function close(): Promise<void> {
    if (disposed) return;
    disposed = true;
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
