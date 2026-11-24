// ---------------------------------------------------------------------------
// Coalesced `queue:depth-changed` announcements for the in-memory TaskQueue
// ---------------------------------------------------------------------------

import { QueueDepthChangedEvent } from '../core/events/fleet-state-events.ts';

/**
 * The shortest interval, in milliseconds, between two `queue:depth-changed`
 * events for the same queue. A burst of enqueues and claims inside it collapses
 * into the first change and one trailing event that carries the latest depth.
 */
export const QUEUE_DEPTH_EVENT_INTERVAL_MILLISECONDS = 1000;

type QueueDepthWindow = {
  /** The depth most recently announced for the queue. */
  announcedDepth: number;
  /** Ends the current window; `undefined` once the window has closed. */
  timer: ReturnType<typeof setTimeout> | undefined;
};

/**
 * Turns a stream of "this queue's pending list just changed" notices into
 * `queue:depth-changed` events: at most one per queue per
 * {@link QUEUE_DEPTH_EVENT_INTERVAL_MILLISECONDS}, never one for an unchanged
 * depth, and a trailing event at the end of a busy window so the last depth a
 * burst settles on is always announced.
 *
 * A queue's first change after a quiet period is announced at once and opens a
 * window. Changes inside the window arm nothing new: when it closes, the
 * announcer reads the depth again and announces it if it differs from the one
 * last announced, which opens the next window. A window that closes on an empty
 * queue drops the queue's record, so the announcer holds state only for queues
 * that are non-empty or changed in the last interval. It reads no clock; the
 * window is a single timer.
 *
 * Depth is the owning process's own pending count and does not aggregate across
 * processes.
 */
export class TaskQueueDepthAnnouncer implements Disposable {
  readonly #readDepth: (queue: string) => number;
  readonly #dispatchEvent: (event: Event) => void;
  readonly #windows = new Map<string, QueueDepthWindow>();
  #disposed = false;

  constructor(readDepth: (queue: string) => number, dispatchEvent: (event: Event) => void) {
    this.#readDepth = readDepth;
    this.#dispatchEvent = dispatchEvent;
  }

  /** Report that `queue`'s pending list may have changed. Call after the mutation is complete. */
  changed(queue: string): void {
    if (this.#disposed) return;
    const window = this.#windows.get(queue) ?? { announcedDepth: 0, timer: undefined };
    if (window.timer !== undefined) return;
    this.#announce(queue, window);
  }

  /** Cancel every open window and ignore later changes. No trailing event is sent; this is teardown. Idempotent. */
  [Symbol.dispose](): void {
    this.#disposed = true;
    for (const window of this.#windows.values()) {
      if (window.timer !== undefined) clearTimeout(window.timer);
    }
    this.#windows.clear();
  }

  /** Announce the queue's depth when it differs from the last one announced, and open a window if so. */
  #announce(queue: string, window: QueueDepthWindow): void {
    const depth = this.#readDepth(queue);
    if (depth === window.announcedDepth) {
      // A closing window on an empty queue is back to the implicit starting state.
      if (depth === 0) this.#windows.delete(queue);
      return;
    }
    window.announcedDepth = depth;
    window.timer = setTimeout(() => {
      window.timer = undefined;
      this.#announce(queue, window);
    }, QUEUE_DEPTH_EVENT_INTERVAL_MILLISECONDS);
    this.#windows.set(queue, window);
    this.#dispatchEvent(new QueueDepthChangedEvent(queue, depth));
  }
}
