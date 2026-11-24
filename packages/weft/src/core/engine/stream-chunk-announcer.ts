// ---------------------------------------------------------------------------
// Coalesced `stream:chunk` announcements per workflow stream key
// ---------------------------------------------------------------------------

import { StreamChunkEvent } from '../events/fleet-state-events.ts';
import { tagWorkflowEventGeneration } from '../events/workflow-event-generation.ts';

/**
 * The shortest interval, in milliseconds, between two `stream:chunk` events for
 * the same workflow stream key. Chunks stored inside it collapse into the first
 * chunk's event and one trailing event that names the latest stored sequence.
 */
export const STREAM_CHUNK_EVENT_INTERVAL_MILLISECONDS = 250;

type StreamChunkWindow = {
  /** The execution token of the run writing this key; a different run's chunk resets the window. */
  workflowExecutionToken: string | undefined;
  /** The sequence most recently announced for the key. */
  announcedSequence: number;
  /** The latest sequence stored, which the trailing event names when it is above `announcedSequence`. */
  storedSequence: number;
  /** Ends the current window. */
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Turns "a chunk of this stream key was stored" notices into `stream:chunk`
 * events: at most one immediate and one trailing event per `(workflowId, key)`
 * per {@link STREAM_CHUNK_EVENT_INTERVAL_MILLISECONDS}, so a long stream does
 * not cost one watch-storage write and one fleet-feed append per chunk.
 *
 * A key's first chunk after a quiet period is announced at once and opens a
 * window. Chunks inside the window only record their sequence: when it closes,
 * the announcer announces the latest stored sequence if it is newer than the
 * one announced, which opens the next window, and otherwise forgets the key.
 * {@link settle} announces a pending sequence at once when a stream finishes,
 * so the last chunk of every stream is announced before the stream operation
 * returns, and {@link discard} drops it unannounced when a failed stream's
 * partial chunks are removed.
 *
 * A chunk from a run that a `start-new` replacement superseded is ignored
 * before it touches any window, so a producer that outlives its run cannot
 * displace the replacement's pending announcement. Every event is also tagged
 * with the execution token of the run that stored the chunk it names, so
 * `Engine.dispatchEvent` drops one whose run was superseded while it waited.
 */
export class StreamChunkAnnouncer implements Disposable {
  readonly #dispatchEvent: (event: Event) => void;
  readonly #isSuperseded: (
    workflowId: string,
    workflowExecutionToken: string | undefined,
  ) => boolean;
  readonly #intervalMilliseconds: number;
  readonly #windows = new Map<string, Map<string, StreamChunkWindow>>();

  constructor(
    dispatchEvent: (event: Event) => void,
    isSuperseded: (workflowId: string, workflowExecutionToken: string | undefined) => boolean,
    intervalMilliseconds: number = STREAM_CHUNK_EVENT_INTERVAL_MILLISECONDS,
  ) {
    this.#dispatchEvent = dispatchEvent;
    this.#isSuperseded = isSuperseded;
    this.#intervalMilliseconds = intervalMilliseconds;
  }

  /** Report that the chunk at `sequence` of `workflowId`'s stream `key` is durably stored. */
  stored(
    workflowId: string,
    key: string,
    sequence: number,
    workflowExecutionToken: string | undefined,
  ): void {
    if (this.#isSuperseded(workflowId, workflowExecutionToken)) return;
    const window = this.#windows.get(workflowId)?.get(key);
    if (window !== undefined && window.workflowExecutionToken === workflowExecutionToken) {
      window.storedSequence = sequence;
      return;
    }
    // A chunk from the current run of a reused id restarts the key: the superseded run's window
    // named its own sequences, which mean nothing to the new run.
    if (window !== undefined) this.#forget(workflowId, key, window);
    this.#announce(workflowId, key, sequence, workflowExecutionToken);
  }

  /** The stream `key` finished: announce its pending sequence now and close its window. */
  settle(workflowId: string, key: string, workflowExecutionToken: string | undefined): void {
    const window = this.#windows.get(workflowId)?.get(key);
    if (window === undefined || window.workflowExecutionToken !== workflowExecutionToken) return;
    this.#forget(workflowId, key, window);
    this.#dispatchPending(workflowId, key, window);
  }

  /** The stream `key` failed and its chunks are being removed: close its window without announcing. */
  discard(workflowId: string, key: string, workflowExecutionToken: string | undefined): void {
    const window = this.#windows.get(workflowId)?.get(key);
    if (window === undefined || window.workflowExecutionToken !== workflowExecutionToken) return;
    this.#forget(workflowId, key, window);
  }

  /** The workflow reached a terminal state: announce every pending sequence now and close its windows. */
  flushWorkflow(workflowId: string): void {
    const windows = this.#windows.get(workflowId);
    if (windows === undefined) return;
    this.#windows.delete(workflowId);
    for (const [key, window] of windows) {
      clearTimeout(window.timer);
      this.#dispatchPending(workflowId, key, window);
    }
  }

  /** The number of keys with an open window, for tests that assert nothing is left armed. */
  get openWindowCount(): number {
    let count = 0;
    for (const windows of this.#windows.values()) count += windows.size;
    return count;
  }

  /** Cancel every open window without a trailing event. This is teardown. Idempotent. */
  [Symbol.dispose](): void {
    for (const windows of this.#windows.values()) {
      for (const window of windows.values()) clearTimeout(window.timer);
    }
    this.#windows.clear();
  }

  #announce(
    workflowId: string,
    key: string,
    sequence: number,
    workflowExecutionToken: string | undefined,
  ): void {
    const window: StreamChunkWindow = {
      workflowExecutionToken,
      announcedSequence: sequence,
      storedSequence: sequence,
      timer: setTimeout(() => {
        this.#forget(workflowId, key, window);
        if (window.storedSequence > window.announcedSequence) {
          this.#announce(workflowId, key, window.storedSequence, workflowExecutionToken);
        }
      }, this.#intervalMilliseconds),
    };
    let windows = this.#windows.get(workflowId);
    if (windows === undefined) {
      windows = new Map();
      this.#windows.set(workflowId, windows);
    }
    windows.set(key, window);
    this.#dispatch(workflowId, key, sequence, workflowExecutionToken);
  }

  #dispatchPending(workflowId: string, key: string, window: StreamChunkWindow): void {
    if (window.storedSequence > window.announcedSequence) {
      this.#dispatch(workflowId, key, window.storedSequence, window.workflowExecutionToken);
    }
  }

  #dispatch(
    workflowId: string,
    key: string,
    sequence: number,
    workflowExecutionToken: string | undefined,
  ): void {
    this.#dispatchEvent(
      tagWorkflowEventGeneration(
        new StreamChunkEvent(workflowId, key, sequence),
        workflowExecutionToken,
      ),
    );
  }

  /** Clear `window`'s timer and remove it, if it is still the key's current window. */
  #forget(workflowId: string, key: string, window: StreamChunkWindow): void {
    clearTimeout(window.timer);
    const windows = this.#windows.get(workflowId);
    if (windows?.get(key) !== window) return;
    windows.delete(key);
    if (windows.size === 0) this.#windows.delete(workflowId);
  }
}
