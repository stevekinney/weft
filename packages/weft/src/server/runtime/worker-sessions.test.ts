import { describe, expect, it } from 'bun:test';

import { manifestForActivities } from '../../worker/registry-fixtures.test-support.ts';
import type { AuthorizationScope } from '../authorization-scope.ts';
import { principalFromApiKey, principalFromMutualTls, type Principal } from '../principal.ts';
import type { PendingTask } from '../task-queue-types.ts';
import { minimalServeOptions, minimalServerContext } from './server-context.test-support.ts';
import { handleWorkerSessionRequest } from './worker-sessions.ts';

const WORKER_SESSION_CREDENTIAL_HEADER = 'Weft-Worker-Session-Token';

function jsonRequest(path: string, body: unknown, headers?: HeadersInit): Request {
  const requestHeaders = new Headers(headers);
  requestHeaders.set('Content-Type', 'application/json');
  return new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
}

function emptyRequest(
  path: string,
  method: string,
  headers?: HeadersInit,
  signal?: AbortSignal,
): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method,
    ...(headers === undefined ? {} : { headers }),
    ...(signal === undefined ? {} : { signal }),
  });
}

function sessionHeaders(sessionToken: string): HeadersInit {
  return { [WORKER_SESSION_CREDENTIAL_HEADER]: sessionToken };
}

type RegisteredSession = Readonly<{
  sessionId: string;
  sessionToken: string;
  principal?: Principal;
}>;

async function registerSession(
  context = minimalServerContext(),
  principal?: Principal,
): Promise<RegisteredSession> {
  const options = minimalServeOptions();
  const request = jsonRequest('/v1/worker-sessions', {
    manifest: manifestForActivities(['checkout.charge']),
  });
  const response = await handleWorkerSessionRequest(
    context,
    options,
    request,
    new URL(request.url),
    principal,
  );
  expect(response?.status).toBe(200);
  const body = (await response?.json()) as { sessionId: string; sessionToken: string };
  expect(body.sessionToken).toMatch(/^[0-9a-f]{64}$/);
  return {
    sessionId: body.sessionId,
    sessionToken: body.sessionToken,
    ...(principal === undefined ? {} : { principal }),
  };
}

function task(operationId: string, activityName = 'checkout.charge'): PendingTask {
  return { operationId, activityName, input: {} };
}

function workerPrincipal(subject: string): Principal {
  return principalFromApiKey({ subject, scopes: ['workers:write'] });
}

function workerPrincipalWithScopes(
  subject: string,
  scopes: ['workers:write', AuthorizationScope],
): Principal {
  return principalFromApiKey({ subject, scopes });
}

async function postWorkerSession(body: unknown): Promise<Response> {
  const context = minimalServerContext();
  const options = minimalServeOptions();
  const request = jsonRequest('/v1/worker-sessions', body);
  const response = await handleWorkerSessionRequest(
    context,
    options,
    request,
    new URL(request.url),
  );
  if (response === null) throw new Error('Expected worker-session handler response');
  return response;
}

describe('worker-session runtime handler', () => {
  it('rejects malformed registration fields before mutating the registry', async () => {
    const manifest = manifestForActivities(['checkout.charge']);

    const invalidCases: Array<[body: unknown, expectedError: string]> = [
      [{ manifest: null }, 'Invalid worker manifest'],
      [{ manifest, queue: '../bad' }, 'queue must be a non-empty URL-safe queue name'],
      [{ manifest, concurrency: 0 }, 'concurrency must be a positive safe integer'],
      [{ manifest, startedAt: -1 }, 'startedAt must be a non-negative number'],
      [{ manifest: { ...manifest, protocolVersion: 7 } }, 'Unsupported worker protocol version'],
    ];

    for (const [body, expectedError] of invalidCases) {
      const response = await postWorkerSession(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expectedError });
    }
  });

  it('rejects a conflicting deployment artifact digest for the same deployment version', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const firstManifest = manifestForActivities(['checkout.charge'], {
      deployment: { name: 'checkout', buildId: 'b1', artifactDigest: 'sha256:first' },
    });
    const secondManifest = manifestForActivities(['checkout.charge'], {
      deployment: { name: 'checkout', buildId: 'b1', artifactDigest: 'sha256:second' },
    });

    const firstRequest = jsonRequest('/v1/worker-sessions', { manifest: firstManifest });
    const firstResponse = await handleWorkerSessionRequest(
      context,
      options,
      firstRequest,
      new URL(firstRequest.url),
    );
    expect(firstResponse?.status).toBe(200);

    const secondRequest = jsonRequest('/v1/worker-sessions', { manifest: secondManifest });
    const secondResponse = await handleWorkerSessionRequest(
      context,
      options,
      secondRequest,
      new URL(secondRequest.url),
    );
    expect(secondResponse?.status).toBe(409);
    expect(await secondResponse?.json()).toMatchObject({
      error: 'Deployment artifact digest conflict',
      code: 'deployment_conflict',
    });
  });

  it('accepts a bare session heartbeat without touching attempt lease state', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const registerBody = await registerSession(context);
    const sessionBefore = context.longPollWorkerSessions.get(registerBody.sessionId);
    if (sessionBefore === undefined) throw new Error('Expected registered worker session');

    const heartbeatRequest = jsonRequest(
      `/v1/worker-sessions/${encodeURIComponent(registerBody.sessionId)}/heartbeat`,
      {},
      sessionHeaders(registerBody.sessionToken),
    );
    const heartbeatResponse = await handleWorkerSessionRequest(
      context,
      options,
      heartbeatRequest,
      new URL(heartbeatRequest.url),
    );
    expect(heartbeatResponse?.status).toBe(200);
    expect(await heartbeatResponse?.json()).toEqual({ ok: true });
    expect(
      context.longPollWorkerSessions.get(registerBody.sessionId)?.lastHeartbeatAt,
    ).toBeGreaterThanOrEqual(sessionBefore.lastHeartbeatAt);
  });

  it('stores a caller-provided startedAt timestamp when registration is accepted', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const startedAt = 123_456;
    const request = jsonRequest('/v1/worker-sessions', {
      manifest: manifestForActivities(['checkout.charge']),
      startedAt,
    });

    const response = await handleWorkerSessionRequest(
      context,
      options,
      request,
      new URL(request.url),
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { sessionId: string };

    expect(context.registry.getWorker(body.sessionId)?.startedAt).toBe(startedAt);
  });

  it('rejects another authenticated worker before it can poll, heartbeat, result, or activity-heartbeat a foreign session', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const workerA = workerPrincipal('worker-a');
    const workerB = workerPrincipal('worker-b');
    const sessionA = await registerSession(context, workerA);
    const sessionB = await registerSession(context, workerB);
    context.registry.assignTask(sessionA.sessionId, 'op-owned', 30_000, undefined, 'attempt-a');
    const beforeHeartbeat = context.registry.getWorker(sessionA.sessionId)?.lastHeartbeat;
    const beforeInFlight = context.registry.getWorker(sessionA.sessionId)?.inFlight;
    const beforeSessionHeartbeat = context.longPollWorkerSessions.get(
      sessionA.sessionId,
    )?.lastHeartbeatAt;

    const pollRequest = emptyRequest(
      `/v1/worker-sessions/${encodeURIComponent(sessionA.sessionId)}/tasks?timeout=0`,
      'GET',
      sessionHeaders(sessionB.sessionToken),
    );
    const pollResponse = await handleWorkerSessionRequest(
      context,
      options,
      pollRequest,
      new URL(pollRequest.url),
      workerB,
    );
    expect(pollResponse?.status).toBe(403);

    const sessionHeartbeatRequest = jsonRequest(
      `/v1/worker-sessions/${encodeURIComponent(sessionA.sessionId)}/heartbeat`,
      {},
      sessionHeaders(sessionB.sessionToken),
    );
    const sessionHeartbeatResponse = await handleWorkerSessionRequest(
      context,
      options,
      sessionHeartbeatRequest,
      new URL(sessionHeartbeatRequest.url),
      workerB,
    );
    expect(sessionHeartbeatResponse?.status).toBe(403);

    const resultRequest = jsonRequest(
      `/v1/worker-sessions/${encodeURIComponent(sessionA.sessionId)}/results`,
      {
        operationId: 'op-owned',
        status: 'completed',
        attemptToken: 'attempt-a',
        workerId: sessionA.sessionId,
      },
      sessionHeaders(sessionB.sessionToken),
    );
    const resultResponse = await handleWorkerSessionRequest(
      context,
      options,
      resultRequest,
      new URL(resultRequest.url),
      workerB,
    );
    expect(resultResponse?.status).toBe(403);

    const activityHeartbeatRequest = jsonRequest(
      `/v1/worker-sessions/${encodeURIComponent(sessionA.sessionId)}/heartbeat`,
      { operationId: 'op-owned', attemptToken: 'attempt-a' },
      sessionHeaders(sessionB.sessionToken),
    );
    const activityHeartbeatResponse = await handleWorkerSessionRequest(
      context,
      options,
      activityHeartbeatRequest,
      new URL(activityHeartbeatRequest.url),
      workerB,
    );
    expect(activityHeartbeatResponse?.status).toBe(403);

    expect(context.registry.getWorker(sessionA.sessionId)?.lastHeartbeat).toBe(beforeHeartbeat);
    expect(context.registry.getWorker(sessionA.sessionId)?.inFlight).toBe(beforeInFlight);
    expect(context.registry.isAssignedToWorker('op-owned', sessionA.sessionId)).toBe(true);
    expect(context.longPollWorkerSessions.get(sessionA.sessionId)?.lastHeartbeatAt).toBe(
      beforeSessionHeartbeat,
    );
  });

  it('rejects a caller with the right session token but the wrong authenticated owner', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const original = workerPrincipalWithScopes('worker-a', ['workers:write', 'workflows:read']);
    const wrongScopes = workerPrincipalWithScopes('worker-a', ['workers:write', 'system:read']);
    const wrongScopeCount = workerPrincipal('worker-a');
    const wrongMethod = principalFromMutualTls({
      subject: 'worker-a',
      scopes: ['workers:write'],
    });
    const session = await registerSession(context, original);
    const beforeHeartbeat = context.registry.getWorker(session.sessionId)?.lastHeartbeat;

    for (const principal of [wrongScopes, wrongScopeCount, wrongMethod]) {
      const request = jsonRequest(
        `/v1/worker-sessions/${encodeURIComponent(session.sessionId)}/heartbeat`,
        {},
        sessionHeaders(session.sessionToken),
      );
      const response = await handleWorkerSessionRequest(
        context,
        options,
        request,
        new URL(request.url),
        principal,
      );
      expect(response?.status).toBe(403);
      expect(await response?.json()).toMatchObject({
        code: 'worker_session_mismatch',
      });
    }

    expect(context.registry.getWorker(session.sessionId)?.lastHeartbeat).toBe(beforeHeartbeat);
  });

  it('accepts the same authenticated owner from a freshly constructed principal', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const session = await registerSession(
      context,
      workerPrincipalWithScopes('worker-a', ['workers:write', 'workflows:read']),
    );
    const sameOwner = workerPrincipalWithScopes('worker-a', ['workers:write', 'workflows:read']);

    const request = jsonRequest(
      `/v1/worker-sessions/${encodeURIComponent(session.sessionId)}/heartbeat`,
      {},
      sessionHeaders(session.sessionToken),
    );
    const response = await handleWorkerSessionRequest(
      context,
      options,
      request,
      new URL(request.url),
      sameOwner,
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: true });
  });

  it('rejects authenticated adoption of an unauthenticated session token', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const session = await registerSession(context);
    const beforeHeartbeat = context.registry.getWorker(session.sessionId)?.lastHeartbeat;

    const request = jsonRequest(
      `/v1/worker-sessions/${encodeURIComponent(session.sessionId)}/heartbeat`,
      {},
      sessionHeaders(session.sessionToken),
    );
    const response = await handleWorkerSessionRequest(
      context,
      options,
      request,
      new URL(request.url),
      workerPrincipal('worker-a'),
    );

    expect(response?.status).toBe(403);
    expect(await response?.json()).toMatchObject({ code: 'worker_session_mismatch' });
    expect(context.registry.getWorker(session.sessionId)?.lastHeartbeat).toBe(beforeHeartbeat);
  });

  it('rejects unknown sessions before any registry mutation', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const session = await registerSession(context);
    const beforeWorker = context.registry.getWorker(session.sessionId);

    const request = emptyRequest(
      '/v1/worker-sessions/missing-session/tasks?timeout=0',
      'GET',
      sessionHeaders(session.sessionToken),
    );
    const response = await handleWorkerSessionRequest(
      context,
      options,
      request,
      new URL(request.url),
    );

    expect(response?.status).toBe(404);
    expect(await response?.json()).toEqual({ error: 'Unknown worker session' });
    expect(context.registry.getWorker(session.sessionId)).toBe(beforeWorker);
    expect(context.registry.getWorker('missing-session')).toBeUndefined();
  });

  it('fails an expired session closed before registry heartbeat or queue polling can revive it', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const session = await registerSession(context);
    const current = context.longPollWorkerSessions.get(session.sessionId);
    if (current === undefined) throw new Error('Expected registered worker session');
    context.longPollWorkerSessions.set(session.sessionId, {
      ...current,
      lastHeartbeatAt: Date.now() - 60_001,
    });

    const pollRequest = emptyRequest(
      `/v1/worker-sessions/${encodeURIComponent(session.sessionId)}/tasks?timeout=0`,
      'GET',
      sessionHeaders(session.sessionToken),
    );
    const response = await handleWorkerSessionRequest(
      context,
      options,
      pollRequest,
      new URL(pollRequest.url),
    );

    expect(response?.status).toBe(410);
    expect(await response?.json()).toMatchObject({ code: 'session_expired' });
    expect(context.longPollWorkerSessions.has(session.sessionId)).toBe(false);
    expect(context.registry.getWorker(session.sessionId)).toBeUndefined();
  });

  it('rejects a stale session generation before mutating the superseding registry entry', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const session = await registerSession(context);
    const manifest = manifestForActivities(['checkout.charge']);
    context.registry.register({
      id: session.sessionId,
      transport: 'long-poll',
      queue: 'default',
      activities: ['checkout.charge'],
      concurrency: 1,
      manifest,
      acceptedManifestDigest: 'sha256:superseding',
    });
    const supersedingHeartbeat = context.registry.getWorker(session.sessionId)?.lastHeartbeat;

    const heartbeatRequest = jsonRequest(
      `/v1/worker-sessions/${encodeURIComponent(session.sessionId)}/heartbeat`,
      {},
      sessionHeaders(session.sessionToken),
    );
    const response = await handleWorkerSessionRequest(
      context,
      options,
      heartbeatRequest,
      new URL(heartbeatRequest.url),
    );

    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({ code: 'stale_session' });
    expect(context.registry.getWorker(session.sessionId)?.acceptedManifestDigest).toBe(
      'sha256:superseding',
    );
    expect(context.registry.getWorker(session.sessionId)?.lastHeartbeat).toBe(supersedingHeartbeat);
  });

  it('keeps draining sessions registered for heartbeats and results while refusing new poll leases', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const session = await registerSession(context);
    context.taskQueue.enqueue('default', task('op-drain'));
    context.registry.markWorkerDraining(session.sessionId, { updatedAt: Date.now() });

    const pollRequest = emptyRequest(
      `/v1/worker-sessions/${encodeURIComponent(session.sessionId)}/tasks?timeout=0`,
      'GET',
      sessionHeaders(session.sessionToken),
    );
    const pollResponse = await handleWorkerSessionRequest(
      context,
      options,
      pollRequest,
      new URL(pollRequest.url),
    );
    expect(pollResponse?.status).toBe(409);
    expect(await pollResponse?.json()).toMatchObject({ code: 'session_draining' });

    const retained = await context.taskQueue.poll('default', ['checkout.charge'], 0);
    expect(retained?.operationId).toBe('op-drain');

    const heartbeatRequest = jsonRequest(
      `/v1/worker-sessions/${encodeURIComponent(session.sessionId)}/heartbeat`,
      {},
      sessionHeaders(session.sessionToken),
    );
    const heartbeatResponse = await handleWorkerSessionRequest(
      context,
      options,
      heartbeatRequest,
      new URL(heartbeatRequest.url),
    );
    expect(heartbeatResponse?.status).toBe(200);

    const resultRequest = jsonRequest(
      `/v1/worker-sessions/${encodeURIComponent(session.sessionId)}/results`,
      { operationId: 'missing', status: 'completed', attemptToken: 'attempt-missing' },
      sessionHeaders(session.sessionToken),
    );
    const resultResponse = await handleWorkerSessionRequest(
      context,
      options,
      resultRequest,
      new URL(resultRequest.url),
    );
    expect(resultResponse?.status).not.toBe(409);
    expect(context.registry.getWorker(session.sessionId)).toBeDefined();
  });

  it('retains tasks when a parked poll request aborts before any task arrives', async () => {
    const context = minimalServerContext();
    const options = minimalServeOptions();
    const session = await registerSession(context);
    const controller = new AbortController();
    const pollRequest = emptyRequest(
      `/v1/worker-sessions/${encodeURIComponent(session.sessionId)}/tasks?timeout=60000`,
      'GET',
      sessionHeaders(session.sessionToken),
      controller.signal,
    );
    const pollPromise = handleWorkerSessionRequest(
      context,
      options,
      pollRequest,
      new URL(pollRequest.url),
    );

    controller.abort();
    const pollResponse = await pollPromise;
    expect(pollResponse?.status).toBe(204);
    context.taskQueue.enqueue('default', task('op-after-abort'));

    const retained = await context.taskQueue.poll('default', ['checkout.charge'], 0);
    expect(retained?.operationId).toBe('op-after-abort');
  });
});
