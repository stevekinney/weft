// ---------------------------------------------------------------------------
// Unacknowledged task-result buffer for resend across a reconnect
// ---------------------------------------------------------------------------

import type { TaskResultMessage } from './protocol.ts';

/**
 * Hard ceiling on unacknowledged `taskResult` frames buffered for resend
 * across a reconnect. Reaching it triggers intake backpressure on the worker
 * so the buffer cannot grow without bound; completed results are never
 * dropped.
 */
export const MAX_BUFFERED_TASK_RESULTS = 1_000;

/**
 * Whether the outbox is at or above its ceiling. Extracted as a pure helper so
 * the backpressure threshold is unit-testable without fabricating a full buffer.
 */
export function isOutboxFull(size: number, max: number): boolean {
  return size >= max;
}

/** Composite outbox key for a `(operationId, attemptToken)` pair. */
function outboxKey(operationId: string, attemptToken: string): string {
  return `${operationId}\u0000${attemptToken}`;
}

/**
 * Buffers terminal task results that have not yet been acknowledged by the
 * server, so the worker can re-send them after a reconnect rather than
 * silently dropping them (a dropped result would be redelivered by the
 * server and re-execute the activity). Keyed by `(operationId, attemptToken)`
 * (COR-240) rather than `operationId` alone, so a result produced under one
 * attempt can never be conflated with, or silently overwritten by, a result
 * for a different attempt of the same operation.
 *
 * A result stays buffered once `WebSocket.send()` returns — a successful send
 * only proves the frame left this process, not that it reached the server or
 * that the server's response reached back. Only a matching `taskResultAck`
 * (see `acknowledge()`) removes an entry; nothing else does, including
 * disconnects and reconnects.
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

  /** Current number of buffered, unacknowledged results. */
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

  /**
   * Buffer (or replace by `(operationId, attemptToken)`) a result for later
   * resend. Idempotent to call again for the same attempt — for example
   * immediately before every send attempt, successful or not, so the entry
   * is durable in this outbox regardless of what the send does next.
   */
  buffer(message: TaskResultMessage): void {
    this.#entries.set(outboxKey(message.operationId, message.attemptToken), message);
  }

  /**
   * Drop a buffered result once the matching `taskResultAck` confirms the
   * server durably applied it. Sending the result is not enough — only this
   * removes the entry. An ack for an `(operationId, attemptToken)` this
   * outbox has no entry for (already acknowledged, or never buffered here) is
   * a harmless no-op.
   */
  acknowledge(operationId: string, attemptToken: string): void {
    this.#entries.delete(outboxKey(operationId, attemptToken));
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
