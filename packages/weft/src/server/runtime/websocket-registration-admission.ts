/**
 * Admission gates for a worker's `register` message: the `workers:write` scope
 * check and the operator-supplied admission policy.
 *
 * Split out of `websocket-worker-registration.ts` to keep that module under the
 * repository's per-file line ceiling.
 *
 * @module server/runtime/websocket-registration-admission
 */

import type { ServerWebSocket } from 'bun';

import { isAuthenticated } from "../../embedded/backchannel/src/internals.ts";
import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';
import type {
  WorkerAdmissionDecision,
  WorkerAdmissionPolicy,
  WorkerAdmissionRequest,
} from '../worker-admission-policy.ts';
import type { ServerContext } from './context.ts';

/**
 * Whether the connection's principal is allowed to register a worker. An
 * absent principal means authentication is disabled on this server, so the
 * registration is allowed; a present principal must carry `workers:write`.
 */
export function principalMayRegisterWorker(principal: WebSocketData['principal']): boolean {
  if (principal === undefined) return true;
  return isAuthenticated(principal) && principal.hasScope('workers:write');
}

/**
 * Run the operator-supplied admission policy, converting a thrown error into
 * a rejection decision instead of letting it propagate. A throwing policy
 * must not leave the client hanging with no `registerError` and no closed
 * socket — `registerWorker`'s caller only logs an unhandled rejection.
 */
export function evaluateWorkerAdmissionPolicy(
  policy: WorkerAdmissionPolicy,
  request: WorkerAdmissionRequest,
): WorkerAdmissionDecision {
  try {
    return policy(request);
  } catch (error) {
    return {
      status: 'rejected',
      reason: `workerAdmissionPolicy threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export const HIJACK_MESSAGE = 'workerId is already registered to an active connection';

/**
 * Read-only form of the hijack guard: another live socket owns this workerId and has not
 * disconnected (no pending grace-period requeue). It changes nothing, so it can run before the
 * durable catalog write that must not happen for a registration this server will refuse.
 */
export function isActiveWorkerIdHijack(
  context: ServerContext,
  ws: ServerWebSocket<WebSocketData>,
  workerId: string,
): boolean {
  if (context.pendingWorkerRequeues.has(workerId)) return false;
  const existingSocket = context.workerSockets.get(workerId);
  return existingSocket !== undefined && existingSocket !== ws;
}
