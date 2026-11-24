import type { ServerWebSocket } from 'bun';

import { anonymousPrincipal } from "../embedded/backchannel/src/index.ts";
import {
  createJsonRpcWebSocketSession,
  workspaceEmitter,
  type ConnectionLease,
  type JsonRpcSocketData,
  type JsonRpcWebSocketSession,
  type OperationRegistry,
} from "../embedded/backchannel/src/internals.ts";
import type { FleetEventFeed } from './fleet-event-feed.ts';
import { createWeftDiscoverDocument } from './weft-documents.ts';
import type { WorkflowEventFeed } from './workflow-event-feed.ts';

export type ConnectionType = 'worker' | 'stream' | 'watch' | 'generic' | 'jsonrpc';

/** What Weft's engine-hosted server keeps on each socket: the session's state and Weft's own. */
export interface WebSocketData extends JsonRpcSocketData {
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
  workflowWebSocketConnectionLease?: ConnectionLease;
}

export function openJsonRpcWebSocketSession(options: {
  ws: Pick<ServerWebSocket<WebSocketData>, 'data' | 'send' | 'close'>;
  registry: OperationRegistry;
  engine: unknown;
  feed: WorkflowEventFeed;
  fleetFeed?: FleetEventFeed;
  acquireWorkflowSubscription?: () => ConnectionLease;
  acquireFleetSubscription?: () => ConnectionLease;
  activeSessions: Set<JsonRpcWebSocketSession>;
}): void {
  try {
    const session = createJsonRpcWebSocketSession({
      registry: options.registry,
      engine: options.engine,
      principal: options.ws.data.principal ?? anonymousPrincipal(),
      emitter: workspaceEmitter(options.ws),
      feed: options.feed,
      discoverDocument: createWeftDiscoverDocument(options.registry, options.engine),
      ...(options.fleetFeed !== undefined ? { fleetFeed: options.fleetFeed } : {}),
      ...(options.acquireWorkflowSubscription !== undefined
        ? { acquireWorkflowSubscription: options.acquireWorkflowSubscription }
        : {}),
      ...(options.acquireFleetSubscription !== undefined
        ? { acquireFleetSubscription: options.acquireFleetSubscription }
        : {}),
      transport: 'jsonRpcWebSocket',
    });
    options.ws.data.jsonRpcSession = session;
    options.activeSessions.add(session);
  } catch (error) {
    console.error('[weft] /jsonrpc WS session construction failed', error);
    options.ws.close(1011, 'session construction failed');
  }
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
