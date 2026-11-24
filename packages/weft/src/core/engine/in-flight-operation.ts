/**
 * The top-level operation an inline run's handler turn is processing (COR-1597).
 *
 * A termination ends the run's durable record at once, but a turn that is running an `activity`
 * is still writing: its result, its timeline entry, the caller's own side effects. A reader that
 * acts on `handle.result()` must see those writes, so a termination asks this record whether an
 * activity is in flight before it settles the run's result waiter (see
 * `terminal-settlement-pending.ts`). Only `activity` counts: it is the one operation type whose
 * in-flight work is a bounded write the caller needs, and every other type keeps today's
 * immediate settle.
 *
 * Each turn records a token and clears the record only while it still holds that token. A
 * completed activity starts the next generator advance before its own `processOperation` returns
 * (`feedOperationResult`), so the next turn can record its own operation before this turn's
 * `finally` runs, and an unguarded clear would erase it. `InlineExecutionStrategy` tracks its
 * turns the same way.
 *
 * @module core/engine/in-flight-operation
 */
import type { ContextOperationRequest } from '../context.ts';
import type { EngineInternals } from './internals.ts';

/** One turn's record of the operation it dispatched. */
export type InFlightOperation = {
  readonly token: symbol;
  readonly operation: ContextOperationRequest;
  /** Called when the operation defers to an out-of-band completion; see `captureInFlightActivityTurn`. */
  readonly deferralListeners: Array<() => void>;
};

/** Record `operation` as the one this workflow's turn is processing, and return its record. */
export function beginInFlightOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: ContextOperationRequest,
): InFlightOperation {
  const record: InFlightOperation = {
    token: Symbol('in-flight-operation'),
    operation,
    deferralListeners: [],
  };
  internals.inFlightOperations.set(workflowId, record);
  return record;
}

/** Clear the workflow's record, but only if it is still `record` and not a later turn's. */
export function endInFlightOperation(
  internals: EngineInternals,
  workflowId: string,
  record: InFlightOperation,
): void {
  if (internals.inFlightOperations.get(workflowId)?.token === record.token) {
    internals.inFlightOperations.delete(workflowId);
  }
}

/**
 * Clear the record of an activity that deferred to an out-of-band completion. Its turn hands the
 * router a promise that never settles, so a termination must not wait for it. Cleared only if the
 * record still names this operation.
 */
export function clearDeferredInFlightOperation(
  internals: EngineInternals,
  workflowId: string,
  operationId: string,
): void {
  const record = internals.inFlightOperations.get(workflowId);
  if (record?.operation.type !== 'activity' || record.operation.operationId !== operationId) return;
  internals.inFlightOperations.delete(workflowId);
  // A termination that already captured this turn is waiting on a turn that now never settles.
  for (const listener of record.deferralListeners) listener();
}

/**
 * The handler turn that is running the workflow's in-flight top-level activity, if any, for a
 * termination to settle the result after (see `terminal-settlement-pending.ts`). Captured before
 * the termination evicts the run's turn tracking.
 *
 * The turn ends when the activity does, except for an activity that defers to out-of-band
 * completion: its turn never settles. The returned promise therefore also settles when the
 * activity defers, whether that happened before or after the capture, so a deferring activity
 * never holds the result.
 */
export function captureInFlightActivityTurn(
  internals: EngineInternals,
  workflowId: string,
): Promise<void> | undefined {
  const record = internals.inFlightOperations.get(workflowId);
  if (record?.operation.type !== 'activity') return undefined;
  const turn = internals.inlineStrategy?.waitForWorkflowTurn(workflowId);
  if (turn === undefined) return undefined;
  const deferred = new Promise<void>((resolve) => record.deferralListeners.push(resolve));
  const captured = Promise.race([turn, deferred]);
  // A termination that fails to commit never awaits this, and the turn it follows may reject.
  captured.catch(() => {});
  return captured;
}
