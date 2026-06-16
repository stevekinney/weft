import type { ServerWebSocket } from 'bun';
import { describe, expect, it } from 'bun:test';

import { encode } from '../../core/codec.ts';
import type { Engine } from '../../core/engine.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';
import { minimalServerContext } from './server-context.test-support.ts';
import {
  addWatchSocket,
  flushPendingWatchMessages,
  getHighestStoredStreamSequence,
  getHighestStoredWatchSequence,
  publishWatchMessage,
  removeWatchSocket,
  replayWatchEvents,
} from './websocket-stream.ts';

describe('watch WebSocket delivery', () => {
  it('reads the highest durable stream and watch sequence from storage keys', async () => {
    const storage = new MemoryStorage();
    await storage.put(KEYS.streamChunk('wf-sequences', 'tokens', 3), encode({ token: 'a' }));
    await storage.put(
      KEYS.event('wf-sequences', 4),
      encode({
        type: 'workflow:suspended',
        timestamp: 1,
        data: { workflowId: 'wf-sequences' },
        sequence: 4,
        cursor: '4',
      }),
    );
    const engine = { storage } as unknown as Engine;

    await expect(getHighestStoredStreamSequence(engine, 'wf-sequences', 'tokens')).resolves.toBe(3);
    await expect(getHighestStoredWatchSequence(engine, 'wf-sequences')).resolves.toBe(4);
  });

  it('rejects watch sockets when the per-workflow stream cap is already full', () => {
    const context = {
      ...minimalServerContext(),
      maxStreamConnectionsPerWorkflow: 0,
    };
    const closeReasons: Array<{ code: number; reason: string }> = [];
    const socket = {
      data: {
        pathname: '/v1/workflows/wf-watch/watch',
        connectionType: 'watch',
        workflowId: 'wf-watch',
      },
      send() {},
      close(code: number, reason: string) {
        closeReasons.push({ code, reason });
      },
    } as unknown as ServerWebSocket<WebSocketData>;

    expect(addWatchSocket(context, 'wf-watch', socket)).toBe(false);
    expect(closeReasons).toEqual([
      {
        code: 1008,
        reason: 'maximum stream connections per workflow (0) exceeded',
      },
    ]);
  });

  it('buffers live watch frames during replay and dedupes by the watch cursor', () => {
    const context = minimalServerContext();
    const sentMessages: string[] = [];
    const socket = {
      data: {
        pathname: '/v1/workflows/wf-watch/watch',
        connectionType: 'watch',
        workflowId: 'wf-watch',
        streamLastDeliveredSequence: 100,
        watchLastDeliveredSequence: 1,
        watchReplayInProgress: true,
        pendingWatchMessages: [],
      },
      send(message: string) {
        sentMessages.push(message);
      },
      close() {},
    } as unknown as ServerWebSocket<WebSocketData>;

    expect(addWatchSocket(context, 'wf-watch', socket)).toBe(true);

    publishWatchMessage(context, 'wf-watch', 1, 'duplicate-watch-frame');
    publishWatchMessage(context, 'wf-watch', 2, 'next-watch-frame');

    expect(sentMessages).toEqual([]);

    socket.data.watchReplayInProgress = false;
    flushPendingWatchMessages(context, socket);

    expect(sentMessages).toEqual(['next-watch-frame']);

    removeWatchSocket(context, socket);
  });

  it('clears watch replay state and flushes pending messages when replay scanning fails', async () => {
    const context = minimalServerContext();
    const sentMessages: string[] = [];
    const socket = {
      data: {
        pathname: '/v1/workflows/wf-watch/watch',
        connectionType: 'watch',
        workflowId: 'wf-watch',
        watchReplayInProgress: true,
        pendingWatchMessages: [{ sequence: 2, message: 'pending-watch-frame' }],
      },
      send(message: string) {
        sentMessages.push(message);
      },
      close() {},
    } as unknown as ServerWebSocket<WebSocketData>;
    const engine = {
      storage: {
        async *scan() {
          throw new Error('watch scan failed');
        },
      },
    } as unknown as Engine;
    const originalError = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };

    try {
      await replayWatchEvents(context, engine, socket, 'wf-watch');
    } finally {
      console.error = originalError;
    }

    expect(socket.data.watchReplayInProgress).toBe(false);
    expect(socket.data.pendingWatchMessages).toEqual([]);
    expect(sentMessages).toEqual(['pending-watch-frame']);
    expect(logged[0]![0]).toBe('[weft] Failed to replay watch events for workflow "wf-watch":');
  });
});
