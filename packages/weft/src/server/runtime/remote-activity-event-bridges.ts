/**
 * Server-side listeners bridging the engine-owned remote-activity events
 * (COR-152, `core/engine/remote-activity-broker.ts`) to the transport this
 * `serve()` instance owns. Both are purely low-latency hints: correctness
 * never depends on either running.
 *
 * - `RemoteActivityQueuedEvent`: the engine just enqueued a task directly
 *   onto its own storage, bypassing `WeftServer.dispatchTask` entirely.
 *   Attempts an immediate dispatch to a connected worker — the same
 *   `dispatchTaskImpl` redispatch path `reconcileOrphanedRecords` already
 *   uses for a `queued` record "written by a peer." An engine with no
 *   server attached still leaves the task durably `queued`, and once a
 *   server DOES attach, startup recovery (`task-ledger-recovery.ts`) and
 *   the periodic `reconcileOrphanedRecords` sweep both already discover and
 *   dispatch it independently.
 *
 * - `RemoteActivityCancellationRequestedEvent`: a workflow's terminal
 *   cleanup just discarded a pending async-activity token (acceptance
 *   criterion 10). Requests cancellation of the matching durable task
 *   through the exact same `WeftServer.cancelTask` path an operator-initiated
 *   cancellation uses. Safe to fire unconditionally, including for an
 *   ordinary (non-remote) `ctx.completeAsync()` token: `cancelTask` is a
 *   no-op when no ledger record exists for the id.
 *
 * @module server/runtime/remote-activity-event-bridges
 */

import {
  RemoteActivityCancellationRequestedEvent,
  RemoteActivityQueuedEvent,
} from '../../core/events.ts';
import { decodeRemoteTaskRecord, taskLedgerKey } from '../../core/task-ledger/task-ledger.ts';
import type { ServeOptions } from '../index.ts';
import type { ServerContext } from './context.ts';
import { cancelTask, dispatchTaskImpl } from './task-dispatch.ts';
import { taskDispatchFromLedgerRecord } from './task-reconciliation.ts';

const CANCELLATION_REASON = 'Workflow terminated with the activity still pending';

/**
 * The handler re-reads the ledger record fresh (the event itself carries
 * only `operationId`/`workflowId`/`queue`, not the full envelope) — by the
 * time this fires the record could already have moved past `queued` (a
 * concurrent redispatch, or in the rare case an in-process reconciliation
 * tick raced ahead of it), in which case `decoded.state !== 'queued'` and
 * this is a silent no-op rather than a double-dispatch.
 */
function installRemoteActivityQueuedListener(
  context: ServerContext,
  options: ServeOptions,
): () => void {
  const handler = (event: RemoteActivityQueuedEvent): void => {
    if (context.stopping) return;
    void (async () => {
      const decoded = decodeRemoteTaskRecord(
        await options.engine.storage.get(taskLedgerKey(event.operationId)),
      );
      if (decoded === null || decoded.state !== 'queued') return;
      if (context.registry.isAssigned(decoded.operationId)) return;
      if (context.taskQueue.isTracked(decoded.operationId)) return;
      await dispatchTaskImpl(context, options, taskDispatchFromLedgerRecord(decoded), {
        redispatch: true,
      });
    })().catch((error: unknown) => {
      console.error(
        `[weft] Immediate dispatch of remote activity task "${event.operationId}" failed — ` +
          'the periodic reconciliation scan will retry it:',
        error,
      );
    });
  };

  options.engine.addEventListener(RemoteActivityQueuedEvent.type, handler);
  return () => options.engine.removeEventListener(RemoteActivityQueuedEvent.type, handler);
}

function installRemoteActivityCancellationListener(
  context: ServerContext,
  options: ServeOptions,
): () => void {
  const handler = (event: RemoteActivityCancellationRequestedEvent): void => {
    if (context.stopping) return;
    void cancelTask(context, options, event.operationId, CANCELLATION_REASON).catch(
      (error: unknown) => {
        console.error(
          `[weft] Cancellation request for remote activity task "${event.operationId}" failed:`,
          error,
        );
      },
    );
  };

  options.engine.addEventListener(RemoteActivityCancellationRequestedEvent.type, handler);
  return () =>
    options.engine.removeEventListener(RemoteActivityCancellationRequestedEvent.type, handler);
}

/** Install both listeners and return one combined disposer. */
export function installRemoteActivityEventBridges(
  context: ServerContext,
  options: ServeOptions,
): () => void {
  const disposeQueued = installRemoteActivityQueuedListener(context, options);
  const disposeCancellation = installRemoteActivityCancellationListener(context, options);
  return () => {
    disposeQueued();
    disposeCancellation();
  };
}
