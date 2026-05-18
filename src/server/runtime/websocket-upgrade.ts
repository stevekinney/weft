import type { AuthContext } from '../authentication.ts';
import { authContextToPrincipal } from '../handler.ts';
import type { ServeOptions } from '../index.ts';
import { finalizeWebSocketUpgrade } from '../json-rpc-transport-helpers.ts';
import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';
import { parseOptionalSequenceCursor } from '../sequence-cursor.ts';
import type { ServerContext } from './context.ts';

export const WORKER_STREAM_RE = /^\/v1\/tasks\/([\w-]+)\/stream$/;

const WORKFLOW_STREAM_RE = /^\/v1\/workflows\/([^/]+)\/stream$/;
const WORKFLOW_WATCH_RE = /^\/v1\/workflows\/([^/]+)\/watch$/;

function tryDecodePathComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Match a URL pathname against a route regex and decode the first capture group.
 * Returns the decoded value, null if decoding fails, or undefined if the path
 * does not match.
 */
function matchUpgradePath(pathname: string, pattern: RegExp): string | null | undefined {
  const match = pattern.exec(pathname);
  if (!match?.[1]) return undefined;
  return tryDecodePathComponent(match[1]);
}

/** Classify a WebSocket request URL and extract relevant parameters. */
export function classifyConnection(
  url: URL,
): Pick<WebSocketData, 'connectionType' | 'workflowId' | 'queue'> | null {
  const { pathname } = url;

  const workflowStreamId = matchUpgradePath(pathname, WORKFLOW_STREAM_RE);
  if (workflowStreamId !== undefined) {
    return workflowStreamId === null
      ? null
      : { connectionType: 'stream', workflowId: workflowStreamId };
  }

  const workflowWatchId = matchUpgradePath(pathname, WORKFLOW_WATCH_RE);
  if (workflowWatchId !== undefined) {
    return workflowWatchId === null
      ? null
      : { connectionType: 'watch', workflowId: workflowWatchId };
  }

  const queue = matchUpgradePath(pathname, WORKER_STREAM_RE);
  if (queue !== undefined) {
    return queue === null ? null : { connectionType: 'worker', queue };
  }

  if (pathname === '/jsonrpc') {
    return { connectionType: 'jsonrpc' };
  }

  return { connectionType: 'generic' };
}

export function handleWebSocketUpgrade(
  server: ReturnType<typeof Bun.serve>,
  context: ServerContext,
  options: ServeOptions,
  request: Request,
  url: URL,
  authContext?: AuthContext,
): Response | undefined | null {
  void context;
  void options;

  if (request.headers.get('upgrade') !== 'websocket') {
    return null;
  }

  const classification = classifyConnection(url);
  if (classification === null) {
    return new Response('Invalid encoded WebSocket path', { status: 400 });
  }

  // Resolve the principal ONLY for /jsonrpc connections. Other WS
  // endpoints (`/v1/workflows/:id/stream`, `/watch`, `/v1/tasks/:q/stream`)
  // do not consume a `Principal`, so running `authContextToPrincipal`
  // for them would convert a client-side auth error (e.g.,
  // malformed JWT) into a spurious failure on paths that never
  // needed the principal in the first place. A resolver throw is
  // an authentication failure — return 401 so clients with
  // retry-on-5xx logic don't loop.
  let principal: WebSocketData['principal'] | undefined;
  if (classification.connectionType === 'jsonrpc' && authContext !== undefined) {
    try {
      principal = authContextToPrincipal(authContext);
    } catch (error) {
      console.error('[weft] /jsonrpc WS upgrade principal resolution failed', error);
      return new Response('Authentication context invalid', { status: 401 });
    }
  }

  const resumeFromParam = url.searchParams.get('resumeFrom');
  const resumeFromResult = parseOptionalSequenceCursor(
    resumeFromParam,
    'resumeFrom query parameter',
  );
  if (resumeFromResult.error) {
    return new Response(resumeFromResult.error, { status: 400 });
  }
  const resumeFrom = resumeFromResult.value;

  return finalizeWebSocketUpgrade(server, request, {
    pathname: url.pathname,
    ...classification,
    ...(principal ? { principal } : {}),
    ...(resumeFrom !== undefined ? { resumeFrom } : {}),
  });
}
