/**
 * Small reads of a run's state for tests, so a `waitForCondition` predicate or an assertion reads a
 * value and never reaches a member through an `await` expression.
 */
import type { Engine } from '../core/engine.ts';
import type { WorkflowStatus } from '../core/types.ts';

/** The run's status, or `undefined` when no run has the id. */
export async function statusOf(engine: Engine, id: string): Promise<WorkflowStatus | undefined> {
  const state = await engine.get(id);
  return state?.status;
}

/** Whether the run is parked in `ctx.waitForSignal` on `signalName`. */
export async function isParkedOn(engine: Engine, id: string, signalName: string): Promise<boolean> {
  const state = await engine.get(id);
  return state?.waitingForSignals?.includes(signalName) === true;
}

/** Start a run and wait for it to settle, resolving the settled run's result. */
export async function startAndSettle(
  engine: Engine,
  type: string,
  input: unknown,
  id: string,
): Promise<unknown> {
  const handle = await engine.start(type, input, { id });
  return handle.result();
}
