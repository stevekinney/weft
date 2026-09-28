import { isAuthenticated, type Principal } from '../principal.ts';
import type { LongPollWorkerSession, ServerContext } from './context.ts';
import { authorizeWorkerPrincipal } from './task-polling.ts';

export const WORKER_SESSION_CREDENTIAL_HEADER = 'Weft-Worker-Session-Token';

const WORKER_SESSION_LEASE_TIMEOUT_MS = 60_000;

export type WorkerSessionAccess =
  { ok: true; session: LongPollWorkerSession } | { ok: false; response: Response };

export type WorkerSessionAccessOptions = Readonly<{
  allowDraining: boolean;
}>;

export function generateWorkerSessionCredential(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function authorizeWorkerSessionAccess(
  context: ServerContext,
  request: Request,
  principal: Principal | undefined,
  sessionId: string,
  options: WorkerSessionAccessOptions,
): WorkerSessionAccess {
  const session = context.longPollWorkerSessions.get(sessionId);
  if (session === undefined) return rejectUnknownWorkerSession();

  const authorizationResponse = authorizeWorkerPrincipal(principal);
  if (authorizationResponse !== null) return { ok: false, response: authorizationResponse };

  const credentialResponse = authorizeWorkerSessionCredential(request, session, principal);
  if (credentialResponse !== null) return { ok: false, response: credentialResponse };

  const stateResponse = authorizeActiveWorkerSessionState(context, sessionId, session, options);
  if (stateResponse !== null) return { ok: false, response: stateResponse };

  return { ok: true, session };
}

function authorizeWorkerSessionCredential(
  request: Request,
  session: LongPollWorkerSession,
  principal: Principal | undefined,
): Response | null {
  const presentedCredential = request.headers.get(WORKER_SESSION_CREDENTIAL_HEADER);
  if (
    presentedCredential === null ||
    presentedCredential !== session.credential ||
    !isSameWorkerSessionOwner(session.principal, principal)
  ) {
    return Response.json({ error: 'Forbidden', code: 'worker_session_mismatch' }, { status: 403 });
  }
  return null;
}

function authorizeActiveWorkerSessionState(
  context: ServerContext,
  sessionId: string,
  session: LongPollWorkerSession,
  options: WorkerSessionAccessOptions,
): Response | null {
  const identity = context.registry.sessionIdentity(sessionId);
  if (
    identity === undefined ||
    identity.transport !== 'long-poll' ||
    identity.sessionGeneration !== session.sessionGeneration
  ) {
    return Response.json({ error: 'Stale worker session', code: 'stale_session' }, { status: 409 });
  }

  if (Date.now() - session.lastHeartbeatAt > WORKER_SESSION_LEASE_TIMEOUT_MS) {
    return rejectExpiredWorkerSession(context, sessionId);
  }

  if (!options.allowDraining && workerIsDraining(context, sessionId)) {
    return Response.json(
      { error: 'Worker session is draining', code: 'session_draining' },
      { status: 409 },
    );
  }

  return null;
}

function rejectUnknownWorkerSession(): WorkerSessionAccess {
  return {
    ok: false,
    response: Response.json({ error: 'Unknown worker session' }, { status: 404 }),
  };
}

function rejectExpiredWorkerSession(context: ServerContext, sessionId: string): Response {
  context.longPollWorkerSessions.delete(sessionId);
  context.registry.unregister(sessionId);
  return Response.json(
    { error: 'Worker session lease expired', code: 'session_expired' },
    { status: 410 },
  );
}

function workerIsDraining(context: ServerContext, sessionId: string): boolean {
  const worker = context.registry.getWorker(sessionId);
  if (worker === undefined) return false;
  return worker.drainStartedAt !== undefined;
}

function isSameWorkerSessionOwner(
  left: Principal | undefined,
  right: Principal | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return left === right;
  if (left.method !== right.method) return false;
  if (!isAuthenticated(left) || !isAuthenticated(right)) return left.method === right.method;
  if (left.subject === undefined || right.subject === undefined) return false;
  return left.subject === right.subject && haveSameScopes(left.scopes, right.scopes);
}

function haveSameScopes(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const scope of left) {
    if (!right.has(scope)) return false;
  }
  return true;
}
