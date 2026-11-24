/**
 * Shared helpers for the `WorkflowState.waitingForSignals` suites (COR-1472).
 *
 * Every wait is awaited through its `signal:waiting` event, which the engine
 * dispatches only after the name is durably listed, so no test polls.
 *
 * @module core/engine/signal-wait-tracking.test-support
 */
import { SignalWaitingEvent } from '../events.ts';
import type { Engine } from './index.ts';
import { getInternals } from './internals.ts';

/** The `waitingForSignals` that `engine.get()` reports for `workflowId`. */
export async function waitingForSignalsOf(
  engine: Engine,
  workflowId: string,
): Promise<readonly string[] | undefined> {
  const state = await engine.get(workflowId);
  return state?.waitingForSignals;
}

/** Resolve with the next `signal:waiting` for `workflowId` and `signalName`. */
export function nextSignalWaiting(
  engine: Engine,
  workflowId: string,
  signalName: string,
): Promise<SignalWaitingEvent> {
  const { promise, resolve } = Promise.withResolvers<SignalWaitingEvent>();
  const listener = (event: Event): void => {
    if (!(event instanceof SignalWaitingEvent)) return;
    if (event.workflowId !== workflowId || event.signalName !== signalName) return;
    engine.removeEventListener(SignalWaitingEvent.type, listener);
    resolve(event);
  };
  engine.addEventListener(SignalWaitingEvent.type, listener);
  return promise;
}

/** Record every `signal:waiting` the engine dispatches, in order. */
export function recordSignalWaitingEvents(engine: Engine): SignalWaitingEvent[] {
  const events: SignalWaitingEvent[] = [];
  engine.addEventListener(SignalWaitingEvent.type, (event) => {
    if (event instanceof SignalWaitingEvent) events.push(event);
  });
  return events;
}

/**
 * Wait for the workflow-state writes already queued for `workflowId` to
 * settle. The signal-wait bookkeeping runs in that per-workflow chain. A
 * `ctx.all` branch woken by `engine.signal()` has ordinarily finished its
 * removal by the time `signal()` resolves, because the removal is all
 * microtask work on `MemoryStorage`. This is the safety net that does not
 * depend on that: the delivery invokes the branch's resolver before
 * returning, the branch's continuation is the first microtask that resolver
 * queued, and it enqueues the removal synchronously, so the removal is in the
 * chain before `signal()` resolves.
 */
export async function settleWorkflowStateWrites(engine: Engine, workflowId: string): Promise<void> {
  await getInternals(engine).workflowStateWriteChains.get(workflowId);
}
