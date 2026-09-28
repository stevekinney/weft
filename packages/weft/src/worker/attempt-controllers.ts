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
export class AttemptControllerTable {
  #entries = new Map<string, AbortController>();

  /** Record the controller owning `attemptToken`'s execution of `operationId`. */
  set(operationId: string, attemptToken: string, controller: AbortController): void {
    this.#entries.set(attemptKey(operationId, attemptToken), controller);
  }

  /**
   * Look up the controller for exactly this `(operationId, attemptToken)`
   * pair — `undefined` when no such attempt is tracked, including when a
   * DIFFERENT attempt of the same `operationId` is currently tracked instead
   * (a stale `attemptToken` matches nothing, by construction of the key).
   */
  get(operationId: string, attemptToken: string): AbortController | undefined {
    return this.#entries.get(attemptKey(operationId, attemptToken));
  }

  /**
   * Remove exactly this attempt's entry. A stale attempt's `finally` block
   * calling this with its OWN (now-superseded) `attemptToken` never touches a
   * newer attempt's live entry for the same `operationId` — the whole point
   * of keying by the tuple rather than `operationId` alone.
   */
  delete(operationId: string, attemptToken: string): void {
    this.#entries.delete(attemptKey(operationId, attemptToken));
  }

  /** Abort every tracked controller (with an optional reason) and clear the table. */
  abortAll(reason?: unknown): void {
    for (const controller of this.#entries.values()) {
      controller.abort(reason);
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
