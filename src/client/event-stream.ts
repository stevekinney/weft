/**
 * Live workflow-event streaming for {@link HttpClient}.
 *
 * The server broadcasts a workflow's lifecycle events over a per-workflow
 * WebSocket channel at `/v1/workflows/:id/watch` (see the server's
 * `wireEventBroadcasting`). Each frame is a JSON {@link WorkflowEvent}
 * (`{ type, timestamp, data }`) — the same shape `getEvents()` returns. This
 * module opens that channel and exposes the events through two surfaces: a push
 * callback (`onEvent`) used by {@link HttpHandle.addEventListener} so listeners
 * fire the moment an event lands instead of on a 2-second poll, and an
 * {@link AsyncIterable} used by `client.tail(id)` / `handle.tail()`.
 *
 * **Catch-up + reconnect.** The watch channel is live-only and a dropped socket
 * can miss events while disconnected. To close both gaps the subscription
 * fetches the persisted event history (`getEvents`) on every (re)connect, emits
 * the events past a confirmed-contiguous history watermark, then drops any live
 * frame buffered during the fetch that the replayed history already covered (the
 * overlap window). Delivery is at-least-once: a failed fetch or a shorter
 * compaction-rebased history array may re-deliver a frame once rather than lose
 * it. The lone exception is a sequence-less-cursor edge under event-log
 * compaction — a compacted+regrown log of unchanged length — documented on
 * `#historyWatermark`; closing it needs a server-exposed event sequence.
 * Reconnect attempts back off and are capped; the cap is honored even for
 * open-then-close sockets, since the counter resets only after a catch-up proves
 * the connection healthy (`#catchUp`).
 *
 * **Clean close.** `close()` closes the socket and resolves the iterable.
 * Terminal workflow events (`completed`, `failed`, `cancelled`, `timed-out`)
 * auto-close the stream so `for await` consumers terminate when the workflow
 * finishes.
 *
 * @module client/event-stream
 */

import { WORKFLOW_TERMINAL_EVENT_TYPES } from '../core/events/workflow-events.ts';
import type { WorkflowEvent } from '../core/types.ts';
import {
  defaultWebSocketFactory,
  dropOverlappingLiveFrames,
  parseWatchFrame,
  type StreamSocket,
  type WebSocketFactory,
} from './event-stream-transport.ts';

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
  /**
   * Buffer events for async iteration from construction rather than lazily on
   * first iterator pull. `tail()` sets this so the documented
   * `await tail.whenConnected(); for await (…)` pattern still sees the connect
   * catch-up history (which is emitted before the `for await` loop begins).
   * Callback-only subscribers (`HttpHandle.addEventListener`) leave it off so
   * the iterator buffer never accumulates a never-drained queue. Default false.
   */
  readonly bufferForIteration?: boolean;
};

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_RECONNECT_BACKOFF_MS = 50;

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
  // The history cursor: the length of the `getEvents` array the last *successful*
  // catch-up reconciled. The next catch-up replays `history.slice(watermark)` so
  // it does not re-emit what that array already covered. This is deliberately the
  // reconciled *array length*, NOT the count of events delivered to the consumer:
  //   - A failed catch-up leaves it untouched, so the next successful fetch
  //     replays from before the gap and recovers any event the failure missed.
  //   - Live frames delivered between catch-ups do not advance it, so a frame
  //     re-appearing in the next history is re-delivered (at-least-once) rather
  //     than skipped.
  //   - It never exceeds the surviving history length, so event-log compaction
  //     re-basing the array *shorter* cannot inflate it and make a later `slice`
  //     skip newly persisted events.
  // The watch channel delivers events in `getEvents` order, so an array length is
  // a sound contiguous cursor in the common (no-compaction) case, and delivery is
  // at-least-once there.
  //
  // The one residual gap is fundamental to a sequence-less cursor: if compaction
  // trims exactly as many leading records as the suffix grows by between two
  // catch-ups, the array length is unchanged and `slice(watermark)` skips the new
  // tail. `WorkflowEvent` carries no stable sequence id to disambiguate that, so
  // closing it requires a server-exposed event sequence — a wider change tracked
  // separately. Live frames arriving on the open socket are unaffected; only the
  // reconnect catch-up against an exactly-offset compacted+regrown log is at risk.
  #historyWatermark = 0;
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
  // Async-iterator plumbing: buffered events plus a parked waker. The buffer is
  // filled while `#iterating` is set — either because an iterator is actively
  // consuming or because the subscription was opened for iteration
  // (`bufferForIteration`, used by `tail()`). A callback-only subscriber leaves
  // it off so it never accumulates a never-drained queue.
  readonly #buffer: WorkflowEvent[] = [];
  #waker: (() => void) | null = null;
  #iterating = false;
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
    // Iteration-intended consumers (`tail()`) buffer from construction so the
    // connect catch-up — emitted before the `for await` loop starts — is not
    // dropped. Callback-only subscribers keep the lazy default.
    this.#iterating = options?.bufferForIteration ?? false;
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
    } catch (error) {
      // The first connect runs synchronously in the constructor, before any
      // socket has opened. A failure here (e.g. no global WebSocket, so the
      // default factory throws) is an environment/configuration problem, not a
      // transient drop — surface it to the caller instead of spinning reconnects
      // to exhaustion. Once a socket has successfully opened at least once
      // (`#connectGeneration > 0`), later factory failures are treated as
      // transient and retried.
      if (this.#connectGeneration === 0 && this.#reconnectAttempts === 0) {
        throw error;
      }
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;

    socket.addEventListener('open', () => {
      if (this.#closed || this.#socket !== socket) return;
      // The reconnect counter is intentionally NOT reset here. A socket `open`
      // only proves the upgrade was accepted, not that the connection is
      // healthy: a server or proxy that accepts then immediately closes would,
      // if we reset on `open`, reconnect forever at the first backoff interval
      // and defeat `maxReconnectAttempts`. The counter is reset only after a
      // catch-up succeeds (see `#catchUp`), which proves the socket stayed open
      // long enough to fetch and reconcile history.
      //
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
    // Do NOT reset `#pendingLive` here. `#deliverLive` only buffers while a
    // catch-up is in flight and a successful reconcile drains it to empty, so it
    // already holds exactly the current overlap window. Clearing it would discard
    // frames the *current* socket delivered while a now-stale catch-up's fetch
    // was running — those must survive into the re-run below (the next history
    // fetch may not have persisted them yet), or the "never lose" contract breaks.
    //
    // Pin the connection this catch-up is reconciling against. If the socket
    // drops and reconnects while we await history, this generation goes stale
    // and we must re-run for the new socket instead of declaring the stream
    // caught up against an already-dead connection's snapshot.
    const generation = this.#connectGeneration;
    let succeeded = false;
    try {
      succeeded = await this.#reconcileHistory(generation);
    } finally {
      this.#catchUpInFlight = false;
      if (!this.#closed && generation !== this.#connectGeneration) {
        // A reconnect happened mid-flight; this catch-up reconciled against the
        // dropped socket. Re-run for the current socket so events between the
        // stale snapshot and the new connection are not lost.
        void this.#catchUp();
      } else {
        if (succeeded && this.#socket !== null) {
          // The connection is proven healthy: the socket is still open AND it
          // stayed open long enough to fetch history and reconcile. Only now is
          // it safe to reset the reconnect counter. Resetting merely on socket
          // `open`, or even on a catch-up that completed after the socket had
          // already dropped (`#socket === null`), would let a server/proxy that
          // accepts the upgrade then immediately closes reconnect forever,
          // defeating `maxReconnectAttempts`.
          this.#reconnectAttempts = 0;
        }
        // The stream is now live: history drained (or its fetch failed and the
        // next reconnect will retry), live frames flowing.
        this.#markConnected();
      }
    }
  }

  /**
   * Fetch persisted history, emit the events past the history watermark, then
   * drain the live frames buffered during the fetch (dropping the ones the
   * replayed history already covered). Returns `true` only when the fetch
   * succeeded and this pass committed against the current connection; returns
   * `false` if the fetch failed, the stream closed mid-way, or a reconnect made
   * this catch-up's generation stale during the fetch.
   */
  async #reconcileHistory(generation: number): Promise<boolean> {
    let history: WorkflowEvent[] = [];
    let fetchSucceeded = true;
    try {
      history = await this.#fetchHistory(this.#workflowId);
    } catch {
      // A failed catch-up must not kill the stream; fall through so any live
      // frames buffered during the fetch still drain, and the next reconnect
      // retries. The watermark is left untouched (we return early before
      // advancing it), so the next successful fetch replays from before any gap
      // the failure missed and recovers it.
      fetchSucceeded = false;
      history = [];
    }
    if (this.#closed) return false;

    // A reconnect happened while we awaited history. This snapshot was taken
    // against the dropped socket, and `#pendingLive` now holds frames from the
    // new socket. Abandon this pass without emitting history or draining the
    // buffer — neither the watermark nor `#pendingLive` is touched, so the re-run
    // (scheduled by #catchUp's finally, which keeps the buffered frames) delivers
    // the new socket's frames even if the next history fetch has not persisted
    // them yet. Emitting here would advance the watermark against a dead socket's
    // snapshot and skip gap events.
    if (generation !== this.#connectGeneration) return false;

    // Replay history past the cursor. `getEvents` returns only the records that
    // survive event-log compaction, so on a long-running workflow the array can
    // be *re-based* shorter than the cursor; in that case replay the whole
    // surviving suffix and lean on the consuming overlap dedup (and at-least-once
    // re-delivery) rather than slicing past the array end and skipping events. On
    // a failed fetch `history` is empty, so nothing is replayed here.
    const compactionRebased = history.length < this.#historyWatermark;
    const newHistory = compactionRebased ? history : history.slice(this.#historyWatermark);
    for (const event of newHistory) {
      this.#emit(event);
    }

    // Drain the live frames buffered during the fetch, dropping the overlap with
    // the history just replayed; the rest are genuinely new and are emitted in
    // order. This runs even on a failed fetch so frames buffered during it are
    // not stranded (with empty history they all pass through as new). `#emit`
    // no-ops once the stream is closed, so a terminal event mid-replay does not
    // strand the remaining genuinely-new frames — they are still attempted in
    // order and harmlessly skipped only after the stream has actually ended.
    const buffered = this.#pendingLive;
    this.#pendingLive = [];
    for (const live of dropOverlappingLiveFrames(newHistory, buffered)) {
      this.#emit(live);
    }

    // Only a successful fetch advances the cursor. A failed fetch leaves it
    // untouched so the next successful fetch replays from before any gap the
    // failure missed and recovers it. The cursor is the reconciled array length —
    // never the delivered count, which can exceed it after compaction-rebased
    // duplicate replays or between-catch-up live frames — so it never overshoots
    // the surviving history and the next slice cannot skip newly persisted events.
    if (fetchSucceeded) this.#historyWatermark = history.length;
    return fetchSucceeded;
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
    // Once the stream has terminated (e.g. a terminal event earlier in this same
    // reconcile pass closed it), emitting is a no-op — the consumer has been told
    // the stream ended, so a late frame must not slip through.
    if (this.#closed) return;
    // The history cursor is advanced once per successful reconcile (to the
    // reconciled array length), not here per-event — emitting must not inflate it
    // with duplicate replays or between-catch-up live frames (see
    // `#historyWatermark`).
    try {
      this.#onEvent(event);
    } catch {
      // A listener throwing must not corrupt the stream.
    }
    // Only queue for the async iterator when one is actually consuming. The
    // push callback (`HttpHandle.addEventListener`) never iterates, so without
    // this guard the buffer would grow unbounded for the subscription's
    // lifetime — a leak proportional to event count on long-running workflows.
    if (this.#iterating) {
      this.#buffer.push(event);
      this.#wake();
    }
    if (WORKFLOW_TERMINAL_EVENT_TYPES.has(event.type)) {
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

  [Symbol.asyncIterator](): AsyncIterator<WorkflowEvent> {
    // Flip the flag synchronously when the iterator is obtained — not lazily on
    // first `next()` — so events emitted by catch-up between obtaining the
    // iterator and the first pull are still queued, regardless of microtask
    // ordering. Until now a callback-only subscriber kept the buffer empty.
    this.#iterating = true;
    return this.#iterate();
  }

  async *#iterate(): AsyncIterator<WorkflowEvent> {
    try {
      while (true) {
        while (this.#buffer.length > 0) {
          yield this.#buffer.shift()!;
        }
        if (this.#closed) return;
        await this.#waitForEvent();
      }
    } finally {
      this.#iterating = false;
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
