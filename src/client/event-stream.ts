/**
 * Live workflow-event streaming for {@link HttpClient}.
 *
 * The server broadcasts a workflow's lifecycle events over a per-workflow
 * WebSocket channel at `/v1/workflows/:id/watch` (see the server's
 * `wireEventBroadcasting`). Each frame is a JSON {@link WorkflowEvent}
 * (`{ type, timestamp, data }`) — the same shape `getEvents()` returns and the
 * dashboard already consumes. This module opens that channel and exposes the
 * events through two surfaces:
 *
 *   - a push callback (`onEvent`) used by {@link HttpHandle.addEventListener}
 *     so listeners fire the moment an event lands instead of on a 2-second
 *     poll cadence, and
 *   - an {@link AsyncIterable} used by `client.tail(id)` / `handle.tail()`.
 *
 * **Catch-up + reconnect.** The watch channel is live-only — it does not replay
 * events that happened before the socket connected, and a dropped socket can
 * miss events while disconnected. To close both gaps the subscription fetches
 * the persisted event history (`getEvents`) on every (re)connect and emits any
 * events past the count already delivered, then drops any live frame buffered
 * during the fetch that the replayed history already covered (the overlap
 * window). Reconnect attempts back off and are capped so a wedged server cannot
 * spin forever.
 *
 * **Clean close.** `close()` closes the socket and resolves the iterable.
 * Terminal workflow events (`completed`, `failed`, `cancelled`, `timed-out`)
 * auto-close the stream so `for await` consumers terminate when the workflow
 * finishes.
 *
 * @module client/event-stream
 */

import type { WorkflowEvent } from '../core/types.ts';

/** Reason a {@link WorkflowEventSubscription} terminated. */
export type StreamCloseReason = 'workflow-terminal' | 'client-closed' | 'reconnect-exhausted';

/** Fetches a workflow's persisted event history for connect/reconnect catch-up. */
export type EventHistoryFetcher = (workflowId: string) => Promise<WorkflowEvent[]>;

/** Options for opening a workflow event subscription. */
export type WorkflowEventStreamOptions = {
  /** Maximum reconnect attempts after a dropped socket. Default 5. */
  readonly maxReconnectAttempts?: number;
  /** Base reconnect backoff in milliseconds. Default 50. */
  readonly reconnectBackoffMs?: number;
  /**
   * Constructor override for the underlying socket. Tests inject a fake here;
   * production omits it and the global `WebSocket` is used.
   */
  readonly webSocketFactory?: WebSocketFactory;
};

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

const TERMINAL_EVENT_TYPES = new Set<string>([
  'workflow:completed',
  'workflow:failed',
  'workflow:cancelled',
  'workflow:timed-out',
]);

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_RECONNECT_BACKOFF_MS = 50;

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

/** The minimal client context a workflow event subscription needs. */
export type EventStreamContext = {
  readonly baseUrl: string;
  readonly headers: Record<string, string>;
  /** Fetches a workflow's persisted event history for connect/reconnect catch-up. */
  getEvents(workflowId: string): Promise<WorkflowEvent[]>;
  readonly streamOptions: WorkflowEventStreamOptions;
};

/**
 * Open a live {@link WorkflowEventSubscription} for a workflow over the `/watch`
 * WebSocket channel, wiring the watch URL and the `getEvents` catch-up fetch
 * from the given client context. Shared by `HttpHandle` (push-based
 * `addEventListener`) and `HttpClient.tail`.
 */
export function createWorkflowEventSubscription(
  context: EventStreamContext,
  workflowId: string,
  onEvent: (event: WorkflowEvent) => void,
): WorkflowEventSubscription {
  return new WorkflowEventSubscription(
    workflowWatchWebSocketUrl(context.baseUrl, workflowId),
    context.headers,
    workflowId,
    (id) => context.getEvents(id),
    onEvent,
    context.streamOptions,
  );
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
const defaultWebSocketFactory: WebSocketFactory = (url, headers) => {
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
function eventsEqual(a: WorkflowEvent, b: WorkflowEvent): boolean {
  return a.type === b.type && JSON.stringify(a.data) === JSON.stringify(b.data);
}

/** Parse a watch-channel frame into a {@link WorkflowEvent}, or null if malformed. */
function parseWatchFrame(raw: unknown): WorkflowEvent | null {
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

/**
 * A live workflow-event subscription over the `/watch` WebSocket channel.
 * Delivers events to a push callback and to a single async iterator, catching
 * up from persisted history on every (re)connect and transparently reconnecting
 * when the socket drops.
 *
 * The iterator is single-consumer: it drains one shared buffer and parks one
 * waker, so a second concurrent `for await` over the same subscription would
 * steal events and clobber the waker. Open a fresh subscription per consumer
 * instead of iterating one twice.
 */
export class WorkflowEventSubscription implements AsyncIterable<WorkflowEvent> {
  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #workflowId: string;
  readonly #fetchHistory: EventHistoryFetcher;
  readonly #factory: WebSocketFactory;
  readonly #maxReconnectAttempts: number;
  readonly #reconnectBackoffMs: number;
  readonly #onEvent: (event: WorkflowEvent) => void;

  #socket: StreamSocket | null = null;
  #closed = false;
  // Count of events already delivered. The watch channel emits events in the
  // same order `getEvents` persists them, so a monotonic delivered-count is a
  // sufficient cursor for "how far into the history has this subscription got".
  #deliveredCount = 0;
  #reconnectAttempts = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // While catch-up is fetching/emitting history, live frames are buffered here
  // rather than delivered directly. A live frame that also appears in the
  // fetched history would otherwise be delivered twice; buffering lets the
  // post-catch-up drain drop the overlap.
  #catchUpInFlight = false;
  #pendingLive: WorkflowEvent[] = [];
  // Monotonic id incremented on every (re)connect. A catch-up tagged with a
  // stale generation belongs to a socket that has since dropped; when it
  // finishes it must hand off to a fresh catch-up for the current socket rather
  // than declaring the stream caught up. Without this, a drop mid-fetch (the
  // 50ms default backoff is shorter than a typical history round-trip) would
  // leave the in-flight guard set, the reconnect's catch-up a no-op, and the
  // events between the stale snapshot and the new socket permanently missed.
  #connectGeneration = 0;
  // Async-iterator plumbing: buffered events plus a parked waker.
  readonly #buffer: WorkflowEvent[] = [];
  #waker: (() => void) | null = null;
  #closeReason: StreamCloseReason | null = null;
  // Resolves once the socket has opened and its first catch-up has completed,
  // so callers can wait for the stream to be live before advancing a workflow
  // (the watch channel does not replay events emitted before it connected).
  readonly #connected: ReturnType<typeof Promise.withResolvers<void>> = Promise.withResolvers();
  #connectedSettled = false;

  constructor(
    url: string,
    headers: Record<string, string>,
    workflowId: string,
    fetchHistory: EventHistoryFetcher,
    onEvent: (event: WorkflowEvent) => void,
    options?: WorkflowEventStreamOptions,
  ) {
    this.#url = url;
    this.#headers = headers;
    this.#workflowId = workflowId;
    this.#fetchHistory = fetchHistory;
    this.#onEvent = onEvent;
    this.#factory = options?.webSocketFactory ?? defaultWebSocketFactory;
    this.#maxReconnectAttempts = options?.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.#reconnectBackoffMs = options?.reconnectBackoffMs ?? DEFAULT_RECONNECT_BACKOFF_MS;
    this.#connect();
  }

  /** Why the stream terminated, or `null` while it is still open. */
  get closeReason(): StreamCloseReason | null {
    return this.#closeReason;
  }

  /**
   * Resolves once the stream is live (socket open and first catch-up done), or
   * when it terminates — whichever comes first. Await this before driving a
   * workflow whose events you intend to observe, so no event is missed in the
   * window before the watch socket connects.
   */
  whenConnected(): Promise<void> {
    return this.#connected.promise;
  }

  #markConnected(): void {
    if (this.#connectedSettled) return;
    this.#connectedSettled = true;
    this.#connected.resolve();
  }

  #connect(): void {
    if (this.#closed) return;
    let socket: StreamSocket;
    try {
      socket = this.#factory(this.#url, this.#headers);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;

    socket.addEventListener('open', () => {
      if (this.#closed || this.#socket !== socket) return;
      this.#reconnectAttempts = 0;
      // Tag this connection so a catch-up still in flight from a dropped socket
      // knows it is stale and must hand off to a fresh catch-up for this socket.
      this.#connectGeneration += 1;
      // Catch up on any events emitted before this socket connected (or missed
      // while it was disconnected) before relying on live frames.
      void this.#catchUp();
    });

    socket.addEventListener('message', (event) => {
      if (this.#socket !== socket) return;
      const parsed = parseWatchFrame(event.data);
      if (parsed !== null) this.#deliverLive(parsed);
    });

    socket.addEventListener('close', () => {
      if (this.#socket === socket) this.#handleSocketDrop();
    });

    socket.addEventListener('error', () => {
      // `error` is always followed by `close`; reconnect is handled there.
    });
  }

  async #catchUp(): Promise<void> {
    if (this.#catchUpInFlight || this.#closed) return;
    this.#catchUpInFlight = true;
    this.#pendingLive = [];
    // Pin the connection this catch-up is reconciling against. If the socket
    // drops and reconnects while we await history, this generation goes stale
    // and we must re-run for the new socket instead of declaring the stream
    // caught up against an already-dead connection's snapshot.
    const generation = this.#connectGeneration;
    try {
      await this.#reconcileHistory();
    } finally {
      this.#catchUpInFlight = false;
      if (!this.#closed && generation !== this.#connectGeneration) {
        // A reconnect happened mid-flight; this catch-up reconciled against the
        // dropped socket. Re-run for the current socket so events between the
        // stale snapshot and the new connection are not lost.
        void this.#catchUp();
      } else {
        // The stream is now live: history drained, live frames flowing.
        this.#markConnected();
      }
    }
  }

  /**
   * Fetch persisted history, emit the events past `#deliveredCount`, then drain
   * the live frames buffered during the fetch (dropping the ones the replayed
   * history already covered). Bails out early if the stream closes mid-way.
   */
  async #reconcileHistory(): Promise<void> {
    let history: WorkflowEvent[] = [];
    try {
      history = await this.#fetchHistory(this.#workflowId);
    } catch {
      // A failed catch-up must not kill the stream; fall through so any live
      // frames buffered during the fetch still drain, and the next reconnect
      // retries the catch-up.
      history = [];
    }
    if (this.#closed) return;

    // Emit history beyond what was already delivered. History and live frames
    // share one ordered sequence, so `#deliveredCount` is the cursor.
    const newHistory = history.slice(this.#deliveredCount);
    for (const event of newHistory) {
      this.#emit(event);
      if (this.#closed) return;
    }

    // Drain live frames that arrived during the fetch, dropping any that the
    // history we just emitted already covered (the overlap window).
    const buffered = this.#pendingLive;
    this.#pendingLive = [];
    for (const live of buffered) {
      if (this.#closed) return;
      if (newHistory.some((historic) => eventsEqual(historic, live))) continue;
      this.#emit(live);
    }
  }

  #deliverLive(event: WorkflowEvent): void {
    // Buffer live frames while catch-up drains history so the overlap window is
    // deduped; otherwise deliver immediately.
    if (this.#catchUpInFlight) {
      this.#pendingLive.push(event);
      return;
    }
    this.#emit(event);
  }

  #emit(event: WorkflowEvent): void {
    this.#deliveredCount += 1;
    try {
      this.#onEvent(event);
    } catch {
      // A listener throwing must not corrupt the stream.
    }
    this.#buffer.push(event);
    this.#wake();
    if (TERMINAL_EVENT_TYPES.has(event.type)) {
      this.#terminate('workflow-terminal');
    }
  }

  #handleSocketDrop(): void {
    this.#socket = null;
    if (this.#closed) return;
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#closed) return;
    if (this.#reconnectAttempts >= this.#maxReconnectAttempts) {
      this.#terminate('reconnect-exhausted');
      return;
    }
    this.#reconnectAttempts += 1;
    const delay = this.#reconnectBackoffMs * this.#reconnectAttempts;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
  }

  #terminate(reason: StreamCloseReason): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = reason;
    // Unblock anyone awaiting connection — the stream will deliver nothing more.
    this.#markConnected();
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) {
      try {
        socket.close();
      } catch {
        // Closing an already-dead socket is a no-op for our purposes.
      }
    }
    this.#wake();
  }

  #wake(): void {
    const waker = this.#waker;
    if (waker !== null) {
      this.#waker = null;
      waker();
    }
  }

  /**
   * Close the subscription cleanly: close the socket and resolve any active
   * async iteration. Idempotent.
   */
  close(): void {
    this.#terminate('client-closed');
  }

  async *[Symbol.asyncIterator](): AsyncIterator<WorkflowEvent> {
    try {
      while (true) {
        while (this.#buffer.length > 0) {
          yield this.#buffer.shift()!;
        }
        if (this.#closed) return;
        await this.#waitForEvent();
      }
    } finally {
      // A consumer that breaks out of `for await` closes the subscription so
      // the socket does not leak.
      this.close();
    }
  }

  #waitForEvent(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#waker = resolve;
    return promise;
  }
}
