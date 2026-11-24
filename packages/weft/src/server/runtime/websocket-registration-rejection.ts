/**
 * Refusing a worker's `register` message: the rejection log entry and
 * `registerError` frame every gate shares, and the durable deployment-catalog
 * gate that runs after the in-memory digest check.
 *
 * Split out of `websocket-worker-registration.ts` to keep that module under the
 * repository's per-file line ceiling.
 *
 * @module server/runtime/websocket-registration-rejection
 */

import type { ServerWebSocket } from 'bun';

import type { WorkerDeploymentVersionState } from '../../worker/deployment-routing.ts';
import type { WorkerManifest } from '../../worker/manifest/index.ts';
import type { RegisterErrorMessage, RegisterMessage } from '../../worker/protocol.ts';
import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';
import type { ServerContext } from './context.ts';
import { recordDeploymentVersion } from './deployment-version-registration.ts';
import { HIJACK_MESSAGE, isActiveWorkerIdHijack } from './websocket-registration-admission.ts';
import { rejectRegistration } from './websocket-worker-messaging.ts';

/**
 * Record one declined `register` attempt in the registry's bounded rejection
 * log (WFT-29), then send the `registerError` frame and close the socket.
 * `identity` carries whatever deployment fields had already been parsed by
 * the time the calling gate rejected the attempt — most gates run before a
 * `WorkerManifest` exists, so it is usually absent.
 */
export function rejectAndRecordRegistration(
  context: ServerContext,
  ws: ServerWebSocket<WebSocketData>,
  code: RegisterErrorMessage['code'],
  message: string,
  workerId: string | undefined,
  requestedProtocolVersion: number | undefined,
  identity?: { deploymentName?: string; buildId?: string },
): void {
  context.registry.recordRejection({
    code,
    ...(workerId !== undefined ? { workerId } : {}),
    rejectedAt: Date.now(),
    queue: ws.data.queue ?? 'default',
    ...(identity?.deploymentName !== undefined ? { deploymentName: identity.deploymentName } : {}),
    ...(identity?.buildId !== undefined ? { buildId: identity.buildId } : {}),
  });
  rejectRegistration(ws, code, message, requestedProtocolVersion);
}

/**
 * Record the worker's deployment version in the durable catalog before it is
 * accepted, and report the state the catalog holds for it. Only called once the
 * read-only admission gates (live socket, workerId hijack) have passed, so a
 * registration this server would refuse records nothing. A build whose digest
 * conflicts with a connected worker's is refused first, writing nothing (the
 * registry's guard runs before the catalog is touched). A stored version of a
 * different artifact is refused as a `deployment_conflict`; a catalog that cannot
 * be reached closes the socket with 1013 (Try Again Later), a retryable close, and
 * nothing is registered. `RemoteWorker` does not read the close code: its
 * `connect()` rejects, and the caller's own retry loop registers again.
 *
 * Resolves to the stored version's state (`undefined` when no catalog is kept),
 * or `null` when the registration was refused.
 */
export async function recordVersionOrReject(
  context: ServerContext,
  ws: ServerWebSocket<WebSocketData>,
  message: RegisterMessage,
  manifest: WorkerManifest,
  acceptedManifestDigest: string,
): Promise<{ readonly state: WorkerDeploymentVersionState | undefined } | null> {
  const { name, buildId, artifactDigest } = manifest.deployment;
  // Only a registration this server would admit is written: the read-only gates run first, and
  // `commitWorkerRegistration` runs them again synchronously.
  if (ws.readyState !== WebSocket.OPEN) return null;
  if (isActiveWorkerIdHijack(context, ws, message.workerId)) {
    rejectAndRecordRegistration(
      context,
      ws,
      'invalid_registration',
      HIJACK_MESSAGE,
      message.workerId,
      message.protocolVersion,
      { deploymentName: name, buildId },
    );
    return null;
  }
  if (!context.registry.checkDeploymentConsistency(name, buildId, artifactDigest).ok) {
    // `commitWorkerRegistration` rejects it with the registry's own message and records the rejection.
    return { state: undefined };
  }
  const recording = await recordDeploymentVersion(context, manifest, acceptedManifestDigest);
  if (recording.ok) return { state: recording.state };
  if (recording.reason === 'conflict') {
    rejectAndRecordRegistration(
      context,
      ws,
      'deployment_conflict',
      `Deployment "${name}" build "${buildId}" is already registered with a different artifact digest`,
      message.workerId,
      message.protocolVersion,
      { deploymentName: name, buildId },
    );
    return null;
  }
  console.warn(`[weft] ${recording.message}`);
  if (ws.readyState === WebSocket.OPEN) ws.close(1013, 'Deployment catalog unavailable; retry');
  return null;
}
