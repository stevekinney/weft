/**
 * Attempt-fenced `AbortController` tracking, shared by {@link RemoteWorker}
 * and {@link LongPollWorker} (COR-223).
 *
 * Both worker classes execute one activity per in-flight `operationId` at a
 * time in the common case, but a lease-expiry redispatch can land the SAME
 * `operationId` back on the SAME worker instance under a NEW `attemptToken`
 * while the earlier attempt's activity promise is still settling (the
 * earlier attempt hasn't heard about its own supersession yet — it is still
 * running, or unwinding after being aborted). Before this module, both
 * workers kept a `Map<operationId, { controller, attemptToken }>` and let
 * each attempt's `finally` block `.delete(operationId)` unconditionally —
 * whichever attempt's `finally` ran LAST won, deleting the map entry
 * regardless of which attempt it actually belonged to. If the newer attempt's
 * entry was overwritten into the map and then the OLDER attempt's `finally`
 * ran after it, the older attempt's cleanup deleted the newer attempt's still
 * very-much-alive controller — exactly the failure COR-223's tuple-key
 * requirement exists to prevent.
 *
 * This map is keyed by the full `(operationId, attemptToken)` tuple instead:
 * two attempts of the same operation never collide, and each attempt's
 * `finally` block can only ever delete its OWN entry.
 *
 * @module worker/attempt-controllers
 */

function attemptKey(operationId: string, attemptToken: string): string {
  // `\u0000` cannot appear in either id (both are opaque server-issued
  // strings, never user-controlled delimiters), so this composite key never
  // collides across different (operationId, attemptToken) pairs the way a
  // naive `${a}:${b}` concatenation could if either half ever contained ':'.
  return `${operationId}\u0000${attemptToken}`;
}

/**
 * A tuple-keyed table of in-flight activity `AbortController`s (COR-223).
 *
 * @example
 * ```ts
 * import { AttemptControllerTable } from '@lostgradient/weft';
 *
 * const table = new AttemptControllerTable();
 * const controller = new AbortController();
 * table.set('op-1', 'attempt-1', controller);
 * table.get('op-1', 'attempt-1'); // controller
 * table.delete('op-1', 'attempt-1'); // only this exact attempt's entry
 * ```
 */
type AttemptEntry = {
  controller: AbortController;
  /**
   * The attempt's automatic per-attempt heartbeat interval, attached via
   * {@link AttemptControllerTable.setHeartbeatTimer} — `null` until then, or
   * for a caller that never arms one.
   */
  heartbeatTimer: ReturnType<typeof setInterval> | null;
};

export class AttemptControllerTable {
  #entries = new Map<string, AttemptEntry>();

  /** Record the controller owning `attemptToken`'s execution of `operationId`. */
  set(operationId: string, attemptToken: string, controller: AbortController): void {
    this.#entries.set(attemptKey(operationId, attemptToken), { controller, heartbeatTimer: null });
  }

  /**
   * Look up the controller for exactly this `(operationId, attemptToken)`
   * pair — `undefined` when no such attempt is tracked, including when a
   * DIFFERENT attempt of the same `operationId` is currently tracked instead
   * (a stale `attemptToken` matches nothing, by construction of the key).
   */
  get(operationId: string, attemptToken: string): AbortController | undefined {
    return this.#entries.get(attemptKey(operationId, attemptToken))?.controller;
  }

  /**
   * Attach the attempt's automatic per-attempt heartbeat interval (armed by
   * both {@link RemoteWorker} and {@link LongPollWorker} right after `set()`)
   * so {@link delete} and {@link abortAll} clear it too. Aborting the
   * controller only asks the activity function to stop — an activity that
   * doesn't check its signal keeps running, and without this, its heartbeat
   * interval would keep firing real timers until the activity's promise is
   * eventually garbage-collected. The attempt's own `finally` block still
   * clears its local `heartbeatTimer` reference on the normal completion
   * path; this covers the attempt being torn down out from under it instead
   * (drain timeout, dispose, or another attempt superseding it).
   */
  setHeartbeatTimer(
    operationId: string,
    attemptToken: string,
    timer: ReturnType<typeof setInterval>,
  ): void {
    const entry = this.#entries.get(attemptKey(operationId, attemptToken));
    if (entry === undefined) return;
    entry.heartbeatTimer = timer;
  }

  /**
   * Remove exactly this attempt's entry, clearing its heartbeat interval (if
   * any) first. A stale attempt's `finally` block calling this with its OWN
   * (now-superseded) `attemptToken` never touches a newer attempt's live
   * entry for the same `operationId` — the whole point of keying by the
   * tuple rather than `operationId` alone.
   */
  delete(operationId: string, attemptToken: string): void {
    const key = attemptKey(operationId, attemptToken);
    const entry = this.#entries.get(key);
    if (entry?.heartbeatTimer !== null && entry?.heartbeatTimer !== undefined) {
      clearInterval(entry.heartbeatTimer);
    }
    this.#entries.delete(key);
  }

  /**
   * Abort every tracked controller (with an optional reason), clear every
   * tracked heartbeat interval, and clear the table.
   */
  abortAll(reason?: unknown): void {
    for (const entry of this.#entries.values()) {
      if (entry.heartbeatTimer !== null) {
        clearInterval(entry.heartbeatTimer);
      }
      entry.controller.abort(reason);
    }
    this.#entries.clear();
  }
}

/**
 * The literal reported for a cooperatively cancelled activity when no
 * string cancellation reason is available on the `AbortSignal` — a signal
 * aborted with no reason (drain/dispose/timeout paths that call
 * `controller.abort()` with no argument) or a non-string reason.
 */
export const DEFAULT_CANCELLED_TASK_ERROR = 'Task cancelled';

/**
 * The error text to report on a `taskResult`/delivery for an activity whose
 * `AbortSignal` fired (COR-223): the operator-supplied cancellation reason
 * when the signal carries one as a string, else the generic fallback. A
 * signal aborted by drain/dispose/timeout logic (not a server `cancel`
 * control) never carries a string reason, so it always falls back.
 */
export function cancellationErrorMessage(signal: AbortSignal): string {
  return typeof signal.reason === 'string' ? signal.reason : DEFAULT_CANCELLED_TASK_ERROR;
}
