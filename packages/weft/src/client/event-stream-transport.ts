/**
 * Transport plumbing for the {@link WorkflowEventSubscription}: the minimal
 * socket surface it drives, the watch-channel URL builder, the default
 * `WebSocket` factories (header-less vs. header-carrying), and the frame parsing / overlap-dedup
 * helpers. Kept separate from the subscription state machine so each file stays
 * small and the pure helpers are independently testable.
 *
 * @module client/event-stream-transport
 */

import type { WorkflowEvent } from '../core/types.ts';

/** Minimal socket surface the subscription drives. Matches `WebSocket`. */
export type StreamSocket = {
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
};

/** Builds a {@link StreamSocket} for a `ws(s)://…/watch` URL with headers. */
export type WebSocketFactory = (url: string, headers: Record<string, string>) => StreamSocket;

/**
 * Build the absolute `ws(s)://…/v1/workflows/:id/watch` URL for a workflow's
 * live event channel from a client base URL.
 *
 * An absolute `http(s)://…` base URL has its scheme swapped to `ws(s):`. A
 * relative base URL (`''`, `'/'`, `'/weft'` — the forms browser and
 * service-worker deployments use, where REST `fetch` resolves against the page
 * origin) is resolved against `globalThis.location` so the result is always the
 * absolute URL the `WebSocket` constructor requires. When no `location` is
 * available (e.g. a non-browser runtime given a relative base), the relative
 * base is returned unchanged — the same input REST `fetch` would also reject.
 */
export function workflowWatchWebSocketUrl(baseUrl: string, workflowId: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  const path = `/v1/workflows/${encodeURIComponent(workflowId)}/watch`;

  if (/^https?:/i.test(trimmed)) {
    const wsBase = trimmed.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
    return `${wsBase}${path}`;
  }

  // Relative base: resolve against the page origin, mirroring how the REST
  // `fetch` path resolves relative `baseUrl` values in the browser.
  const origin = globalThis.location?.origin;
  if (origin === undefined) return `${trimmed}${path}`;
  const wsOrigin = origin.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  return `${wsOrigin}${trimmed}${path}`;
}

function assertGlobalWebSocket(): void {
  if (typeof WebSocket === 'undefined') {
    // No global `WebSocket` (e.g. older Node without the experimental flag).
    // Fail with an actionable message instead of a cryptic `ReferenceError` or
    // a silent reconnect spin to exhaustion.
    throw new Error(
      'No global WebSocket is available for live event streaming. Provide HttpClientOptions.webSocketFactory (e.g. backed by the `ws` package) or run on a runtime with a built-in WebSocket (Bun, modern browsers, Node 22+).',
    );
  }
}

/**
 * The default factory. It assumes the platform `WebSocket` cannot send custom
 * upgrade headers, which is true of browsers, service workers, and Node's
 * global `WebSocket` (undici); the second constructor argument there is
 * `protocols`, not an options bag. With no headers configured it constructs
 * with the URL alone. With headers configured, silently dropping a configured
 * `Authorization`/`token` would produce an unauthenticated socket that fails or
 * reconnects forever against an auth-enabled server, so it throws an explicit
 * configuration error pointing at `HttpClientOptions.webSocketFactory` (for
 * example backed by the `ws` package, which supports headers) and at
 * `HttpClientOptions.webSocketCarriesHeaders` for a global `WebSocket` that does
 * carry them. Under `eventTransport: 'auto'` that error is what routes a
 * header-carrying connection to the SSE fallback.
 *
 * Tests that replace the factory bypass this entirely.
 */
export const defaultWebSocketFactory: WebSocketFactory = (url, headers) => {
  assertGlobalWebSocket();
  if (Object.keys(headers).length > 0) {
    throw new Error(
      'Live event streaming cannot send the configured auth headers over WebSocket: the platform WebSocket constructor has no header support. Declare HttpClientOptions.webSocketCarriesHeaders when the global WebSocket accepts an options bag with headers (Bun does), provide HttpClientOptions.webSocketFactory (e.g. backed by the `ws` package, which supports headers), or authenticate the watch socket with a cookie or query parameter the server accepts.',
    );
  }
  return new WebSocket(url);
};

/**
 * The factory used when the caller declares
 * `HttpClientOptions.webSocketCarriesHeaders`: the global `WebSocket` accepts an
 * options bag as its second argument (Bun's extension), so auth headers ride the
 * upgrade handshake.
 */
export const headerCarryingWebSocketFactory: WebSocketFactory = (url, headers) => {
  assertGlobalWebSocket();
  // The two-arg options-bag overload is not in the DOM lib types, so narrow to it
  // at construction time. The cast is confined to this declared-header branch.
  const Constructor = WebSocket as unknown as {
    new (url: string, options: { headers: Record<string, string> }): WebSocket;
  };
  return new Constructor(url, { headers });
};

/**
 * Pick the factory a subscription constructs its socket with: the caller's own
 * `webSocketFactory`, else the header-carrying factory when the caller declared
 * `webSocketCarriesHeaders`, else the header-less {@link defaultWebSocketFactory}.
 */
export function selectWebSocketFactory(options?: {
  readonly webSocketFactory?: WebSocketFactory;
  readonly webSocketCarriesHeaders?: boolean;
}): WebSocketFactory {
  if (options?.webSocketFactory !== undefined) return options.webSocketFactory;
  return options?.webSocketCarriesHeaders === true
    ? headerCarryingWebSocketFactory
    : defaultWebSocketFactory;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Structural equality for deduping the catch-up/live overlap window. Events
 * carry no stable id, so a `type` + serialized-`data` comparison is the
 * pragmatic identity. `timestamp` is excluded because the live frame and the
 * persisted history record are stamped independently and can differ by a few
 * milliseconds for the same logical event.
 */
export function eventsEqual(a: WorkflowEvent, b: WorkflowEvent): boolean {
  return a.type === b.type && JSON.stringify(a.data) === JSON.stringify(b.data);
}

/**
 * Drop the `buffered` live frames that the replayed `history` already covered
 * (the overlap window), returning the genuinely new frames in order. The dedup
 * is *consuming*: each history entry can cancel at most one live frame, so two
 * structurally identical events (e.g. two rapid signals with the same name and
 * payload) where only one is a true overlap duplicate keep the genuinely new one
 * instead of both being dropped. Shared by both client transports' catch-up.
 */
export function dropOverlappingLiveFrames(
  history: readonly WorkflowEvent[],
  buffered: readonly WorkflowEvent[],
): WorkflowEvent[] {
  const historyConsumed: boolean[] = Array.from(history, () => false);
  const fresh: WorkflowEvent[] = [];
  for (const live of buffered) {
    const overlapIndex = history.findIndex(
      (historic, index) => !historyConsumed[index] && eventsEqual(historic, live),
    );
    if (overlapIndex !== -1) {
      historyConsumed[overlapIndex] = true;
      continue;
    }
    fresh.push(live);
  }
  return fresh;
}

/** Parse a watch-channel frame into a {@link WorkflowEvent}, or null if malformed. */
export function parseWatchFrame(raw: unknown): WorkflowEvent | null {
  if (typeof raw !== 'string') return null;
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(frame)) return null;
  const { type } = frame;
  if (typeof type !== 'string') return null;
  return {
    type,
    timestamp: typeof frame['timestamp'] === 'number' ? frame['timestamp'] : Date.now(),
    data: isRecord(frame['data']) ? frame['data'] : {},
  };
}
