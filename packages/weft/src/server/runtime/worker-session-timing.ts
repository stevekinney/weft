/**
 * The session lifecycle instants the server tracks outside the worker
 * registry, in the shape `weft.workers.diagnostics` reports them.
 *
 * - A WebSocket worker whose socket dropped inside the reconnect grace window
 *   stays registered until the window closes. The server keeps the closing
 *   instant beside the deferred requeue's timer in `pendingWorkerRequeues`, so
 *   it exists exactly while that timer does.
 * - An HTTP long-poll worker holds a session lease that every poll and
 *   heartbeat renews. The lease runs out `WORKER_SESSION_LEASE_TIMEOUT_MS`
 *   after the session's last poll or heartbeat, the same rule
 *   `authorizeWorkerSessionAccess` enforces.
 *
 * Neither instant is stored anywhere else, so this derives them on read and
 * can never disagree with the code that acts on them.
 *
 * @module server/runtime/worker-session-timing
 */
import type { WorkerSessionTiming } from '../operations/get-worker-diagnostics.ts';
import type { LongPollWorkerSession, PendingWorkerRequeue } from './context.ts';
import { WORKER_SESSION_LEASE_TIMEOUT_MS } from './worker-session-access.ts';

export function createWorkerSessionTiming(sources: {
  readonly longPollWorkerSessions: ReadonlyMap<string, LongPollWorkerSession>;
  readonly pendingWorkerRequeues: ReadonlyMap<string, PendingWorkerRequeue>;
}): WorkerSessionTiming {
  return (workerId) => {
    const session = sources.longPollWorkerSessions.get(workerId);
    return {
      reconnectGraceEndsAt: sources.pendingWorkerRequeues.get(workerId)?.endsAt,
      sessionLeaseExpiresAt:
        session === undefined
          ? undefined
          : session.lastHeartbeatAt + WORKER_SESSION_LEASE_TIMEOUT_MS,
    };
  };
}
