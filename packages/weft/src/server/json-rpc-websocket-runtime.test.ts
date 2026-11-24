import { describe, expect, it, spyOn } from 'bun:test';

import type { JsonRpcWebSocketSession } from "../embedded/backchannel/src/internals.ts";
import {
  closeJsonRpcSessionsForShutdown,
  openJsonRpcWebSocketSession,
  type WebSocketData,
} from './json-rpc-websocket-runtime.ts';

function createWebSocket(data: Partial<WebSocketData> = {}): {
  ws: {
    data: WebSocketData;
    send(message: string): number;
    close(code?: number, reason?: string): void;
  };
  sent: string[];
  closeCalls: Array<{ code: number | undefined; reason: string | undefined }>;
} {
  const sent: string[] = [];
  const closeCalls: Array<{ code: number | undefined; reason: string | undefined }> = [];
  return {
    ws: {
      data: {
        pathname: '/jsonrpc',
        connectionType: 'jsonrpc',
        ...data,
      },
      send(message: string) {
        sent.push(message);
        return sent.length;
      },
      close(code?: number, reason?: string) {
        closeCalls.push({ code, reason });
      },
    },
    sent,
    closeCalls,
  };
}

describe('json-rpc websocket runtime helpers', () => {
  it('attaches a session, uses the websocket emitter, and tracks the active session', async () => {
    const { ws, sent } = createWebSocket();
    const activeSessions = new Set<JsonRpcWebSocketSession>();
    const jsonRpcModule = await import("../embedded/backchannel/src/internals.ts");
    const session: JsonRpcWebSocketSession = {
      async handleMessage() {},
      async close() {},
    };
    const createJsonRpcWebSocketSessionSpy = spyOn(
      jsonRpcModule,
      'createJsonRpcWebSocketSession',
    ).mockImplementation((options) => {
      options.emitter.send('server-message');
      expect(options.transport).toBe('jsonRpcWebSocket');
      return session;
    });

    try {
      openJsonRpcWebSocketSession({
        ws,
        registry: {} as never,
        engine: {},
        feed: {} as never,
        fleetFeed: {} as never,
        activeSessions,
      });

      expect(ws.data.jsonRpcSession).toBe(session);
      expect(activeSessions.has(session)).toBe(true);
      expect(sent).toEqual(['server-message']);
    } finally {
      createJsonRpcWebSocketSessionSpy.mockRestore();
    }
  });

  it('logs and closes the socket when session construction throws', async () => {
    const { ws, closeCalls } = createWebSocket();
    const activeSessions = new Set<JsonRpcWebSocketSession>();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const jsonRpcModule = await import("../embedded/backchannel/src/internals.ts");
    const createJsonRpcWebSocketSessionSpy = spyOn(
      jsonRpcModule,
      'createJsonRpcWebSocketSession',
    ).mockImplementation(() => {
      throw new Error('session construction failed');
    });

    try {
      openJsonRpcWebSocketSession({
        ws,
        registry: {} as never,
        engine: {},
        feed: {} as never,
        fleetFeed: {} as never,
        activeSessions,
      });

      expect(closeCalls).toEqual([{ code: 1011, reason: 'session construction failed' }]);
      expect(activeSessions.size).toBe(0);
      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] /jsonrpc WS session construction failed',
        expect.any(Error),
      );
    } finally {
      createJsonRpcWebSocketSessionSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('logs rejected shutdown closes for every active session and clears the active set', async () => {
    const closeFailure = new Error('shutdown close failed');
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const activeSessions = new Set<JsonRpcWebSocketSession>([
      {
        async handleMessage() {},
        async close() {
          throw closeFailure;
        },
      },
      {
        async handleMessage() {},
        async close() {
          throw closeFailure;
        },
      },
    ]);

    try {
      await closeJsonRpcSessionsForShutdown(activeSessions);

      expect(activeSessions.size).toBe(0);
      expect(errorSpy).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] /jsonrpc WS session close error during shutdown',
        closeFailure,
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
