import type { ServerWebSocket } from 'bun';
import { describe, expect, it } from 'bun:test';

import { encode } from '../../core/codec.ts';
import type { Engine } from '../../core/engine.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';
import { minimalServerContext } from './server-context.test-support.ts';
import {
  acquireWorkflowStreamConnection,
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
    await storage.put(`${KEYS.eventPrefix('wf-sequences')}head`, encode({ ignored: true }));
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

  it('returns no durable watch sequence when only non-event keys share the prefix', async () => {
    const storage = new MemoryStorage();
    await storage.put(`${KEYS.eventPrefix('wf-empty-watch')}head`, encode({ ignored: true }));
    const engine = { storage } as unknown as Engine;

    await expect(getHighestStoredWatchSequence(engine, 'wf-empty-watch')).resolves.toBe(-1);
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

  it('leases workflow stream capacity and releases it idempotently', () => {
    const context = minimalServerContext();
    const lease = acquireWorkflowStreamConnection(context, 'wf-lease');

    expect(lease).not.toBeNull();
    expect(context.workflowStreamConnectionCounts.get('wf-lease')).toBe(1);

    lease?.release();
    lease?.release();

    expect(context.workflowStreamConnectionCounts.has('wf-lease')).toBe(false);
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

  it('closes watch sockets instead of buffering unbounded live frames during replay', () => {
    const context = minimalServerContext();
    const closeReasons: Array<{ code: number; reason: string }> = [];
    const socket = {
      data: {
        pathname: '/v1/workflows/wf-watch/watch',
        connectionType: 'watch',
        workflowId: 'wf-watch',
        watchLastDeliveredSequence: -1,
        watchReplayInProgress: true,
        pendingWatchMessages: Array.from({ length: 1000 }, (_, sequence) => ({
          sequence,
          message: `pending-${sequence}`,
        })),
        workflowStreamConnectionAccepted: true,
      },
      send() {},
      close(code: number, reason: string) {
        closeReasons.push({ code, reason });
      },
    } as unknown as ServerWebSocket<WebSocketData>;
    context.watchSockets.set('wf-watch', new Set([socket]));
    context.workflowStreamConnectionCounts.set('wf-watch', 1);

    publishWatchMessage(context, 'wf-watch', 1000, 'overflow-frame');

    expect(closeReasons).toEqual([
      {
        code: 1008,
        reason: 'watch replay buffer exceeded 1000 pending messages',
      },
    ]);
    expect(socket.data.pendingWatchMessages).toEqual([]);
    expect(context.watchSockets.has('wf-watch')).toBe(false);
    expect(context.workflowStreamConnectionCounts.has('wf-watch')).toBe(false);
  });

  it('closes watch sockets and drops pending messages when replay scanning fails', async () => {
    const context = minimalServerContext();
    const sentMessages: string[] = [];
    const closeReasons: Array<{ code: number; reason: string }> = [];
    const socket = {
      data: {
        pathname: '/v1/workflows/wf-watch/watch',
        connectionType: 'watch',
        workflowId: 'wf-watch',
        watchReplayInProgress: true,
        pendingWatchMessages: [{ sequence: 2, message: 'pending-watch-frame' }],
        workflowStreamConnectionAccepted: true,
      },
      send(message: string) {
        sentMessages.push(message);
      },
      close(code: number, reason: string) {
        closeReasons.push({ code, reason });
      },
    } as unknown as ServerWebSocket<WebSocketData>;
    context.watchSockets.set('wf-watch', new Set([socket]));
    context.workflowStreamConnectionCounts.set('wf-watch', 1);
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
    expect(sentMessages).toEqual([]);
    expect(closeReasons).toEqual([
      {
        code: 1008,
        reason: 'watch replay failed before catch-up completed; reconnect with a newer resumeFrom',
      },
    ]);
    expect(context.watchSockets.has('wf-watch')).toBe(false);
    expect(context.workflowStreamConnectionCounts.has('wf-watch')).toBe(false);
    expect(logged[0]![0]).toBe('[weft] Failed to replay watch events for workflow "wf-watch":');
  });

  it('skips malformed stored watch records and continues replaying later events', async () => {
    const context = minimalServerContext();
    const storage = new MemoryStorage();
    await storage.put(KEYS.event('wf-watch', 1), new Uint8Array([0xc1]));
    await storage.put(
      KEYS.event('wf-watch', 2),
      encode({
        type: 'workflow:suspended',
        timestamp: 2,
        data: { workflowId: 'wf-watch' },
      }),
    );
    await storage.put(
      KEYS.event('wf-watch', 3),
      encode({
        type: 'workflow:failed',
        timestamp: Number.NaN,
        data: [],
      }),
    );
    const sentMessages: string[] = [];
    const socket = {
      data: {
        pathname: '/v1/workflows/wf-watch/watch',
        connectionType: 'watch',
        workflowId: 'wf-watch',
        watchReplayInProgress: true,
        pendingWatchMessages: [],
      },
      send(message: string) {
        sentMessages.push(message);
      },
      close() {},
    } as unknown as ServerWebSocket<WebSocketData>;
    const engine = { storage } as unknown as Engine;

    await replayWatchEvents(context, engine, socket, 'wf-watch');

    expect(sentMessages).toHaveLength(1);
    expect(JSON.parse(sentMessages[0]!)).toMatchObject({
      type: 'workflow:suspended',
      sequence: 2,
      cursor: '2',
    });
    expect(socket.data.watchReplayInProgress).toBe(false);
  });

  it('closes watch sockets when historical replay exceeds the replay cap', async () => {
    const context = minimalServerContext();
    const storage = new MemoryStorage();
    for (let sequence = 0; sequence <= 1000; sequence += 1) {
      await storage.put(
        KEYS.event('wf-watch', sequence),
        encode({
          type: 'workflow:suspended',
          timestamp: sequence,
          data: { workflowId: 'wf-watch' },
        }),
      );
    }
    const sentMessages: string[] = [];
    const closeReasons: Array<{ code: number; reason: string }> = [];
    const socket = {
      data: {
        pathname: '/v1/workflows/wf-watch/watch',
        connectionType: 'watch',
        workflowId: 'wf-watch',
        watchReplayInProgress: true,
        pendingWatchMessages: [],
      },
      send(message: string) {
        sentMessages.push(message);
      },
      close(code: number, reason: string) {
        closeReasons.push({ code, reason });
      },
    } as unknown as ServerWebSocket<WebSocketData>;
    const engine = { storage } as unknown as Engine;

    await replayWatchEvents(context, engine, socket, 'wf-watch');

    expect(sentMessages).toHaveLength(1000);
    expect(closeReasons).toEqual([
      {
        code: 1008,
        reason: 'watch replay window exceeds 1000 events; reconnect with a newer resumeFrom',
      },
    ]);
    expect(socket.data.pendingWatchMessages).toEqual([]);
    expect(socket.data.watchReplayInProgress).toBe(false);
  });
});
