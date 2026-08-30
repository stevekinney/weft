import type { WorkflowEvent } from '../core/types.ts';

/** Reason a workflow event tail terminated. */
export type StreamCloseReason =
  | 'workflow-terminal'
  | 'client-closed'
  | 'reconnect-exhausted'
  | 'server-error';

export type WorkflowEventTailLifecycleOptions = {
  readonly bufferForIteration?: boolean;
  readonly onClose: (reason: StreamCloseReason) => void;
};

/**
 * Shared async-iterator lifecycle for client event tails. Transports own
 * connection mechanics; this owns buffering, close state, and wake-up handling.
 */
export class WorkflowEventTailLifecycle implements AsyncIterable<WorkflowEvent> {
  readonly #buffer: WorkflowEvent[] = [];
  readonly #onClose: (reason: StreamCloseReason) => void;

  #closeReason: StreamCloseReason | null = null;
  #closed = false;
  #iterating = false;
  #waker: (() => void) | null = null;

  constructor(options: WorkflowEventTailLifecycleOptions) {
    this.#onClose = options.onClose;
    // Iteration-intended consumers (`tail()`) buffer from construction so the
    // connect catch-up emitted before the `for await` loop starts is not dropped.
    // Callback-only subscribers keep the lazy default.
    this.#iterating = options.bufferForIteration ?? false;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get closeReason(): StreamCloseReason | null {
    return this.#closeReason;
  }

  emit(event: WorkflowEvent, onEvent: (event: WorkflowEvent) => void): boolean {
    if (this.#closed) return false;
    try {
      onEvent(event);
    } catch {
      // Listener failures must not corrupt stream state.
    }
    if (this.#iterating) {
      this.#buffer.push(event);
      this.#wake();
    }
    return true;
  }

  terminate(reason: StreamCloseReason): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = reason;
    this.#onClose(reason);
    this.#wake();
  }

  close(): void {
    this.terminate('client-closed');
  }

  [Symbol.asyncIterator](): AsyncIterator<WorkflowEvent> {
    // Flip the flag synchronously when the iterator is obtained, not lazily on
    // first `next()`, so catch-up events emitted between those moments are queued.
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
      this.close();
    }
  }

  #waitForEvent(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#waker = resolve;
    return promise;
  }

  #wake(): void {
    const waker = this.#waker;
    if (waker !== null) {
      this.#waker = null;
      waker();
    }
  }
}
