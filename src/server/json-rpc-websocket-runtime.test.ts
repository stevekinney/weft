import { describe, expect, it, spyOn } from 'bun:test';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';

import {
  closeJsonRpcSessionsForShutdown,
  closeJsonRpcWebSocketSession,
  handleJsonRpcWebSocketMessage,
  openJsonRpcWebSocketSession,
  type WebSocketData,
} from './json-rpc-websocket-runtime.ts';
import type { JsonRpcWebSocketSession } from './json-rpc-websocket.ts';

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
  it('closes frames that arrive without a session attached', () => {
    const { ws, closeCalls } = createWebSocket();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      handleJsonRpcWebSocketMessage(ws, '{"jsonrpc":"2.0"}');

      expect(closeCalls).toEqual([{ code: 1011, reason: 'no jsonrpc session attached' }]);
      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] /jsonrpc WS frame received with no session attached — closing',
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('decodes Buffer frames and logs rejected message handlers', async () => {
    const closeCalls: Array<{ code: number | undefined; reason: string | undefined }> = [];
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const session = {
      handleMessage: async (frame: string) => {
        expect(frame).toBe('{"jsonrpc":"2.0"}');
        throw new Error('frame failed');
      },
      async close() {},
    } satisfies JsonRpcWebSocketSession;

    try {
      handleJsonRpcWebSocketMessage(
        {
          data: {
            pathname: '/jsonrpc',
            connectionType: 'jsonrpc',
            jsonRpcSession: session,
          },
          close(code?: number, reason?: string) {
            closeCalls.push({ code, reason });
          },
        },
        Buffer.from('{"jsonrpc":"2.0"}'),
      );
      await sleepForTesting(0);

      expect(closeCalls).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith('[weft] /jsonrpc WS message error', expect.any(Error));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('attaches a session, uses the websocket emitter, and tracks the active session', async () => {
    const { ws, sent } = createWebSocket();
    const activeSessions = new Set<JsonRpcWebSocketSession>();
    const jsonRpcModule = await import('./json-rpc-websocket.ts');
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
    const jsonRpcModule = await import('./json-rpc-websocket.ts');
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

  it('logs rejected close handlers and removes the closed session from the active set', async () => {
    const closeFailure = new Error('close failed');
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const session: JsonRpcWebSocketSession = {
      async handleMessage() {},
      async close() {
        throw closeFailure;
      },
    };
    const activeSessions = new Set<JsonRpcWebSocketSession>([session]);

    try {
      closeJsonRpcWebSocketSession({ session, activeSessions });
      await sleepForTesting(0);

      expect(activeSessions.size).toBe(0);
      expect(errorSpy).toHaveBeenCalledWith('[weft] /jsonrpc WS session close error', closeFailure);
    } finally {
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
