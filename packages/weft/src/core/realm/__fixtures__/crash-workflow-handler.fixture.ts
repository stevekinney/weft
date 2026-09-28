/**
 * A workflow handler that crashes its own Worker mid-turn, rather than
 * failing gracefully (COR-249's engine integration, R2E — the
 * `RevisionRealmExecutionStrategy#dispatch` crash-recovery regression).
 *
 * `handleRunMessage`'s own try/catch (`src/workers/workflow-runner.ts`)
 * already converts any exception the generator raises DURING its awaited
 * step into a graceful `{ type: 'failed' }` outbound message — that path
 * never crashes the realm, it resolves `dispatchTurn`'s promise
 * successfully, and `RevisionRealmExecutionStrategy#dispatch`'s SUCCESS
 * branch already releases the realm for it. To exercise the CATCH branch —
 * a real Worker crash while a turn is genuinely still pending — this
 * handler instead schedules its throw on a macrotask
 * (`setTimeout(..., 0)`), outside `handleRunMessage`'s awaited chain
 * entirely, and then suspends on a promise that never settles so the
 * generator's own turn is still in flight when that timer fires. The
 * uncaught exception in the timer callback fires the Worker's real `error`
 * event (the same mechanism `revision-realm-throwing-worker.ts` proves for
 * a load-time throw, here mid-turn instead), which
 * `WorkerRealm#handleWorkerFailure` turns into `#forceDown()` +
 * `#settlePendingTurns()` — rejecting the still-pending `dispatchTurn` call
 * with `Turn N was not accepted: realm-not-active`.
 *
 * @module core/realm/__fixtures__/crash-workflow-handler
 */

import type { WorkerWorkflowContext } from '../../../workers/workflow-runner.ts';
import type { RevisionRealmWorkflowHandler } from './revision-realm-generator-worker-entry.ts';

export const CRASH_WORKFLOW_NAME = 'r2e-crash-workflow';

/** Input value that triggers the deliberate mid-turn crash below; any other input completes normally, so the same fixture proves a later start on a freshly warmed realm still works. */
export const CRASH_WORKFLOW_TRIGGER_INPUT = 'crash-mid-turn';

export function createCrashWorkflowHandler(): RevisionRealmWorkflowHandler {
  return async function* (_ctx: WorkerWorkflowContext, input: unknown) {
    if (input === CRASH_WORKFLOW_TRIGGER_INPUT) {
      setTimeout(() => {
        throw new Error('r2e-crash-workflow: deliberate mid-turn Worker crash');
      }, 0);
      // Never resolves: the scheduled throw above always fires (and takes
      // the whole Worker thread down with it) before anything here could.
      await new Promise<never>(() => {});
    }
    return { ok: true, input };
  };
}
