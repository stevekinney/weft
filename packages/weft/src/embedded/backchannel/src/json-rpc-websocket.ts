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

import type { ConnectionLease } from './connection-lease.ts';
import { faultErrorData, faultToJsonRpcError } from './fault-to-json-rpc.ts';
import { dispatchJsonRpc, type JsonRpcSubscription } from './json-rpc-dispatch.ts';
import { parseJsonRpcRequest } from './json-rpc-parse.ts';
import {
  JSON_RPC_ERROR_CODES,
  JSON_RPC_VERSION,
  type JsonRpcId,
  type JsonRpcResponse,
} from './json-rpc-protocol.ts';
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

type PendingSubscription = {
  readonly controller: AbortController;
};

async function closeSubscriptionAfterClose(closeSubscription: () => Promise<void>): Promise<void> {
  await closeSubscription().catch(() => {});
}

type SessionRequest = {
  readonly id: JsonRpcId | undefined;
  readonly expectsResponse: boolean;
};

type SubscriptionStart = {
  readonly subscription?: JsonRpcSubscription;
  readonly response?: JsonRpcResponse;
};

async function startLegacySubscription(
  request: SessionRequest,
  execution: Promise<DispatchResult<JsonRpcSubscription>>,
): Promise<SubscriptionStart> {
  const result = await execution;
  const id = request.id ?? null;
  if (!result.ok) {
    const error = faultToJsonRpcError(result.fault);
    return { response: { jsonrpc: JSON_RPC_VERSION, id, error } };
  }
  const subscription = result.value;
  return {
    subscription,
    response: {
      jsonrpc: JSON_RPC_VERSION,
      id,
      result: {
        subscriptionId: subscription.subscriptionId,
        cursor: (subscription.envelope as SubscriptionStartEnvelope).cursor,
      },
    },
  };
}

function requiresSubscriptionClose(disposed: boolean, signal: AbortSignal): boolean {
  return disposed || signal.aborted;
}

function releaseSubscriptionLease(lease: ConnectionLease | undefined): void {
  lease?.release();
}

function acquireSubscriptionLease(
  acquire: (() => ConnectionLease) | undefined,
): ConnectionLease | undefined {
  return acquire?.();
}

function isSessionPrimitive(method: unknown): boolean {
  return (
    method === SESSION_METHODS.SUBSCRIBE ||
    method === WORKFLOW_EVENTS_OPERATION_NAME ||
    method === SESSION_METHODS.FLEET_SUBSCRIBE ||
    method === SESSION_METHODS.UNSUBSCRIBE
  );
}

/** Builds a JSON-RPC session over an emitter and an operation registry. */
export function createJsonRpcWebSocketSession(
  options: JsonRpcWebSocketSessionOptions,
): JsonRpcWebSocketSession {
  const {
    registry,
    engine,
    principal,
    emitter,
    feed,
    fleetFeed,
    discoverDocument,
    acquireWorkflowSubscription,
    acquireFleetSubscription,
  } = options;
  const maxSubscriptions = options.maxSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const transport = options.transport ?? 'jsonRpcWebSocket';
  const subscriptions = new Map<string, ActiveSubscription>();
  const pendingSubscriptions = new Set<PendingSubscription>();
  // Keep emitter failure separate from disposal so close() still tears down
  // active subscriptions after a socket send fails.
  let emitterBroken = false;
  let disposed = false;

  /** Send a frame while containing closed-socket failures. */
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

    await startSubscription(
      request,
      (signal) =>
        startLegacySubscription(
          request,
          executeSubscription(
            WORKFLOW_EVENTS_OPERATION_NAME,
            {
              workflowId: validation.workflowId,
              selector: validation.selector,
              ...(validation.fromCursor === undefined ? {} : { fromCursor: validation.fromCursor }),
            },
            {
              principal,
              host: { feed },
              // Subscribe is a session primitive, but the transport identity still
              // needs to reflect the adapter reusing this implementation so
              // availability checks enforce stdio-only and websocket-only policies.
              transport,
              registry,
              signal,
            },
          ),
        ),
      acquireWorkflowSubscription,
    );
  }

  async function handleFleetSubscribe(
    request: SessionRequest,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    await startSubscription(
      request,
      (signal) =>
        startLegacySubscription(
          request,
          executeSubscription(FLEET_EVENTS_OPERATION_NAME, params ?? {}, {
            principal,
            host: { fleetFeed },
            transport,
            registry,
            signal,
          }),
        ),
      acquireFleetSubscription,
    );
  }

  async function startSubscription(
    request: SessionRequest,
    execute: (signal: AbortSignal) => Promise<SubscriptionStart>,
    acquire?: () => ConnectionLease,
  ): Promise<void> {
    if (subscriptions.size >= maxSubscriptions) {
      emitResponse(request, {
        jsonrpc: JSON_RPC_VERSION,
        error: {
          code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
          message: `maximum concurrent subscriptions per session (${maxSubscriptions}) exceeded`,
          data: faultErrorData('Unprocessable', {
            reason: 'per-session subscription cap exceeded',
          }),
        },
        id: request.id ?? null,
      });
      return;
    }

    const controller = new AbortController();
    const pending: PendingSubscription = { controller };
    pendingSubscriptions.add(pending);
    let result: SubscriptionStart;
    try {
      result = await execute(controller.signal);
    } finally {
      pendingSubscriptions.delete(pending);
    }
    if (result.subscription === undefined) {
      if (result.response !== undefined) emitResponse(request, result.response);
      return;
    }

    const { subscriptionId, iterable, close: closeSubscription } = result.subscription;
    let closeStarted = false;
    const closeOnce = async (): Promise<void> => {
      if (closeStarted) return;
      closeStarted = true;
      await closeSubscription();
    };
    if (requiresSubscriptionClose(disposed, controller.signal)) {
      await closeSubscriptionAfterClose(closeOnce);
      return;
    }
    const lease = acquireSubscriptionLease(acquire);
    if (result.response !== undefined) emitResponse(request, result.response);

    const pump = pumpSubscriptionIterable({
      subscriptionId,
      iterable,
      signal: controller.signal,
      closeSubscription: closeOnce,
      shouldSuppressOutput,
      emit,
      onComplete: () => {
        releaseSubscriptionLease(lease);
        subscriptions.delete(subscriptionId);
      },
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
          data: faultErrorData('InvalidParams'),
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
          data: faultErrorData('NotFound', {
            resource: 'subscription',
            identifier: subscriptionId,
          }),
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

  async function handleCatalogMethod(
    validation: ReturnType<typeof validateMessageFrame> & { ok: true },
  ): Promise<boolean> {
    if (isSessionPrimitive(validation.method)) {
      const feedDependentPrimitive =
        validation.method === SESSION_METHODS.SUBSCRIBE ||
        validation.method === WORKFLOW_EVENTS_OPERATION_NAME;
      if (feed === undefined && feedDependentPrimitive) {
        return false;
      }
      await handleSessionPrimitive(validation);
      return true;
    }

    const method = validation.method;
    if (typeof method === 'string' && registry.get(method)?.kind === 'subscription') {
      const request: SessionRequest = {
        id: validation.id,
        expectsResponse: validation.hasRequestId,
      };
      const parsed = parseJsonRpcRequest(validation.parsed);
      if (parsed.kind === 'invalid-request') {
        emit({
          jsonrpc: JSON_RPC_VERSION,
          error: { code: parsed.code, message: parsed.message },
          id: parsed.id,
        });
        return true;
      }
      await startSubscription(request, async (signal) => {
        let subscription: JsonRpcSubscription | undefined;
        const result = await dispatchJsonRpc(validation.parsed, {
          registry,
          host: engine,
          principal,
          transport,
          signal,
          acceptSubscription(started) {
            subscription = started;
          },
        });
        return {
          ...(subscription === undefined ? {} : { subscription }),
          ...(result.kind === 'single' ? { response: result.response } : {}),
        };
      });
      return true;
    }
    return false;
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

    if (await handleCatalogMethod(validation)) return;

    await dispatchStandard(validation);
  }

  async function dispatchStandard(
    validation: ReturnType<typeof validateMessageFrame> & { ok: true },
  ): Promise<void> {
    // Standard dispatch — the dispatcher handles parse-error / invalid-
    // request / notification elision / success / error mapping.
    const result = await dispatchJsonRpc(validation.parsed, {
      registry,
      host: engine,
      principal,
      transport,
      ...(discoverDocument === undefined ? {} : { discoverDocument }),
    });

    if (result.kind === 'single') {
      emit(result.response);
    }
    // Notifications over WS are fire-and-forget (no response frame).
    // Batch / notification-batch paths are unreachable because we rejected arrays above.
  }

  async function close(): Promise<void> {
    if (disposed) return;
    disposed = true;
    const pendingCloses: Promise<void>[] = [];
    for (const sub of subscriptions.values()) {
      sub.controller.abort();
      pendingCloses.push(sub.pump.catch(() => {}));
    }
    for (const pending of pendingSubscriptions) {
      pending.controller.abort();
    }
    subscriptions.clear();
    await Promise.all(pendingCloses);
  }

  return { handleMessage, close };
}
