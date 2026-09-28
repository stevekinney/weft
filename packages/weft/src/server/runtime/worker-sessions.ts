import {
  digestCanonicalWorkerManifest,
  parseWorkerManifest,
  type WorkerManifest,
} from '../../worker/manifest/index.ts';
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  type RemoteWorkerCapabilities,
} from '../../worker/protocol.ts';
import type { ServeOptions } from '../index.ts';
import type { Principal } from '../principal.ts';
import type { PendingTask } from '../task-queue-types.ts';
import type { ServerContext } from './context.ts';
import type { LongPollClaim } from './task-polling.ts';
import {
  authorizeWorkerPrincipal,
  awaitTaskLedgerRecovery,
  DEFAULT_POLL_TIMEOUT,
  handleTaskHeartbeatRequest,
  handleTaskResultRequest,
  markTaskClaimedByLongPollWorker,
  MAX_POLL_TIMEOUT,
  parseTaskResultBody,
} from './task-polling.ts';
import {
  authorizeWorkerSessionAccess,
  generateWorkerSessionCredential,
} from './worker-session-access.ts';

const WORKER_SESSIONS_PATH = '/v1/worker-sessions';
const WORKER_SESSION_TASKS_RE = /^\/v1\/worker-sessions\/([^/]+)\/tasks$/;
const WORKER_SESSION_RESULTS_RE = /^\/v1\/worker-sessions\/([^/]+)\/results$/;
const WORKER_SESSION_HEARTBEAT_RE = /^\/v1\/worker-sessions\/([^/]+)\/heartbeat$/;
const WORKER_SESSION_RE = /^\/v1\/worker-sessions\/([^/]+)$/;

type ValidatedWorkerSessionRegistration = {
  manifest: WorkerManifest;
  canonicalJson: string;
  queue: string;
  concurrency: number;
  startedAt: number | undefined;
};

function deriveActivitiesFromManifest(manifest: WorkerManifest): string[] {
  const activities: string[] = [];
  for (const [workflowType, workflow] of Object.entries(manifest.workflows)) {
    for (const activityName of Object.keys(workflow.activities)) {
      activities.push(`${workflowType}.${activityName}`);
    }
  }
  return activities.toSorted();
}

function runtimeVersionFromManifest(manifest: WorkerManifest): string | undefined {
  return manifest.runtime.version === '' ? undefined : manifest.runtime.version;
}

function validatePositiveInteger(
  value: unknown,
  fallback: number,
  field: string,
): number | Response {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return Response.json({ error: `${field} must be a positive safe integer` }, { status: 400 });
  }
  return value;
}

function validateOptionalStartedAt(value: unknown): number | undefined | Response {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return Response.json({ error: 'startedAt must be a non-negative number' }, { status: 400 });
  }
  return value;
}

function validateQueue(value: unknown): string | Response {
  if (value === undefined) return 'default';
  if (typeof value !== 'string' || !/^[\w-]+$/.test(value)) {
    return Response.json(
      { error: 'queue must be a non-empty URL-safe queue name' },
      { status: 400 },
    );
  }
  return value;
}

function validateWorkerSessionRegistrationBody(
  body: Record<string, unknown>,
): ValidatedWorkerSessionRegistration | Response {
  const parsedManifest = parseWorkerManifest(body['manifest']);
  if (!parsedManifest.ok) {
    return Response.json(
      {
        error: 'Invalid worker manifest',
        reason: parsedManifest.reason,
        path: parsedManifest.path,
      },
      { status: 400 },
    );
  }
  const queue = validateQueue(body['queue']);
  if (queue instanceof Response) return queue;
  const concurrency = validatePositiveInteger(body['concurrency'], 10, 'concurrency');
  if (concurrency instanceof Response) return concurrency;
  const startedAt = validateOptionalStartedAt(body['startedAt']);
  if (startedAt instanceof Response) return startedAt;
  return {
    manifest: parsedManifest.manifest,
    canonicalJson: parsedManifest.canonicalJson,
    queue,
    concurrency,
    startedAt,
  };
}

export async function handleWorkerSessionRequest(
  context: ServerContext,
  options: ServeOptions,
  request: Request,
  url: URL,
  principal?: Principal,
): Promise<Response | null> {
  if (url.pathname === WORKER_SESSIONS_PATH && request.method === 'POST') {
    return registerWorkerSession(context, options, request, principal);
  }

  const taskResponse = await handleWorkerSessionTaskRequest(
    context,
    options,
    request,
    url,
    principal,
  );
  if (taskResponse !== null) return taskResponse;

  const resultResponse = await handleWorkerSessionResultRequest(
    context,
    options,
    request,
    url,
    principal,
  );
  if (resultResponse !== null) return resultResponse;

  const heartbeatResponse = await handleWorkerSessionHeartbeatRequest(
    context,
    options,
    request,
    url,
    principal,
  );
  if (heartbeatResponse !== null) return heartbeatResponse;

  return handleWorkerSessionUnregisterRequest(context, request, url, principal);
}

async function registerWorkerSession(
  context: ServerContext,
  options: ServeOptions,
  request: Request,
  principal?: Principal,
): Promise<Response> {
  const authorizationResponse = authorizeWorkerPrincipal(principal);
  if (authorizationResponse !== null) return authorizationResponse;
  const recoveryResponse = await awaitTaskLedgerRecovery(context);
  if (recoveryResponse !== null) return recoveryResponse;
  const body = await parseTaskResultBody(
    request,
    options.maxRequestBodyBytes !== undefined ? { maxBodyBytes: options.maxRequestBodyBytes } : {},
  );
  if (body instanceof Response) return body;
  if (body === null) return Response.json({ error: 'Invalid JSON body' }, { status: 400 });

  const registration = validateWorkerSessionRegistrationBody(body);
  if (registration instanceof Response) return registration;
  if (registration.manifest.protocolVersion !== REMOTE_WORKER_PROTOCOL_VERSION) {
    return Response.json({ error: 'Unsupported worker protocol version' }, { status: 400 });
  }
  const consistency = context.registry.checkDeploymentConsistency(
    registration.manifest.deployment.name,
    registration.manifest.deployment.buildId,
    registration.manifest.deployment.artifactDigest,
  );
  if (!consistency.ok) {
    return Response.json(
      { error: 'Deployment artifact digest conflict', code: 'deployment_conflict' },
      { status: 409 },
    );
  }
  return acceptWorkerSession(context, registration, principal);
}

async function acceptWorkerSession(
  context: ServerContext,
  registration: ValidatedWorkerSessionRegistration,
  principal: Principal | undefined,
): Promise<Response> {
  const sessionId = crypto.randomUUID();
  const credential = generateWorkerSessionCredential();
  const acceptedManifestDigest = await digestCanonicalWorkerManifest(registration.canonicalJson);
  const activities = deriveActivitiesFromManifest(registration.manifest);
  context.registry.recordDeploymentConsistency(
    registration.manifest.deployment.name,
    registration.manifest.deployment.buildId,
    registration.manifest.deployment.artifactDigest,
  );
  const runtimeVersion = runtimeVersionFromManifest(registration.manifest);
  context.registry.register({
    id: sessionId,
    transport: 'long-poll',
    queue: registration.queue,
    activities,
    concurrency: registration.concurrency,
    deploymentName: registration.manifest.deployment.name,
    buildId: registration.manifest.deployment.buildId,
    ...(runtimeVersion !== undefined ? { runtimeVersion } : {}),
    manifest: registration.manifest,
    acceptedManifestDigest,
    ...(registration.startedAt !== undefined ? { startedAt: registration.startedAt } : {}),
    capabilities: registration.manifest.capabilities as RemoteWorkerCapabilities,
  });
  const sessionGeneration = context.registry.sessionIdentity(sessionId)?.sessionGeneration ?? 1;
  const now = Date.now();
  context.longPollWorkerSessions.set(sessionId, {
    sessionId,
    credential,
    principal,
    queue: registration.queue,
    activities,
    concurrency: registration.concurrency,
    manifest: registration.manifest,
    acceptedManifestDigest,
    sessionGeneration,
    createdAt: now,
    lastHeartbeatAt: now,
  });
  return Response.json({
    ok: true,
    sessionId,
    workerId: sessionId,
    queue: registration.queue,
    sessionToken: credential,
    acceptedManifestDigest,
    protocolVersion: registration.manifest.protocolVersion,
    sessionGeneration,
  });
}

async function handleWorkerSessionTaskRequest(
  context: ServerContext,
  options: ServeOptions,
  request: Request,
  url: URL,
  principal?: Principal,
): Promise<Response | null> {
  const taskMatch = WORKER_SESSION_TASKS_RE.exec(url.pathname);
  if (taskMatch?.[1] === undefined || request.method !== 'GET') return null;
  const sessionId = decodeURIComponent(taskMatch[1]);
  if (request.signal.aborted) return new Response(null, { status: 204 });
  const access = authorizeWorkerSessionAccess(context, request, principal, sessionId, {
    allowDraining: false,
  });
  if (!access.ok) return access.response;
  const { session } = access;
  context.registry.heartbeat(sessionId);
  context.longPollWorkerSessions.set(sessionId, { ...session, lastHeartbeatAt: Date.now() });
  const timeout = pollTimeoutFromUrl(url);
  const task = await context.taskQueue.poll(
    session.queue,
    [...session.activities],
    timeout,
    request.signal,
  );
  if (task === null) return new Response(null, { status: 204 });
  const claim = await markTaskClaimedByLongPollWorker(context, options, task, sessionId);
  if (claim === null) return new Response(null, { status: 204 });
  return Response.json(workerSessionTaskResponse(task, claim));
}

function pollTimeoutFromUrl(url: URL): number {
  const rawTimeout = url.searchParams.get('timeout');
  return rawTimeout === null
    ? DEFAULT_POLL_TIMEOUT
    : Math.min(Math.max(0, Number(rawTimeout)), MAX_POLL_TIMEOUT);
}

function workerSessionTaskResponse(
  task: PendingTask,
  claim: LongPollClaim,
): Record<string, unknown> {
  return {
    ...task,
    workerId: claim.workerId,
    attemptToken: claim.attemptToken,
    ...(claim.lastHeartbeatDetails !== undefined
      ? { lastHeartbeatDetails: claim.lastHeartbeatDetails }
      : {}),
    ...(task.workflowExecutionToken !== undefined
      ? { workflowExecutionToken: task.workflowExecutionToken }
      : {}),
    ...(task.workflowRevision !== undefined ? { workflowRevision: task.workflowRevision } : {}),
  };
}

async function handleWorkerSessionResultRequest(
  context: ServerContext,
  options: ServeOptions,
  request: Request,
  url: URL,
  principal?: Principal,
): Promise<Response | null> {
  const resultMatch = WORKER_SESSION_RESULTS_RE.exec(url.pathname);
  if (resultMatch?.[1] === undefined || request.method !== 'POST') return null;
  const access = authorizeWorkerSessionAccess(
    context,
    request,
    principal,
    decodeURIComponent(resultMatch[1]),
    { allowDraining: true },
  );
  if (!access.ok) return access.response;
  const { session } = access;
  const sessionUrl = new URL(request.url);
  sessionUrl.pathname = `/v1/tasks/${encodeURIComponent(session.queue)}/result`;
  return handleTaskResultRequest(
    context,
    options,
    new Request(sessionUrl, request),
    sessionUrl,
    principal,
  );
}

async function handleWorkerSessionHeartbeatRequest(
  context: ServerContext,
  options: ServeOptions,
  request: Request,
  url: URL,
  principal?: Principal,
): Promise<Response | null> {
  const heartbeatMatch = WORKER_SESSION_HEARTBEAT_RE.exec(url.pathname);
  if (heartbeatMatch?.[1] === undefined || request.method !== 'POST') return null;
  const sessionId = decodeURIComponent(heartbeatMatch[1]);
  const access = authorizeWorkerSessionAccess(context, request, principal, sessionId, {
    allowDraining: true,
  });
  if (!access.ok) return access.response;
  const { session } = access;
  context.registry.heartbeat(sessionId);
  const body = await parseTaskResultBody(request);
  if (body instanceof Response) return body;
  if (body === null) return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  if (body['operationId'] === undefined && body['attemptToken'] === undefined) {
    context.longPollWorkerSessions.set(sessionId, { ...session, lastHeartbeatAt: Date.now() });
    return Response.json({ ok: true });
  }
  const sessionUrl = new URL(request.url);
  sessionUrl.pathname = `/v1/tasks/${encodeURIComponent(session.queue)}/heartbeat`;
  return handleTaskHeartbeatRequest(
    context,
    options,
    new Request(sessionUrl, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify({ ...body, workerId: sessionId }),
      signal: request.signal,
    }),
    sessionUrl,
    principal,
  );
}

function handleWorkerSessionUnregisterRequest(
  context: ServerContext,
  request: Request,
  url: URL,
  principal?: Principal,
): Response | null {
  const unregisterMatch = WORKER_SESSION_RE.exec(url.pathname);
  if (unregisterMatch?.[1] === undefined || request.method !== 'DELETE') return null;
  const sessionId = decodeURIComponent(unregisterMatch[1]);
  const access = authorizeWorkerSessionAccess(context, request, principal, sessionId, {
    allowDraining: true,
  });
  if (!access.ok) return access.response;
  context.longPollWorkerSessions.delete(sessionId);
  context.registry.unregister(sessionId);
  return Response.json({ ok: true });
}
