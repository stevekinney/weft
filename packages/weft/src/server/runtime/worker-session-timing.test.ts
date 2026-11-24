import { describe, expect, it, spyOn } from 'bun:test';

import { waitForCondition } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { manifestForActivities } from '../../worker/registry-fixtures.test-support.ts';
import { createServerWebSocketHandlers } from './authentication-bridge.ts';
import { minimalServeOptions, minimalServerContext } from './server-context.test-support.ts';
import { endWorkerReconnectGracePeriods } from './worker-disconnect-requeue.ts';
import { WORKER_SESSION_LEASE_TIMEOUT_MS } from './worker-session-access.ts';
import { createWorkerSessionTiming } from './worker-session-timing.ts';
import { handleWorkerSessionRequest } from './worker-sessions.ts';

const SESSION_TOKEN_HEADER = 'Weft-Worker-Session-Token';

function workerSocket(workerId: string) {
  return {
    data: {
      connectionType: 'worker',
      pathname: '/v1/tasks/default/stream',
      queue: 'default',
      workerId,
    },
  };
}

async function registerLongPollSession(context: ReturnType<typeof minimalServerContext>) {
  const request = new Request('http://127.0.0.1/v1/worker-sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest: manifestForActivities(['checkout.charge']) }),
  });
  const response = await handleWorkerSessionRequest(
    context,
    minimalServeOptions(),
    request,
    new URL(request.url),
  );
  const body = (await response?.json()) as { sessionId: string; sessionToken: string };
  return body;
}

describe('worker session timing — long-poll session lease', () => {
  it('reports the lease as the last poll or heartbeat plus the enforced timeout, and renews it', async () => {
    const context = minimalServerContext();
    const timing = createWorkerSessionTiming(context);
    const { sessionId, sessionToken } = await registerLongPollSession(context);

    const registered = context.longPollWorkerSessions.get(sessionId);
    if (registered === undefined) throw new Error('Expected a registered session');
    expect(timing(sessionId)).toEqual({
      reconnectGraceEndsAt: undefined,
      sessionLeaseExpiresAt: registered.lastHeartbeatAt + WORKER_SESSION_LEASE_TIMEOUT_MS,
    });

    // A heartbeat renews the lease; the reported instant follows the session's own clock.
    context.longPollWorkerSessions.set(sessionId, { ...registered, lastHeartbeatAt: 5_000 });
    const request = new Request(`http://127.0.0.1/v1/worker-sessions/${sessionId}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [SESSION_TOKEN_HEADER]: sessionToken },
      body: '{}',
    });
    using now = spyOn(Date, 'now').mockReturnValue(9_000);
    await handleWorkerSessionRequest(context, minimalServeOptions(), request, new URL(request.url));
    expect(now).toHaveBeenCalled();
    expect(timing(sessionId).sessionLeaseExpiresAt).toBe(9_000 + WORKER_SESSION_LEASE_TIMEOUT_MS);
  });

  it('reports nothing once the session is unregistered or for a worker that was never one', async () => {
    const context = minimalServerContext();
    const timing = createWorkerSessionTiming(context);
    const { sessionId, sessionToken } = await registerLongPollSession(context);

    const request = new Request(`http://127.0.0.1/v1/worker-sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { [SESSION_TOKEN_HEADER]: sessionToken },
    });
    await handleWorkerSessionRequest(context, minimalServeOptions(), request, new URL(request.url));

    expect(timing(sessionId)).toEqual({
      reconnectGraceEndsAt: undefined,
      sessionLeaseExpiresAt: undefined,
    });
    expect(timing('never-registered').sessionLeaseExpiresAt).toBeUndefined();
  });
});

describe('worker session timing — WebSocket reconnect grace', () => {
  function disconnectedContext(graceMs: number) {
    const context = { ...minimalServerContext(), workerReconnectGracePeriodMs: graceMs };
    const socket = workerSocket('worker-1');
    context.workerSockets.set('worker-1', socket as never);
    const handlers = createServerWebSocketHandlers(context, minimalServeOptions(), () => {});
    return { context, handlers, socket };
  }

  it('is set to when the grace window closes while the socket is gone, and absent before', () => {
    const { context, handlers, socket } = disconnectedContext(2_000);
    const timing = createWorkerSessionTiming(context);
    expect(timing('worker-1').reconnectGraceEndsAt).toBeUndefined();

    using now = spyOn(Date, 'now').mockReturnValue(1_000_000);
    handlers.close(socket as never);

    expect(now).toHaveBeenCalled();
    expect(timing('worker-1')).toEqual({
      reconnectGraceEndsAt: 1_002_000,
      sessionLeaseExpiresAt: undefined,
    });
    endWorkerReconnectGracePeriods({ ...context, stopping: true }, minimalServeOptions(), () => {});
  });

  it('is cleared when the grace window ends and the deferred requeue runs', async () => {
    const { context, handlers, socket } = disconnectedContext(5);
    const timing = createWorkerSessionTiming(context);

    handlers.close(socket as never);
    expect(timing('worker-1').reconnectGraceEndsAt).toBeTypeOf('number');

    await waitForCondition(() => timing('worker-1').reconnectGraceEndsAt === undefined, {
      label: 'the grace window to end',
    });
    expect(context.pendingWorkerRequeues.size).toBe(0);
  });

  it('is cleared when the server stops and ends every pending window', () => {
    const { context, handlers, socket } = disconnectedContext(60_000);
    const timing = createWorkerSessionTiming(context);
    handlers.close(socket as never);
    expect(timing('worker-1').reconnectGraceEndsAt).toBeTypeOf('number');

    endWorkerReconnectGracePeriods({ ...context, stopping: true }, minimalServeOptions(), () => {});
    expect(timing('worker-1').reconnectGraceEndsAt).toBeUndefined();
  });
});
