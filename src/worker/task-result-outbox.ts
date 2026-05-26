// ---------------------------------------------------------------------------
// Unsent task-result buffer for resend across a reconnect
// ---------------------------------------------------------------------------

import type { TaskResultMessage } from './protocol.ts';

/**
 * Hard ceiling on unsent `taskResult` frames buffered for resend across a
 * reconnect. Reaching it triggers intake backpressure on the worker so the
 * buffer cannot grow without bound; completed results are never dropped.
 */
export const MAX_BUFFERED_TASK_RESULTS = 1_000;

/**
 * Whether the outbox is at or above its ceiling. Extracted as a pure helper so
 * the backpressure threshold is unit-testable without fabricating a full buffer.
 */
export function isOutboxFull(size: number, max: number): boolean {
  return size >= max;
}

/**
 * Buffers terminal task results that could not be sent immediately so the
 * worker can re-send them after a reconnect rather than silently dropping them
 * (a dropped result would be redelivered by the server and re-execute the
 * activity). Keyed by `operationId`: a `Map` gives dedup-by-operation and
 * deterministic insertion-order flush in one structure.
 */
export class TaskResultOutbox {
  readonly #entries = new Map<string, TaskResultMessage>();
  readonly #max: number;
  #warnedFull = false;

  constructor(max: number = MAX_BUFFERED_TASK_RESULTS) {
    if (!Number.isInteger(max) || max < 0) {
      throw new RangeError(
        `maxBufferedResults must be a non-negative integer, received ${String(max)}`,
      );
    }
    this.#max = max;
  }

  /** Current number of buffered results. */
  get size(): number {
    return this.#entries.size;
  }

  /** Whether the buffer is at or above its ceiling. */
  get full(): boolean {
    return isOutboxFull(this.#entries.size, this.#max);
  }

  /**
   * Warn at most once that the buffer is full. Returns `true` the first time it
   * is called after the cap is reached, so the caller can emit a single log.
   */
  shouldWarnFull(): boolean {
    if (this.#warnedFull) return false;
    this.#warnedFull = true;
    return true;
  }

  /** Buffer (or replace by `operationId`) a result for later resend. */
  buffer(message: TaskResultMessage): void {
    this.#entries.set(message.operationId, message);
  }

  /** Drop a buffered result once it has been confirmed sent. */
  delete(operationId: string): void {
    this.#entries.delete(operationId);
    // Re-arm the one-time full warning once the backlog drains below the cap,
    // so a later full episode (e.g. a second disconnect cycle) warns again.
    if (!this.full) this.#warnedFull = false;
  }

  /** Snapshot of buffered results in insertion (flush) order. */
  drainOrder(): TaskResultMessage[] {
    return [...this.#entries.values()];
  }

  /** Discard all buffered results (terminal disposal). */
  clear(): void {
    this.#entries.clear();
    this.#warnedFull = false;
  }
}
