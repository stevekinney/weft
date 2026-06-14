import type { Engine } from '../core/engine.ts';
import { WeftError } from '../core/weft-error.ts';
import { anonymousPrincipal, isAuthenticated, type Principal } from '../server/principal.ts';
import { dispatchMcpMessage } from './dispatcher.ts';
import {
  accepts,
  DEFAULT_MCP_MAX_BODY_BYTES,
  isJsonContentType,
  isMcpRequest,
  isNotification,
  MCP_PROTOCOL_VERSION,
  parseMcpMessage,
  type McpResponse,
} from './protocol.ts';
import { McpSessionLimitExceededError, McpSessionManager, type McpSession } from './session.ts';

/**
 * Options for handling one Streamable HTTP MCP request.
 *
 * @example
 * ```ts
 * import { createMcpSessionManager, type McpHttpRequestOptions } from '@lostgradient/weft/mcp';
 * import { Engine, MemoryStorage } from '@lostgradient/weft';
 *
 * await using storage = new MemoryStorage();
 * await using engine = new Engine({ storage });
 * await using sessionManager = createMcpSessionManager(engine);
 *
 * const request = new Request('http://localhost/mcp', { method: 'GET' });
 * const options: McpHttpRequestOptions = {
 *   request,
 *   engine,
 *   sessionManager,
 *   authRequired: false,
 * };
 * void options;
 * ```
 */
export type McpHttpRequestOptions = {
  readonly request: Request;
  readonly engine: Engine;
  readonly sessionManager: McpSessionManager;
  readonly principal?: Principal;
  readonly authRequired: boolean;
  readonly maxBodyBytes?: number;
  readonly publicOrigin?: string;
  readonly trustedHosts?: ReadonlyArray<string>;
};

class McpBodyTooLargeError extends WeftError<'McpBodyTooLargeError'> {
  constructor() {
    super('McpBodyTooLargeError', 'body too large');
  }
}

/**
 * Handle one MCP Streamable HTTP request.
 *
 * Most applications should use `serve({ engine })`, which mounts `/mcp`
 * automatically. Use this helper when embedding the MCP transport in a custom
 * Bun server.
 *
 * @example
 * ```ts
 * import { createMcpSessionManager, handleMcpHttpRequest } from '@lostgradient/weft/mcp';
 * import { Engine, MemoryStorage } from '@lostgradient/weft';
 *
 * await using storage = new MemoryStorage();
 * await using engine = new Engine({ storage });
 * await using sessionManager = createMcpSessionManager(engine);
 *
 * Bun.serve({
 *   fetch(request) {
 *     return handleMcpHttpRequest({
 *       request,
 *       engine,
 *       sessionManager,
 *       authRequired: false,
 *     });
 *   },
 * });
 * ```
 */
export async function handleMcpHttpRequest(options: McpHttpRequestOptions): Promise<Response> {
  const originFailure = validateOrigin(options.request, options.publicOrigin, options.trustedHosts);
  if (originFailure !== null) return originFailure;

  switch (options.request.method) {
    case 'POST':
      return handleMcpPost(options);
    case 'GET':
      return handleMcpGet(options);
    case 'DELETE':
      return handleMcpDelete(options);
    default:
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { allow: 'POST, GET, DELETE' },
      });
  }
}

async function handleMcpPost(options: McpHttpRequestOptions): Promise<Response> {
  const headerFailure = validatePostHeaders(options.request);
  if (headerFailure !== null) return headerFailure;

  const parsed = await readMcpJsonBody(options);
  if (parsed instanceof Response) return parsed;
  if (!parsed.ok) {
    return Response.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      },
      { status: 200, headers: noStoreHeaders() },
    );
  }

  const sessionResolution = resolvePostSession(options, parsed.value);
  if (sessionResolution instanceof Response) return sessionResolution;
  const { session, createdSession, principal } = sessionResolution;

  const result = await dispatchMcpMessage(parsed.value, {
    engine: options.engine,
    session,
    principal,
    authRequired: authRequiredFromOptions(options),
  });

  if (result.kind === 'accepted') {
    return new Response(null, {
      status: 202,
      headers: maybeSessionHeaders(session, createdSession),
    });
  }

  return Response.json(result.response, {
    status: 200,
    headers: maybeSessionHeaders(session, createdSession),
  });
}

function validatePostHeaders(request: Request): Response | null {
  if (!accepts(request.headers.get('accept'), 'application/json')) {
    return new Response('Not Acceptable', { status: 406 });
  }
  if (!isJsonContentType(request.headers.get('content-type') ?? '')) {
    return new Response('Unsupported Media Type', { status: 415 });
  }
  return null;
}

async function readMcpJsonBody(
  options: McpHttpRequestOptions,
): Promise<ReturnType<typeof parseMcpMessage> | Response> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MCP_MAX_BODY_BYTES;
  try {
    const bytes = await readBodyBounded(options.request, maxBodyBytes);
    return parseMcpMessage(new TextDecoder().decode(bytes));
  } catch (error) {
    return new Response(
      error instanceof McpBodyTooLargeError ? 'Payload Too Large' : 'Bad Request',
      {
        status: error instanceof McpBodyTooLargeError ? 413 : 400,
      },
    );
  }
}

function resolvePostSession(
  options: McpHttpRequestOptions,
  message: unknown,
):
  | {
      readonly session: McpSession;
      readonly createdSession: boolean;
      readonly principal: Principal;
    }
  | Response {
  const sessionHeader = sessionIdFromHeaders(options.request.headers);
  const versionFailure = validateProtocolVersion(options.request.headers);
  if (versionFailure !== null) return versionFailure;

  if (shouldCreateSessionForPost(message, sessionHeader)) {
    const principal = principalFromOptions(options);
    try {
      return {
        session: options.sessionManager.create(principal),
        createdSession: true,
        principal,
      };
    } catch (error) {
      if (error instanceof McpSessionLimitExceededError) {
        return new Response(error.message, { status: 429, headers: noStoreHeaders() });
      }
      throw error;
    }
  }

  if (sessionHeader === null) return new Response('Missing Mcp-Session-Id', { status: 400 });
  const session = options.sessionManager.get(sessionHeader);
  if (session === undefined) return new Response('MCP session not found', { status: 404 });
  const principal = principalFromOptions(options);
  if (
    !isAuthorizedForSession(session, principal, sessionTokenFromHeaders(options.request.headers))
  ) {
    return new Response('Forbidden', { status: 403, headers: noStoreHeaders() });
  }
  options.sessionManager.touch(session);
  return { session, createdSession: false, principal };
}

function shouldCreateSessionForPost(message: unknown, sessionHeader: string | null): boolean {
  if (sessionHeader !== null) return false;
  if (!isMcpRequest(message)) return false;
  return message.method === 'initialize' && !isNotification(message);
}

function handleMcpGet(options: McpHttpRequestOptions): Response {
  if (!accepts(options.request.headers.get('accept'), 'text/event-stream')) {
    return new Response('Not Acceptable', { status: 406 });
  }
  const versionFailure = validateProtocolVersion(options.request.headers);
  if (versionFailure !== null) return versionFailure;
  const sessionId = sessionIdFromHeaders(options.request.headers);
  if (sessionId === null) return new Response('Missing Mcp-Session-Id', { status: 400 });
  const session = options.sessionManager.get(sessionId);
  if (session === undefined) return new Response('MCP session not found', { status: 404 });
  const principal = principalFromOptions(options);
  if (
    !isAuthorizedForSession(session, principal, sessionTokenFromHeaders(options.request.headers))
  ) {
    return new Response('Forbidden', { status: 403, headers: noStoreHeaders() });
  }
  options.sessionManager.touch(session);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const write = (message: McpResponse | Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
      };
      controller.enqueue(encoder.encode(': connected\n\n'));
      const remove = session.addTarget(write);
      options.request.signal.addEventListener(
        'abort',
        () => {
          remove();
          try {
            controller.close();
          } catch {
            // The client may already have closed the stream.
          }
        },
        { once: true },
      );
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...noStoreHeaders(),
      'content-type': 'text/event-stream',
      'Mcp-Session-Id': session.id,
    },
  });
}

function handleMcpDelete(options: McpHttpRequestOptions): Response {
  const sessionId = sessionIdFromHeaders(options.request.headers);
  if (sessionId === null) return new Response('Missing Mcp-Session-Id', { status: 400 });
  const session = options.sessionManager.get(sessionId);
  if (session === undefined) return new Response('MCP session not found', { status: 404 });
  if (
    !isAuthorizedForSession(
      session,
      principalFromOptions(options),
      sessionTokenFromHeaders(options.request.headers),
    )
  ) {
    return new Response('Forbidden', { status: 403, headers: noStoreHeaders() });
  }
  options.sessionManager.delete(sessionId);
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}

function sessionIdFromHeaders(headers: Headers): string | null {
  return headers.get('Mcp-Session-Id') ?? headers.get('MCP-Session-Id');
}

function sessionTokenFromHeaders(headers: Headers): string | null {
  return headers.get('Mcp-Session-Token') ?? headers.get('MCP-Session-Token');
}

function validateProtocolVersion(headers: Headers): Response | null {
  const version = headers.get('Mcp-Protocol-Version') ?? headers.get('MCP-Protocol-Version');
  if (version === null) return null;
  if (version === MCP_PROTOCOL_VERSION) return null;
  return new Response('Unsupported MCP protocol version', { status: 400 });
}

function maybeSessionHeaders(session: McpSession, includeSession: boolean): HeadersInit {
  const headers = noStoreHeaders();
  if (includeSession) {
    headers['Mcp-Session-Id'] = session.id;
    // The continuation token is disclosed exactly once — on the `initialize`
    // response that creates the session (`includeSession` is `createdSession`) — and
    // is deliberately NOT echoed on any later response. That exposure asymmetry is
    // the security gain: the session id leaks on every response, the token does not,
    // so a leaked id alone cannot continue another caller's anonymous session.
    headers['Mcp-Session-Token'] = session.token;
  }
  return headers;
}

function noStoreHeaders(): Record<string, string> {
  return { 'cache-control': 'no-store' };
}

function authRequiredFromOptions(options: McpHttpRequestOptions): boolean {
  return options.authRequired;
}

function principalFromOptions(options: McpHttpRequestOptions): Principal {
  return options.principal ?? anonymousPrincipal();
}

/**
 * Authorize a continuation request (POST/GET/DELETE) against an existing session.
 * Returns `true` when the caller may drive, read, or terminate the session.
 *
 * Two layers: the caller's principal must own the session ({@link isSameSessionOwner}),
 * AND — for sessions whose principal carries no distinguishing secret (anonymous
 * sessions under `authRequired: false`) — the caller must echo the per-session
 * continuation token. Anonymous principals are the shared singleton, so the owner
 * check alone admits any anonymous caller; the token is the per-session secret that
 * actually isolates them. Authenticated callers already re-present their credential
 * each request (it is what rebuilds the principal), so they are isolated without a
 * token and are not gated on one — keeping their session binding unchanged.
 */
function isAuthorizedForSession(
  session: McpSession,
  caller: Principal,
  presentedToken: string | null,
): boolean {
  if (!isSameSessionOwner(session.principal, caller)) return false;
  if (isAuthenticated(session.principal)) return true;
  return presentedToken !== null && presentedToken === session.token;
}

function isSameSessionOwner(left: Principal, right: Principal): boolean {
  if (left === right) return true;
  if (left.method !== right.method) return false;
  if (!isAuthenticated(left) || !isAuthenticated(right)) return left.method === right.method;
  if (left.subject === undefined || right.subject === undefined) return false;
  // Session identity binds the subject AND the authorization profile: a token
  // for the same subject but a different scope set must not silently continue a
  // session established under a narrower or broader profile. (This previously
  // also compared a tenant id; with tenancy removed, the scope set is the
  // remaining authorization dimension worth pinning.)
  return left.subject === right.subject && haveSameScopes(left.scopes, right.scopes);
}

function haveSameScopes(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const scope of left) {
    if (!right.has(scope)) return false;
  }
  return true;
}

async function readBodyBounded(request: Request, maxBytes: number): Promise<Uint8Array> {
  const body = request.body;
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new McpBodyTooLargeError();
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bodyBytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bodyBytes;
}

function validateOrigin(
  request: Request,
  publicOrigin?: string,
  trustedHosts?: ReadonlyArray<string>,
): Response | null {
  const origin = request.headers.get('origin');
  if (origin === null) return null;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return new Response('Forbidden', { status: 403 });
  }

  if (publicOrigin !== undefined && origin === publicOrigin) return null;
  if (trustedHosts?.includes(originUrl.host)) return null;
  if (originUrl.host === new URL(request.url).host) return null;
  return new Response('Forbidden', { status: 403 });
}
