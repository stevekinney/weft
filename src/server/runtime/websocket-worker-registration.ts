/**
 * Worker registration handling: manifest validation, deployment consistency,
 * admission policy, and the workerId hijack/reconnect guard.
 *
 * Split out of `websocket-worker.ts` to keep that module under the
 * repository's per-file line ceiling — this is the registration slice of the
 * same WebSocket message handler.
 *
 * @module server/runtime/websocket-worker-registration
 */

import type { ServerWebSocket } from 'bun';

import { WorkerConnectedEvent } from '../../core/events.ts';
import type { WorkerManifest } from '../../worker/manifest/index.ts';
import { digestCanonicalWorkerManifest, parseWorkerManifest } from '../../worker/manifest/index.ts';
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  type RegisterMessage,
  type RemoteWorkerCapabilities,
} from '../../worker/protocol.ts';
import type { WorkerRegistrationInfo } from '../../worker/registry.ts';
import type { ServeOptions } from '../index.ts';
import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';
import { isAuthenticated } from '../principal.ts';
import type {
  WorkerAdmissionDecision,
  WorkerAdmissionPolicy,
  WorkerAdmissionRequest,
} from '../worker-admission-policy.ts';
import type { ServerContext } from './context.ts';
import { rejectRegistration, sendWorkerProtocolMessage } from './websocket-worker-messaging.ts';

const MAX_WORKER_CONCURRENCY = 1_000;
const DEFAULT_WORKER_CONCURRENCY = 10;

/**
 * Whether the connection's principal is allowed to register a worker. An
 * absent principal means authentication is disabled on this server, so the
 * registration is allowed; a present principal must carry `workers:write`.
 */
function principalMayRegisterWorker(principal: WebSocketData['principal']): boolean {
  if (principal === undefined) return true;
  return isAuthenticated(principal) && principal.hasScope('workers:write');
}

/**
 * Flatten a manifest's declared workflows into qualified
 * `${workflowType}.${activityName}` routing activities — the same
 * convention protocol v2 established for the wire, now derived server-side
 * from the accepted manifest instead of echoed from a worker-supplied list.
 */
function deriveActivitiesFromManifest(manifest: WorkerManifest): string[] {
  const activities: string[] = [];
  for (const [workflowType, workflow] of Object.entries(manifest.workflows)) {
    for (const activityName of Object.keys(workflow.activities)) {
      activities.push(`${workflowType}.${activityName}`);
    }
  }
  return activities;
}

/**
 * Build the registry descriptor from an accepted manifest. Every identity
 * field is projected from the manifest the parser validated, not from a
 * worker-supplied top-level field — `runtimeVersion` is omitted rather than
 * stored as an empty string when the manifest declares no runtime version.
 */
function buildWorkerRegistrationInfo(
  message: RegisterMessage,
  manifest: WorkerManifest,
  acceptedManifestDigest: string,
  queue: string,
  concurrency: number,
): WorkerRegistrationInfo {
  const runtimeVersion = manifest.runtime.version === '' ? undefined : manifest.runtime.version;
  return {
    id: message.workerId,
    queue,
    activities: deriveActivitiesFromManifest(manifest),
    concurrency,
    deploymentName: manifest.deployment.name,
    buildId: manifest.deployment.buildId,
    ...(runtimeVersion !== undefined ? { runtimeVersion } : {}),
    manifest,
    acceptedManifestDigest,
    ...(message.startedAt !== undefined ? { startedAt: message.startedAt } : {}),
    // manifest.capabilities is already proven JSON-safe by parseWorkerManifest;
    // RemoteWorkerCapabilities and JSONValue describe the same shape and
    // differ only in readonly-vs-mutable array element typing.
    capabilities: manifest.capabilities as RemoteWorkerCapabilities,
  };
}

/**
 * Cancel any pending deferred-requeue for a reconnecting workerId, then guard
 * against a different live socket hijacking that id.
 *
 * A `workerSockets` entry for this ID held by a DIFFERENT live socket means
 * another connection already owns it — but only block when the previous
 * socket never disconnected (no pending-requeue entry existed). Two
 * registrations are intentionally allowed:
 *   - The same socket re-registering (identity match) to refresh its
 *     metadata; `WorkerRegistry.register` is built to refresh an existing id.
 *   - A grace-period reconnect: the old socket's close event already fired
 *     (that is what created the pending-requeue entry, since it was still
 *     the owner at close so the stale-socket guard did not trip), and it
 *     will not fire again. That path is made safe here — the deferred-
 *     requeue timer is cleared, and the caller's `workerSockets.set`
 *     overwrites the stale entry, not the close handler.
 * A different unauthenticated or malicious client claiming an actively-
 * connected workerId (no pending requeue) is rejected here instead.
 *
 * Returns `false` (having already sent `registerError`) when the caller must
 * stop; `true` when registration may proceed.
 */
function admitReconnectingSocket(
  context: ServerContext,
  ws: ServerWebSocket<WebSocketData>,
  message: RegisterMessage,
): boolean {
  const pendingRequeue = context.pendingWorkerRequeues.get(message.workerId);
  const isGracePeriodReconnect = pendingRequeue !== undefined;
  if (isGracePeriodReconnect) {
    clearTimeout(pendingRequeue);
    context.pendingWorkerRequeues.delete(message.workerId);
  }

  const existingSocket = context.workerSockets.get(message.workerId);
  if (!isGracePeriodReconnect && existingSocket !== undefined && existingSocket !== ws) {
    rejectRegistration(
      ws,
      'invalid_registration',
      'workerId is already registered to an active connection',
      message.protocolVersion,
    );
    return false;
  }
  return true;
}

/**
 * Run the operator-supplied admission policy, converting a thrown error into
 * a rejection decision instead of letting it propagate. A throwing policy
 * must not leave the client hanging with no `registerError` and no closed
 * socket — `registerWorker`'s caller only logs an unhandled rejection.
 */
function evaluateWorkerAdmissionPolicy(
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

/**
 * Final synchronous commit: live-socket check, read-only deployment-
 * consistency check, workerId hijack/reconnect guard, then — only once both
 * gates have passed — the deployment-consistency digest record, registry
 * insertion, and `registerAck`. Called only after the manifest digest (the
 * function's one `await`) has settled, so this whole block runs with no
 * further yield point — see the `registerWorker` doc comment for why that
 * atomicity matters for each check here.
 *
 * The consistency record deliberately runs after the hijack guard, not
 * alongside the read-only check: `admitReconnectingSocket` clears a pending
 * grace-period requeue timer as a side effect on its success path, and that
 * side effect must not fire until nothing later can still reject the
 * worker — recording the digest before the hijack guard would let a worker
 * this function ultimately declines permanently poison that deployment/build
 * slot (the guard never evicts), while clearing the requeue timer before a
 * later rejection would orphan a grace-period-reconnecting worker's
 * in-flight tasks.
 */
function commitWorkerRegistration(
  context: ServerContext,
  options: ServeOptions,
  ws: ServerWebSocket<WebSocketData>,
  message: RegisterMessage,
  manifest: WorkerManifest,
  queue: string,
  concurrency: number,
  acceptedManifestDigest: string,
): void {
  if (ws.readyState !== WebSocket.OPEN) return;

  const consistency = context.registry.checkDeploymentConsistency(
    manifest.deployment.name,
    manifest.deployment.buildId,
    manifest.deployment.artifactDigest,
  );
  if (!consistency.ok) {
    rejectRegistration(
      ws,
      'deployment_conflict',
      `Deployment "${manifest.deployment.name}" build "${manifest.deployment.buildId}" is already registered with a different artifact digest`,
      message.protocolVersion,
    );
    return;
  }

  if (!admitReconnectingSocket(context, ws, message)) return;

  context.registry.recordDeploymentConsistency(
    manifest.deployment.name,
    manifest.deployment.buildId,
    manifest.deployment.artifactDigest,
  );

  const registrationInfo = buildWorkerRegistrationInfo(
    message,
    manifest,
    acceptedManifestDigest,
    queue,
    concurrency,
  );

  ws.data.workerId = message.workerId;
  ws.data.workerRegistered = true;
  ws.data.workerProtocolVersion = message.protocolVersion;
  context.registry.register(registrationInfo);
  context.workerSockets.set(message.workerId, ws);
  sendWorkerProtocolMessage(ws, {
    type: 'registerAck',
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    workerId: message.workerId,
    queue,
    concurrency,
    acceptedManifestDigest,
    serverCapabilities: [],
  });
  options.engine.dispatchEvent(
    new WorkerConnectedEvent(message.workerId, queue, registrationInfo.activities, concurrency),
  );
}

/**
 * Validate, admit, and register a worker from its `register` message.
 *
 * Layering, in order: principal scope check, manifest parse
 * (`parseWorkerManifest`), embedded/wire protocol-version agreement,
 * admission policy, manifest digest, then — synchronously, with no further
 * `await` between any of them — a live-socket check, a read-only deployment-
 * consistency check, the workerId hijack/reconnect guard, and only once both
 * of those gates have passed: the deployment-consistency digest record,
 * registry insertion, and `registerAck`.
 *
 * That whole final block must commit atomically with respect to the event
 * loop for three independent reasons: two concurrent registrations for the
 * same not-yet-seen workerId could otherwise both pass the hijack guard
 * before either commits; a peer that closes while the digest above is still
 * pending leaves `ws.data.workerId` unset, so the close handler runs no
 * cleanup, and completing registration afterward would create a ghost worker
 * on a dead socket; and recording the deployment-consistency digest before
 * every rejection gate — including the hijack guard, not just the admission
 * policy — has passed would let a worker this function ultimately declines
 * still permanently poison that deployment/build slot for future legitimate
 * workers, since the guard never evicts. See {@link commitWorkerRegistration}
 * for why the digest record specifically runs after, not alongside, the
 * hijack guard.
 */
export async function registerWorker(
  context: ServerContext,
  options: ServeOptions,
  ws: ServerWebSocket<WebSocketData>,
  message: RegisterMessage,
): Promise<void> {
  if (!principalMayRegisterWorker(ws.data.principal)) {
    rejectRegistration(
      ws,
      'invalid_registration',
      'Worker registration requires the workers:write scope',
      message.protocolVersion,
    );
    return;
  }

  const parsedManifest = parseWorkerManifest(message.manifest);
  if (!parsedManifest.ok) {
    rejectRegistration(ws, 'invalid_registration', parsedManifest.message, message.protocolVersion);
    return;
  }
  const { manifest, canonicalJson } = parsedManifest;

  if (manifest.protocolVersion !== message.protocolVersion) {
    rejectRegistration(
      ws,
      'invalid_registration',
      `Manifest declares protocolVersion ${String(manifest.protocolVersion)}, which does not match the register message's protocolVersion ${String(message.protocolVersion)}`,
      message.protocolVersion,
    );
    return;
  }

  const queue = ws.data.queue ?? 'default';

  if (options.workerAdmissionPolicy !== undefined) {
    const decision = evaluateWorkerAdmissionPolicy(options.workerAdmissionPolicy, {
      principal: ws.data.principal,
      workerId: message.workerId,
      queue,
      manifest,
    });
    if (decision.status === 'rejected') {
      rejectRegistration(ws, 'registration_rejected', decision.reason, message.protocolVersion);
      return;
    }
  }

  const rawConcurrency = message.concurrency ?? DEFAULT_WORKER_CONCURRENCY;
  const clampedConcurrency = Math.min(
    Math.max(1, Math.floor(rawConcurrency)),
    MAX_WORKER_CONCURRENCY,
  );

  const acceptedManifestDigest = await digestCanonicalWorkerManifest(canonicalJson);

  commitWorkerRegistration(
    context,
    options,
    ws,
    message,
    manifest,
    queue,
    clampedConcurrency,
    acceptedManifestDigest,
  );
}
