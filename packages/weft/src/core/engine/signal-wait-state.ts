/**
 * The record-shape half of `WorkflowState.waitingForSignals` (COR-1472): the
 * strip every non-running write applies and the decode-time sanitizer. Kept
 * free of engine dependencies so the terminal and suspend writers and the
 * record decoder can import it without reaching into the signal-wait
 * bookkeeping in `signal-wait-tracking.ts`.
 *
 * @module core/engine/signal-wait-state
 */
import type { WorkflowState } from '../types.ts';

/**
 * `state` without `waitingForSignals`. Every write that takes a workflow out of
 * `running` passes its new record through this, so a finished, cancelled,
 * timed-out, failed, or suspended workflow never reports a wait.
 */
export function withoutSignalWaits(state: WorkflowState): WorkflowState {
  if (state.waitingForSignals === undefined) return state;
  const stripped = { ...state };
  delete stripped.waitingForSignals;
  return stripped;
}

/**
 * Drop a decoded `waitingForSignals` that is not a non-empty list of distinct
 * strings. The engine never writes one, so such a value is corruption, and
 * reporting no wait is safer than reporting a malformed one.
 */
export function sanitizeDecodedSignalWaits(state: WorkflowState): void {
  const waits: unknown = state.waitingForSignals;
  if (waits === undefined) return;
  if (
    !Array.isArray(waits) ||
    waits.length === 0 ||
    !waits.every((name) => typeof name === 'string') ||
    new Set(waits).size !== waits.length
  ) {
    delete state.waitingForSignals;
  }
}
