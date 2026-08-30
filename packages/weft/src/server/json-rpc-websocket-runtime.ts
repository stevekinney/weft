import type { ServerWebSocket } from 'bun';

import type { FleetEventFeed } from './fleet-event-feed.ts';
import {
  createJsonRpcWebSocketSession,
  type JsonRpcWebSocketSession,
} from './json-rpc-websocket.ts';
import type { OperationRegistry } from './operation-catalog.ts';
import { anonymousPrincipal, type Principal } from './principal.ts';
import type { WorkflowEventFeed } from './workflow-event-feed.ts';

export type ConnectionType = 'worker' | 'stream' | 'watch' | 'generic' | 'jsonrpc';

export interface WebSocketData {
  pathname: string;
  connectionType: ConnectionType;
  workflowId?: string;
  resumeFrom?: number;
  queue?: string;
  workerId?: string;
  workerRegistered?: boolean;
  workerProtocolVersion?: number;
  streamLastDeliveredSequence?: number;
  streamReplayInProgress?: boolean;
  pendingStreamMessages?: Array<{ sequence: number; message: string }>;
  watchLastDeliveredSequence?: number;
  watchReplayInProgress?: boolean;
  pendingWatchMessages?: Array<{ sequence: number; message: string }>;
  workflowStreamConnectionAccepted?: boolean;
  principal?: Principal;
  jsonRpcSession?: JsonRpcWebSocketSession;
}

export function handleJsonRpcWebSocketMessage(
  ws: Pick<ServerWebSocket<WebSocketData>, 'data' | 'close'>,
  rawMessage: string | Buffer,
): void {
  const session = ws.data.jsonRpcSession;
  if (!session) {
    console.error('[weft] /jsonrpc WS frame received with no session attached — closing');
    ws.close(1011, 'no jsonrpc session attached');
    return;
  }

  const text = typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage);
  session.handleMessage(text).catch((error) => {
    console.error('[weft] /jsonrpc WS message error', error);
  });
}

export function openJsonRpcWebSocketSession(options: {
  ws: Pick<ServerWebSocket<WebSocketData>, 'data' | 'send' | 'close'>;
  registry: OperationRegistry;
  engine: unknown;
  feed: WorkflowEventFeed;
  fleetFeed?: FleetEventFeed;
  activeSessions: Set<JsonRpcWebSocketSession>;
}): void {
  try {
    const session = createJsonRpcWebSocketSession({
      registry: options.registry,
      engine: options.engine,
      principal: options.ws.data.principal ?? anonymousPrincipal(),
      emitter: { send: (message) => options.ws.send(message) },
      feed: options.feed,
      ...(options.fleetFeed !== undefined ? { fleetFeed: options.fleetFeed } : {}),
      transport: 'jsonRpcWebSocket',
    });
    options.ws.data.jsonRpcSession = session;
    options.activeSessions.add(session);
  } catch (error) {
    console.error('[weft] /jsonrpc WS session construction failed', error);
    options.ws.close(1011, 'session construction failed');
  }
}

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

export async function closeJsonRpcSessionsForShutdown(
  activeSessions: Set<JsonRpcWebSocketSession>,
): Promise<void> {
  const closes: Array<Promise<void>> = [];
  for (const session of activeSessions) {
    closes.push(
      session.close().catch((error) => {
        console.error('[weft] /jsonrpc WS session close error during shutdown', error);
      }),
    );
  }
  activeSessions.clear();
  await Promise.allSettled(closes);
}
