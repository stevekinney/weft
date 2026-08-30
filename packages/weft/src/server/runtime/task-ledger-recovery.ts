/**
 * Startup task-ledger recovery (WFT-23).
 *
 * A one-shot full scan of the durable `task-ledger:` keyspace, run once per
 * `serve()` call before the recovery gate on `ServerContext.taskLedgerRecovery`
 * opens (see `buildServerContext` in `serve-internals.ts`). Reconstructs the
 * in-memory registry, deadline tracker, and task-queue indexes that
 * `restoreInflightTasks` used to rebuild from the retired `op:inflight:`
 * keyspace — those indexes are process-local caches; the ledger is the
 * durable authority, so nothing here writes state, only rehydrates memory to
 * match what storage already says.
 *
 * One branch per non-terminal state:
 *  - `queued`   — redispatch through the normal dispatch path so a lost
 *                 `scheduleDelayedDispatch` timer (or a record this process
 *                 never dispatched at all) still becomes runnable.
 *  - `leased`, deadline still in the future — rehydrate registry ownership
 *                 and the deadline tracker so heartbeats and completions
 *                 from the original worker are recognized after reconnect.
 *  - `leased`, deadline already passed — requeue or exhaust through the same
 *                 `reassignOrExpireTask` CAS path `scanExpiredTasks` and
 *                 `reconcileOrphanedRecords` use; deletion is never correct
 *                 here (see `RequeueExpiredAttemptInput`'s contract).
 *  - `completing` — rehydrate registry ownership only. The pending result
 *                 value isn't persisted (only its digest), so recovery
 *                 cannot resolve this state itself; only the worker's
 *                 redelivered `taskResult`, landing on
 *                 `commitTaskLedgerCompletion`'s crash-resumption branch,
 *                 can. Recovery's job is to make sure that redelivery still
 *                 passes the WebSocket ownership guard after a restart.
 *  - `cancelling` — rehydrate registry ownership only, for the same reason:
 *                 nothing in the current runtime calls `commitCancellation`
 *                 yet (a future project's scope), so there is no action to
 *                 resume, only ownership to preserve.
 *  - `terminal`, `deadLettered` — already resolved; skipped.
 *
 * A single corrupt or unrecognized record is logged and skipped — ordinary
 * data hygiene, not a recovery failure. A failure in the scan itself (the
 * storage iterator throwing) propagates and rejects the whole gate: per the
 * project brief, "a scan failure leaves the remote worker plane unhealthy
 * and prevents new claims rather than logging and continuing with partial
 * indexes."
 *
 * @module server/runtime/task-ledger-recovery
 */

import type { ServeOptions } from '../index.ts';
import {
  decodeRemoteTaskRecord,
  type RemoteTaskCancelling,
  type RemoteTaskCompleting,
  type RemoteTaskLeased,
  type RemoteTaskRecord,
} from '../task-ledger.ts';
import type { ServerContext } from './context.ts';
import { scheduleDelayedDispatch } from './task-dispatch.ts';
import { reassignOrExpireTask, taskDispatchFromLedgerRecord } from './task-reconciliation.ts';

/**
 * Rebuilds the workflow→operations reverse index for a single recovered
 * record. Only invoked when the record has a `workflowId`. Mirrors the
 * lookup `cleanupWorkflowIndex` (`serve-internals.ts`) reverses on
 * completion.
 */
function rebuildWorkflowIndex(
  context: ServerContext,
  operationId: string,
  workflowId: string | undefined,
): void {
  if (!workflowId) return;
  let operationIds = context.workflowOperations.get(workflowId);
  if (!operationIds) {
    operationIds = new Set();
    context.workflowOperations.set(workflowId, operationIds);
  }
  operationIds.add(operationId);
  context.operationToWorkflow.set(operationId, workflowId);
}

/**
 * Rehydrate registry ownership (and, transitively, the worker's occupied
 * capacity slot) for a `leased`, `completing`, or `cancelling` record whose
 * attempt is still current. Shared because all three states carry the same
 * lease-holder identity (`workerSessionId`, `attemptToken`, `leaseDeadline`)
 * and need identical treatment: the WebSocket ownership guard
 * (`onTaskResultMessage`/`onHeartbeatMessage`) checks `WorkerRegistry`, not
 * the ledger, so a reconnecting worker's messages for any of these states
 * are rejected as unowned unless this runs first.
 */
function rehydrateWorkerOwnership(
  context: ServerContext,
  record: RemoteTaskLeased | RemoteTaskCompleting | RemoteTaskCancelling,
  now: number,
): void {
  const remaining = Math.max(0, record.leaseDeadline - now);
  context.registry.assignTask(
    record.workerSessionId,
    record.operationId,
    remaining,
    record.fairShareKey,
    record.attemptToken,
  );
  // assignTask's `visibilityTimeout` parameter doubles as the stored task's
  // future heartbeat-extension duration — passing the shortened `remaining`
  // above would permanently shrink every later extension. Patch it back to
  // the record's actual configured timeout, matching the old
  // `restoreInflightTasks`'s identical fix-up.
  const tracked = context.registry
    .getWorkerTasks(record.workerSessionId)
    .find((task) => task.operationId === record.operationId);
  if (tracked) {
    tracked.visibilityTimeout = record.visibilityTimeoutMilliseconds;
  }
  rebuildWorkflowIndex(context, record.operationId, record.workflowId);
}

/**
 * Recover a single decoded ledger record — one branch per non-terminal
 * state, matching this module's own doc comment. Extracted from
 * {@link runTaskLedgerRecovery} purely to keep that function's per-record
 * try/catch loop under the repository's complexity ceiling; there is no
 * other reason to call this directly.
 */
async function recoverTaskLedgerRecord(
  context: ServerContext,
  options: ServeOptions,
  decoded: RemoteTaskRecord,
  now: number,
): Promise<void> {
  switch (decoded.state) {
    case 'queued': {
      const delay = Math.max(0, decoded.availableAt - now);
      scheduleDelayedDispatch(context, options, taskDispatchFromLedgerRecord(decoded), delay);
      return;
    }
    case 'leased': {
      if (decoded.leaseDeadline > now) {
        rehydrateWorkerOwnership(context, decoded, now);
        context.deadlineTracker.add({
          operationId: decoded.operationId,
          deadline: decoded.leaseDeadline,
        });
        return;
      }
      await reassignOrExpireTask(context, options, decoded.operationId, decoded);
      return;
    }
    case 'completing':
    case 'cancelling': {
      rehydrateWorkerOwnership(context, decoded, now);
      return;
    }
    case 'terminal':
    case 'deadLettered':
      return;
    default: {
      // Exhaustiveness guard: adding a new RemoteTaskRecord state without a
      // case above must fail this typecheck.
      const exhaustive: never = decoded;
      void exhaustive;
    }
  }
}

/**
 * Run startup task-ledger recovery to completion. Resolves once every
 * non-terminal record has been reconstructed; rejects if the scan itself
 * failed. Callers gate task-plane entry points on the resulting promise
 * rather than awaiting this directly from within another recovery-time
 * scan — see `ServerContext.taskLedgerRecovery`'s doc comment.
 */
export async function runTaskLedgerRecovery(
  context: ServerContext,
  options: ServeOptions,
): Promise<void> {
  const now = Date.now();
  for await (const [key, value] of options.engine.storage.scan('task-ledger:')) {
    // `server.stop()` may run while this scan is still in flight (a slow or
    // unbounded storage iterator). Its timer-clearing disposer sets this
    // flag before clearing `pendingTimers`, so checking it here stops the
    // scan from processing further records — and, in particular, from
    // issuing a durable CAS write (the expired-`leased` branch) or arming a
    // new timer (the `queued` branch, though `scheduleDelayedDispatch` also
    // guards itself) against a server that is already torn down.
    if (context.stopping) return;
    try {
      // Decoding lives inside this try, not before it — malformed msgpack
      // bytes throw (`decode`'s underlying decoder rejects trailing/partial
      // data), and a single corrupt record must not abort the rest of the
      // scan any more than a processing failure does.
      const decoded = decodeRemoteTaskRecord(value);
      if (decoded === null) {
        console.error(
          `[weft] Unrecognized task ledger record at "${key}" during startup recovery — skipping`,
        );
        continue;
      }
      await recoverTaskLedgerRecord(context, options, decoded, now);
    } catch (error) {
      console.error(`[weft] Failed to recover task ledger record at "${key}" — skipping:`, error);
    }
  }
}
