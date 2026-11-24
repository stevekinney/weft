/**
 * The socket-side runtime of a JSON-RPC WebSocket session that names no server: what a socket must
 * offer (`data`, `send`, `close`), the per-socket state the session keeps, and the functions that
 * open a session on a socket, feed it frames, and close it. Runtime-free, so any host that can
 * hand over a socket of this shape can serve a catalog.
 *
 * @module server/json-rpc-session-runtime
 */

import {
  createJsonRpcWebSocketSession,
  type JsonRpcWebSocketSession,
} from './json-rpc-websocket.ts';
import type { OperationRegistry } from './operation-catalog.ts';
import { anonymousPrincipal, type Principal } from './principal.ts';

/** The part of a WebSocket a session uses. Bun's `ServerWebSocket` satisfies it. */
export type JsonRpcSocket<Data> = {
  readonly data: Data;
  send(message: string): unknown;
  close(code?: number, reason?: string): void;
};

/** What a session keeps on its socket. */
export interface JsonRpcSocketData {
  /** The path the socket upgraded on. */
  pathname: string;
  /** The kind of connection, for logging. */
  connectionType: string;
  /** The authenticated caller. */
  principal?: Principal;
  /** The session attached to the socket. */
  jsonRpcSession?: JsonRpcWebSocketSession;
  /** Current workspace authority, captured from the authenticated upgrade request. */
  revalidateWorkspace?: () => Promise<boolean>;
  /** Serialize admission checks without waiting for admitted operations to finish. */
  workspaceRequestTail?: Promise<void>;
  /** Preserve outgoing frame order while each frame resolves current authority. */
  workspaceReleaseTail?: Promise<void>;
  /** Fence pending checks and frames after revocation or socket closure. */
  workspaceClosed?: boolean;
}

async function workspaceAllowed(
  ws: Pick<JsonRpcSocket<JsonRpcSocketData>, 'data' | 'close'>,
): Promise<boolean> {
  if (ws.data.workspaceClosed) return false;
  let allowed = false;
  try {
    allowed = (await ws.data.revalidateWorkspace?.()) ?? true;
  } catch {
    /* Fail closed. */
  }
  if (ws.data.workspaceClosed) return false;
  if (!allowed) {
    ws.data.workspaceClosed = true;
    ws.close(1008, 'Workspace membership required');
    await ws.data.jsonRpcSession?.close();
  }
  return allowed;
}

/** Wraps a socket as an emitter that rechecks workspace authority before each frame. */
export function workspaceEmitter(
  ws: Pick<JsonRpcSocket<JsonRpcSocketData>, 'data' | 'send' | 'close'>,
) {
  return {
    send(message: string): void {
      if (ws.data.revalidateWorkspace === undefined) {
        ws.send(message);
        return;
      }
      ws.data.workspaceReleaseTail = (ws.data.workspaceReleaseTail ?? Promise.resolve())
        .then(async () => {
          if (await workspaceAllowed(ws)) ws.send(message);
          return undefined;
        })
        .catch(() => {
          ws.data.workspaceClosed = true;
          ws.close(1011, 'Workspace stream closed');
        });
    },
  };
}

async function admitWorkspaceMessage(
  ws: Pick<JsonRpcSocket<JsonRpcSocketData>, 'data' | 'close'>,
  session: JsonRpcWebSocketSession,
  text: string,
): Promise<void> {
  if (!(await workspaceAllowed(ws))) return;
  void session.handleMessage(text).catch(() => {
    ws.data.workspaceClosed = true;
    ws.close(1011, 'Workspace request failed');
  });
}

/** Routes one incoming WebSocket frame to the session attached to the socket. */
export function handleJsonRpcWebSocketMessage(
  ws: Pick<JsonRpcSocket<JsonRpcSocketData>, 'data' | 'close'>,
  rawMessage: string | Uint8Array,
): void {
  const session = ws.data.jsonRpcSession;
  if (!session) {
    console.error('[weft] /jsonrpc WS frame received with no session attached — closing');
    ws.close(1011, 'no jsonrpc session attached');
    return;
  }

  const text = typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage);
  if (ws.data.revalidateWorkspace !== undefined) {
    ws.data.workspaceRequestTail = (ws.data.workspaceRequestTail ?? Promise.resolve())
      .then(() => admitWorkspaceMessage(ws, session, text))
      .catch(() => {
        ws.data.workspaceClosed = true;
        ws.close(1011, 'Workspace request failed');
      });
    return;
  }
  session.handleMessage(text).catch((error) => {
    console.error('[weft] /jsonrpc WS message error', error);
  });
}

/** Opens a JSON-RPC session on a socket and registers it among the active sessions. */
export function openGenericJsonRpcWebSocketSession(options: {
  ws: Pick<JsonRpcSocket<JsonRpcSocketData>, 'data' | 'send' | 'close'>;
  registry: OperationRegistry;
  host: unknown;
  activeSessions: Set<JsonRpcWebSocketSession>;
  discoverDocument?: () => Record<string, unknown>;
}): void {
  try {
    const session = createJsonRpcWebSocketSession({
      registry: options.registry,
      engine: options.host,
      principal: options.ws.data.principal ?? anonymousPrincipal(),
      emitter: workspaceEmitter(options.ws),
      transport: 'jsonRpcWebSocket',
      ...(options.discoverDocument === undefined
        ? {}
        : { discoverDocument: options.discoverDocument }),
    });
    options.ws.data.jsonRpcSession = session;
    options.activeSessions.add(session);
  } catch (error) {
    console.error('[weft] generic JSON-RPC WS session construction failed', error);
    options.ws.close(1011, 'session construction failed');
  }
}

/** Closes a session and releases its subscriptions. */
export function closeJsonRpcWebSocketSession(options: {
  session: JsonRpcWebSocketSession | undefined;
  activeSessions: Set<JsonRpcWebSocketSession>;
}): void {
  const { session, activeSessions } = options;
  if (!session) return;

  activeSessions.delete(session);
  void session.close().catch((error) => {
    console.error('[weft] /jsonrpc WS session close error', error);
  });
}
