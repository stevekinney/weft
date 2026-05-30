/**
 * Transport plumbing for the {@link WorkflowEventSubscription}: the minimal
 * socket surface it drives, the watch-channel URL builder, the default
 * `WebSocket` factory (Bun vs. browser), and the frame parsing / overlap-dedup
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

/** True when running under Bun, whose `WebSocket` accepts custom upgrade headers. */
const isBunRuntime = typeof globalThis.Bun !== 'undefined';

/**
 * The default factory. Under Bun the second `WebSocket` argument is an options
 * bag that accepts custom upgrade headers, so auth headers ride the handshake.
 * In the browser the second argument is `protocols` (a string or string array)
 * and passing an options object would break the connection — and the browser
 * WebSocket cannot send custom headers at all — so we construct with the URL
 * alone. Tests that replace the factory bypass this entirely.
 */
export const defaultWebSocketFactory: WebSocketFactory = (url, headers) => {
  if (typeof WebSocket === 'undefined') {
    // No global `WebSocket` (e.g. older Node without the experimental flag).
    // Fail with an actionable message instead of a cryptic `ReferenceError` or
    // a silent reconnect spin to exhaustion.
    throw new Error(
      'No global WebSocket is available for live event streaming. Provide HttpClientOptions.webSocketFactory (e.g. backed by the `ws` package) or run on a runtime with a built-in WebSocket (Bun, modern browsers, Node 22+).',
    );
  }
  if (!isBunRuntime) {
    // Browser / service-worker: header-less constructor. Cross-origin auth must
    // ride a cookie or query param the server accepts, not a WebSocket header.
    return new WebSocket(url);
  }
  // Bun's two-arg overload is not in the DOM lib types, so narrow to it at
  // construction time. The cast is confined to the Bun branch.
  const Constructor = WebSocket as unknown as {
    new (url: string, options: { headers: Record<string, string> }): WebSocket;
  };
  return new Constructor(url, { headers });
};

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
