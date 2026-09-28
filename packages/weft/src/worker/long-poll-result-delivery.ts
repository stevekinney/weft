// ---------------------------------------------------------------------------
// Durable, retried result delivery for LongPollWorker (COR-235)
// ---------------------------------------------------------------------------

import { TaskResultOutbox, type OutboxKeyed } from './task-result-outbox.ts';

/** Default delay before the first retry of a failed/transiently-rejected send. */
export const DEFAULT_RESULT_RETRY_BASE_DELAY_MS = 1_000;
/** Upper bound the retry delay backs off to — never grows unbounded. */
export const DEFAULT_RESULT_RETRY_MAX_DELAY_MS = 30_000;

/**
 * The long-poll result POST body: `TaskResultMessage`'s shape plus a
 * `workerId`, which a stateless HTTP submission must carry explicitly since
 * there is no persistent connection to derive identity from the way
 * `RemoteWorker`'s WebSocket does.
 */
export interface LongPollTaskResultBody extends OutboxKeyed {
  /**
   * Optional to match `PolledTask.workerId`'s own optionality — a
   * conforming server always includes it, but this stays defensive rather
   * than fabricating a value. `JSON.stringify` omits an `undefined` property
   * entirely, matching this transport's pre-COR-235 behavior exactly.
   */
  readonly workerId?: string;
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly value?: unknown;
  readonly error?: string;
  readonly cancelled?: true;
}

export interface LongPollResultDeliveryOptions {
  /** The `/result` endpoint URL to POST to. */
  resultUrl: string;
  /** HTTP headers sent with every result POST (`Content-Type` is reserved and always `application/json`). */
  headers?: Record<string, string>;
  /** See {@link DEFAULT_RESULT_RETRY_BASE_DELAY_MS}. */
  retryBaseDelayMs?: number;
  /** See {@link DEFAULT_RESULT_RETRY_MAX_DELAY_MS}. */
  retryMaxDelayMs?: number;
}

/** Composite retry-timer key for a `(operationId, attemptToken)` pair — mirrors `TaskResultOutbox`'s own internal keying. */
function retryKey(operationId: string, attemptToken: string): string {
  return `${operationId}\u0000${attemptToken}`;
}

/** The server's `{ ok: true, disposition }` response body on a successful `/result` POST. */
interface AppliedResultResponse {
  disposition?: string;
}

/** The server's correlated `403` body (COR-1271/COR-237) — `operationId`/`attemptToken` identify the rejected submission; `reason` names why. */
interface ForbiddenResultResponse {
  operationId?: string;
  attemptToken?: string;
  reason?: string;
}

/**
 * Gives `LongPollWorker` result-delivery semantics equivalent to
 * `RemoteWorker`'s `TaskResultOutbox` + reconnect-flush, adapted to HTTP's
 * stateless request/response model instead of a persistent socket:
 *
 *   - A result is retained (buffered in the same `TaskResultOutbox`
 *     abstraction `RemoteWorker` uses, parameterized for this transport's
 *     body shape) until the server's disposition response is actually READ,
 *     not merely until the POST resolves.
 *   - `applied` / `duplicate` / `dead-lettered` — any of the three durable
 *     dispositions `commitTaskLedgerCompletion` can produce — acknowledges
 *     and drops the entry, exactly like a WebSocket `taskResultAck`.
 *   - A network failure, an uncorrelated `403` (no identity in the body, or
 *     one that does not match this submission — e.g. `authorizeWorkerPrincipal`'s
 *     bare auth-rejection `403`), or any other non-2xx status (5xx, 429, 400,
 *     413) is treated as TRANSIENT and retried with a capped exponential
 *     backoff, per entry.
 *   - A correlated `403` (COR-1271: `operationId`/`attemptToken` in the body
 *     match this exact submission) is a PERMANENT rejection — the server
 *     will never apply this result no matter how many times it is resent —
 *     and drops the entry, exactly like `RemoteWorker`'s `#handleProtocolError`.
 *
 * Two deliberate non-drops, matching COR-1271's own carve-outs on the
 * WebSocket transport rather than inventing a different policy here:
 *   - `400` is DETERMINISTIC from a body this worker built itself (a
 *     malformed `operationId`/`attemptToken`/`status`), so retrying cannot
 *     fix it — but it should also never happen for a well-formed submission,
 *     so treating it as transient-and-retried (rather than silently
 *     dropping) keeps a genuine construction bug visible through repeated,
 *     loggable failures instead of hiding it as a quiet data loss.
 *   - `413` (oversized payload) still has the server apply a SUBSTITUTE
 *     failed result on this worker's behalf before answering — dropping the
 *     original buffered entry on the 413 itself could lose the result if
 *     that substitute application then failed too, recreating the exact bug
 *     COR-1271 fixed one step over. Retrying an oversized payload will keep
 *     failing the same way, which is the visible, honest outcome; it is not
 *     silently lost.
 *
 * Unit-testable against a fake `fetch` — see `long-poll-result-delivery.test.ts`.
 *
 * @module worker/long-poll-result-delivery
 */
export class LongPollResultDelivery {
  readonly #outbox: TaskResultOutbox<LongPollTaskResultBody>;
  readonly #resultUrl: string;
  readonly #headers: Record<string, string> | undefined;
  readonly #retryBaseDelayMs: number;
  readonly #retryMaxDelayMs: number;
  readonly #pendingRetries = new Map<string, ReturnType<typeof setTimeout>>();
  #running = true;

  constructor(
    options: LongPollResultDeliveryOptions,
    outbox: TaskResultOutbox<LongPollTaskResultBody> = new TaskResultOutbox(),
  ) {
    this.#resultUrl = options.resultUrl;
    this.#headers = options.headers;
    this.#retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RESULT_RETRY_BASE_DELAY_MS;
    this.#retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RESULT_RETRY_MAX_DELAY_MS;
    this.#outbox = outbox;
  }

  /** Number of buffered results still awaiting a durable disposition. */
  get unacknowledgedCount(): number {
    return this.#outbox.size;
  }

  /** Whether the buffer is at or above its ceiling (COR-235: poll-loop backpressure). */
  get full(): boolean {
    return this.#outbox.full;
  }

  /** See `TaskResultOutbox.shouldWarnFull`. */
  shouldWarnFull(): boolean {
    return this.#outbox.shouldWarnFull();
  }

  /**
   * Buffer a result and attempt its first delivery, resolving once that
   * FIRST attempt's round trip completes (whether it acknowledged, was
   * dropped, or scheduled a retry) — called exactly once per produced
   * result, regardless of whether delivery is currently {@link suspend}ed:
   * this is the actual output of just-completed work, not a scheduled retry,
   * and always goes out (mirrors `RemoteWorker`'s `#executeTask`, which
   * always attempts its result send once produced).
   *
   * The caller awaits only this first attempt, matching the pre-COR-235
   * timing its own `#inFlight`/heartbeat bookkeeping already assumed — any
   * RETRY beyond this first attempt runs on its own backgrounded timer,
   * decoupled from whatever called `deliver()`, which is the actual fix:
   * previously a failed send had nowhere further to go at all.
   */
  async deliver(message: LongPollTaskResultBody): Promise<void> {
    this.#outbox.buffer(message);
    await this.#send(message, this.#retryBaseDelayMs);
  }

  /**
   * Resume delivery after a {@link suspend}: re-attempt every currently
   * buffered entry immediately, mirroring `RemoteWorker`'s reconnect-time
   * outbox flush. Called from `LongPollWorker.start()`.
   */
  flush(): void {
    this.#running = true;
    for (const message of this.#outbox.drainOrder()) {
      void this.#send(message, this.#retryBaseDelayMs);
    }
  }

  /**
   * Suspend delivery: cancel every scheduled retry timer so none fires after
   * this call. Buffered entries are NOT discarded — they remain reportable
   * (`unacknowledgedCount`) and a later {@link flush} resumes them. Called
   * from `LongPollWorker.stop()`.
   */
  suspend(): void {
    this.#running = false;
    for (const timer of this.#pendingRetries.values()) clearTimeout(timer);
    this.#pendingRetries.clear();
  }

  /** Terminal disposal: suspend and discard every buffered entry (mirrors `RemoteWorker`'s `[Symbol.dispose]`). */
  dispose(): void {
    this.suspend();
    this.#outbox.clear();
  }

  async #send(message: LongPollTaskResultBody, retryDelayMs: number): Promise<void> {
    let response: Response;
    try {
      response = await fetch(this.#resultUrl, {
        method: 'POST',
        headers: { ...this.#headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });
    } catch {
      // Network failure — retained; retry with bounded backoff.
      this.#scheduleRetry(message, retryDelayMs);
      return;
    }

    if (response.status === 403) {
      await this.#handleForbidden(message, response, retryDelayMs);
      return;
    }

    if (!response.ok) {
      // Every other non-2xx (5xx, 429, 400, 413, ...) is treated as
      // transient — see this class's doc comment for why 400 and 413
      // specifically are deliberate, not oversights.
      this.#scheduleRetry(message, retryDelayMs);
      return;
    }

    let body: AppliedResultResponse;
    try {
      body = (await response.json()) as AppliedResultResponse;
    } catch {
      // Malformed 2xx body — treat conservatively as unacknowledged.
      this.#scheduleRetry(message, retryDelayMs);
      return;
    }

    if (
      body.disposition === 'applied' ||
      body.disposition === 'duplicate' ||
      body.disposition === 'dead-lettered'
    ) {
      if (body.disposition === 'dead-lettered') {
        console.warn(
          `[weft] LongPollWorker result for operation ${message.operationId} (attempt ${message.attemptToken}) was dead-lettered by the server; the activity's outcome was not applied to the workflow`,
        );
      }
      this.#acknowledge(message);
      return;
    }

    // Unrecognized 2xx body shape — conservatively treat as unacknowledged.
    this.#scheduleRetry(message, retryDelayMs);
  }

  async #handleForbidden(
    message: LongPollTaskResultBody,
    response: Response,
    retryDelayMs: number,
  ): Promise<void> {
    let identity: ForbiddenResultResponse = {};
    try {
      identity = (await response.json()) as ForbiddenResultResponse;
    } catch {
      // Malformed body — falls through to the uncorrelated branch below.
    }

    const correlates =
      identity.operationId === message.operationId &&
      identity.attemptToken === message.attemptToken;
    if (!correlates) {
      // No confirmed correlation to THIS submission (e.g. `authorizeWorkerPrincipal`'s
      // bare `403`, or a body missing/mismatching identity) — never drop on
      // it, mirroring `RemoteWorker#handleProtocolError`'s "no correlation ->
      // warn only, keep buffered" behavior.
      console.warn(
        `[weft] LongPollWorker taskResult for operation "${message.operationId}" got an uncorrelated 403 (no matching rejection identity); treating as transient and retrying`,
      );
      this.#scheduleRetry(message, retryDelayMs);
      return;
    }

    const dropped = this.#outbox.reject(message.operationId, message.attemptToken);
    this.#clearRetryTimer(message);
    console.warn(
      `[weft] LongPollWorker taskResult for operation "${message.operationId}" (attempt "${message.attemptToken}") permanently rejected by server` +
        (identity.reason !== undefined ? ` (${identity.reason})` : '') +
        (dropped
          ? '; dropping the buffered result, it will not be resent'
          : '; no matching buffered result was found'),
    );
  }

  #acknowledge(message: LongPollTaskResultBody): void {
    this.#outbox.acknowledge(message.operationId, message.attemptToken);
    this.#clearRetryTimer(message);
  }

  #scheduleRetry(message: LongPollTaskResultBody, delayMs: number): void {
    // Suspended (stop()/dispose() already ran, possibly racing this async
    // continuation) — never arm a new timer once suspended; a later flush()
    // is what resumes delivery.
    if (!this.#running) return;

    const key = retryKey(message.operationId, message.attemptToken);
    const existingTimer = this.#pendingRetries.get(key);
    if (existingTimer !== undefined) clearTimeout(existingTimer);

    const nextDelayMs = Math.min(delayMs * 2, this.#retryMaxDelayMs);
    const timer = setTimeout(() => {
      this.#pendingRetries.delete(key);
      // The entry might have been acknowledged/rejected by an earlier retry
      // (or dropped by disposal) since this timer was scheduled.
      if (this.#outbox.has(message.operationId, message.attemptToken)) {
        void this.#send(message, nextDelayMs);
      }
    }, delayMs);
    this.#pendingRetries.set(key, timer);
  }

  #clearRetryTimer(message: LongPollTaskResultBody): void {
    const key = retryKey(message.operationId, message.attemptToken);
    const timer = this.#pendingRetries.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#pendingRetries.delete(key);
    }
  }
}
