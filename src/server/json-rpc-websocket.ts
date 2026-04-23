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
import {
  JSON_RPC_ERROR_CODES,
  JSON_RPC_VERSION,
  isValidJsonRpcId,
  type JsonRpcId,
} from './json-rpc-protocol.ts';
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
  /**
   * Maximum concurrent subscriptions per session. Default 100 — a
   * well-behaved client should never need more. Rejected `subscribe`
   * requests above the cap return `InvalidRequest (-32600)` so clients
   * can distinguish resource exhaustion from other failures.
   */
  readonly maxSubscriptions?: number;
  /**
   * Maximum size of a single incoming frame in bytes. Default 1 MB.
   * Frames exceeding the limit are rejected with a parse error before
   * `JSON.parse` touches the payload — a runaway producer cannot force
   * an unbounded allocation inside the adapter.
   */
  readonly maxFrameBytes?: number;
  /**
   * Transport identity for the dispatcher's transport-availability
   * check. Defaults to `'jsonRpcWebSocket'`. The stdio session reuses
   * this factory but must pass `'jsonRpcStdio'` so operations with
   * `transports.jsonRpcStdio: false` are rejected on stdio and,
   * conversely, operations that are stdio-only aren't rejected just
   * because they haven't been enabled for WS.
   */
  readonly transport?: 'jsonRpcHttp' | 'jsonRpcWebSocket' | 'jsonRpcStdio';
};

const DEFAULT_MAX_SUBSCRIPTIONS = 100;
const DEFAULT_MAX_FRAME_BYTES = 1 * 1024 * 1024;
const INITIAL_SUBSCRIPTION_CURSOR: Cursor = '-1';

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
  isTerminating: boolean;
};

type SessionRequest = {
  readonly id: JsonRpcId | undefined;
  readonly expectsResponse: boolean;
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

export function createJsonRpcWebSocketSession(
  options: JsonRpcWebSocketSessionOptions,
): JsonRpcWebSocketSession {
  const { registry, engine, principal, emitter, feed } = options;
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

  // Session-scoped monotonic counter. Scoping to the session (rather
  // than a module-level global) keeps IDs unique within a connection,
  // eliminates cross-session ID collision possibilities, and avoids
  // test pollution — each session starts fresh.
  let subscriptionSequence = 0;
  function generateSubscriptionId(): string {
    subscriptionSequence += 1;
    return `sub_${Date.now().toString(36)}_${subscriptionSequence.toString(36)}`;
  }

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

  async function handleSubscribe(
    request: SessionRequest,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    const workflowId = params?.['workflowId'];
    const rawSelector = params?.['selector'];
    const rawFromCursor = params?.['fromCursor'];
    if (typeof workflowId !== 'string' || workflowId.length === 0) {
      emitResponse(request, {
        jsonrpc: JSON_RPC_VERSION,
        error: {
          code: JSON_RPC_ERROR_CODES.INVALID_PARAMS,
          message: 'params.workflowId must be a non-empty string',
          data: { weftCode: 'InvalidParams', httpStatus: 400 },
        },
        id: request.id ?? null,
      });
      return;
    }
    if (rawSelector !== 'events' && rawSelector !== 'tokens') {
      emitResponse(request, {
        jsonrpc: JSON_RPC_VERSION,
        error: {
          code: JSON_RPC_ERROR_CODES.INVALID_PARAMS,
          message: "params.selector must be 'events' or 'tokens'",
          data: { weftCode: 'InvalidParams', httpStatus: 400 },
        },
        id: request.id ?? null,
      });
      return;
    }
    const selector: EventSelector = rawSelector;
    let fromCursor: Cursor | undefined;
    if (rawFromCursor !== undefined) {
      if (typeof rawFromCursor !== 'string') {
        emitResponse(request, {
          jsonrpc: JSON_RPC_VERSION,
          error: {
            code: JSON_RPC_ERROR_CODES.INVALID_PARAMS,
            message: 'params.fromCursor must be a string when present',
            data: { weftCode: 'InvalidParams', httpStatus: 400 },
          },
          id: request.id ?? null,
        });
        return;
      }
      fromCursor = rawFromCursor;
    }

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

    const subscriptionId = generateSubscriptionId();
    const controller = new AbortController();

    // The `cursor` field is the "resume here" value a client may pass
    // back as `fromCursor` on reconnect. A fresh subscription starts
    // before sequence 0, not at sequence 0: replay uses strict
    // greater-than semantics, so returning `'0'` would skip the first
    // event if a client reconnects before receiving any deliveries.
    const startingCursor: Cursor = fromCursor ?? INITIAL_SUBSCRIPTION_CURSOR;

    emitResponse(request, {
      jsonrpc: JSON_RPC_VERSION,
      result: { subscriptionId, cursor: startingCursor },
      id: request.id ?? null,
    });

    const pump = pumpSubscription(
      subscriptionId,
      workflowId,
      selector,
      fromCursor,
      controller.signal,
    );
    subscriptions.set(subscriptionId, {
      id: subscriptionId,
      controller,
      pump,
      isTerminating: false,
    });
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
      // Natural termination path. The feed closes the iterable for
      // three reasons: abort (client unsubscribed — handled via the
      // abort path), buffer overflow, or workflow terminal-state
      // cleanup. Today the feed does not distinguish those two
      // non-abort cases at its API surface, so we report a generic
      // `server-closed` reason without claiming it was overflow —
      // the client can reopen with its last cursor and replay missed
      // events either way. When the feed gains an explicit
      // terminal-reason signal (a planned future refinement) this
      // can carry it through to `workflow-terminal` / `overflow`.
      if (!signal.aborted && !shouldSuppressOutput()) {
        emit({
          jsonrpc: JSON_RPC_VERSION,
          method: SESSION_METHODS.TERMINATED,
          params: { subscriptionId, reason: 'server-closed' },
        });
      }
    } catch {
      // Unexpected error in the subscription pump — surface a
      // server-closed terminated notification with a generic public
      // message, then fall through. Error detail is the logger's
      // domain; the wire must not carry potentially-sensitive data
      // from a thrown value of unknown origin.
      if (!shouldSuppressOutput()) {
        emit({
          jsonrpc: JSON_RPC_VERSION,
          method: SESSION_METHODS.TERMINATED,
          params: {
            subscriptionId,
            reason: 'server-closed',
            fault: { code: 'EngineFailure', message: 'internal error', data: {} },
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

  async function handleMessage(frame: string): Promise<void> {
    if (disposed || emitterBroken) return;

    // Reject frames over the size cap before `JSON.parse` touches the
    // payload. A runaway producer otherwise forces an unbounded parse
    // allocation inside the adapter. Measure UTF-8 BYTE length, not
    // string length (`frame.length` counts UTF-16 code units, so a
    // multi-byte unicode payload could slip past the cap).
    const frameByteLength = Buffer.byteLength(frame, 'utf8');
    if (frameByteLength > maxFrameBytes) {
      emit({
        jsonrpc: JSON_RPC_VERSION,
        error: {
          code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
          message: `frame size exceeds limit of ${maxFrameBytes} bytes`,
        },
        id: null,
      });
      return;
    }

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

    // Narrow id via the runtime guard rather than an `as` cast —
    // invalid ids (booleans, objects, NaN) become `undefined` instead
    // of silently flowing through as garbage.
    const rawId = parsed['id'];
    const hasRequestId = Object.hasOwn(parsed, 'id');
    const narrowedId: JsonRpcId | undefined = isValidJsonRpcId(rawId) ? rawId : undefined;
    const rawParams = parsed['params'];
    const narrowedParams: Record<string, unknown> | undefined = isPlainObject(rawParams)
      ? rawParams
      : undefined;

    const method = parsed['method'];
    // Session-primitive routing shares the same jsonrpc-version
    // validation the standard dispatcher enforces — otherwise
    // subscribe/unsubscribe would silently accept frames missing or
    // with the wrong `jsonrpc` field while every other method
    // rejects them as InvalidRequest.
    if (method === SESSION_METHODS.SUBSCRIBE || method === SESSION_METHODS.UNSUBSCRIBE) {
      if (parsed['jsonrpc'] !== JSON_RPC_VERSION) {
        emit({
          jsonrpc: JSON_RPC_VERSION,
          error: {
            code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
            message: `jsonrpc field must be exactly "${JSON_RPC_VERSION}"`,
          },
          id: narrowedId ?? null,
        });
        return;
      }
      if (hasRequestId && !isValidJsonRpcId(rawId)) {
        emit({
          jsonrpc: JSON_RPC_VERSION,
          error: {
            code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
            message: 'id must be a string, number, null, or absent',
          },
          id: null,
        });
        return;
      }
      const request: SessionRequest = { id: narrowedId, expectsResponse: hasRequestId };
      if (method === SESSION_METHODS.SUBSCRIBE) {
        await handleSubscribe(request, narrowedParams);
      } else {
        handleUnsubscribe(request, narrowedParams);
      }
      return;
    }

    // Standard dispatch — the dispatcher handles parse-error / invalid-
    // request / notification elision / success / error mapping.
    const result = await dispatchJsonRpc(parsed, {
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
