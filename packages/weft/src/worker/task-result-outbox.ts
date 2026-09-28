// ---------------------------------------------------------------------------
// Unacknowledged task-result buffer for resend across a reconnect
// ---------------------------------------------------------------------------

import type { TaskResultMessage } from './protocol.ts';

/** The minimum shape any buffered outbox entry must carry — the composite key. */
export interface OutboxKeyed {
  readonly operationId: string;
  readonly attemptToken: string;
}

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
 *
 * Generic over the buffered entry shape (COR-235) so `LongPollWorker` can
 * reuse this exact abstraction for its own HTTP result POST body — which
 * needs a `workerId` field `TaskResultMessage` does not carry, since a
 * long-poll worker has no persistent connection to derive identity from —
 * rather than a second, parallel buffer implementation. `RemoteWorker`'s own
 * usage is unaffected: the default type parameter is exactly the type it
 * always used.
 */
export class TaskResultOutbox<TEntry extends OutboxKeyed = TaskResultMessage> {
  readonly #entries = new Map<string, TEntry>();
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
  buffer(message: TEntry): void {
    this.#entries.set(outboxKey(message.operationId, message.attemptToken), message);
  }

  /** Whether an unacknowledged entry is still buffered for `(operationId, attemptToken)`. */
  has(operationId: string, attemptToken: string): boolean {
    return this.#entries.has(outboxKey(operationId, attemptToken));
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

  /**
   * Permanently drop a buffered result because a correlated `protocolError`
   * (protocol v7) told us the server will never apply it, no matter how many
   * times it is resent — unknown operation, stale or foreign attempt, a
   * workflow-revision mismatch, or conflicting content resubmitted under one
   * attempt token. Resending an unappliable result forever is strictly worse
   * than dropping it: it can never become appliable by retrying, and it
   * eventually trips {@link MAX_BUFFERED_TASK_RESULTS}. Returns whether an
   * entry was actually present to drop, so callers can tell a genuine
   * correlation from a rejection that named an operation/attempt this outbox
   * never buffered.
   */
  reject(operationId: string, attemptToken: string): boolean {
    const key = outboxKey(operationId, attemptToken);
    const existed = this.#entries.delete(key);
    // Re-arm the one-time full warning once the backlog drains below the cap,
    // matching `acknowledge()`'s identical reasoning.
    if (!this.full) this.#warnedFull = false;
    return existed;
  }

  /** Snapshot of buffered results in insertion (flush) order. */
  drainOrder(): TEntry[] {
    return [...this.#entries.values()];
  }

  /** Discard all buffered results (terminal disposal). */
  clear(): void {
    this.#entries.clear();
    this.#warnedFull = false;
  }
}
