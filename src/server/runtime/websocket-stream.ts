import type { ServerWebSocket } from 'bun';

import { decode } from '../../core/codec.ts';
import type { Engine } from '../../core/engine.ts';
import { loadStoredStreamTailSequence } from '../../core/engine/stream-chunk-loading.ts';
import { KEYS } from '../../storage/interface.ts';
import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';
import type { ServerContext } from './context.ts';

const TOKEN_EVENT_TYPE = 'stream:token';
const STREAM_CONNECTION_POLICY_CLOSE_CODE = 1008;

/**
 * Default per-workflow cap for one-way workflow WebSocket connections
 * (`/stream` and `/watch`). Mirrors the JSON-RPC subscription default so one
 * workflow cannot consume unbounded server sockets.
 */
export const DEFAULT_MAX_STREAM_CONNECTIONS_PER_WORKFLOW = 100;

export function sendStreamMessage(
  ws: ServerWebSocket<WebSocketData>,
  sequence: number,
  message: string,
): void {
  if (sequence <= (ws.data.streamLastDeliveredSequence ?? -1)) {
    return;
  }

  ws.send(message);
  ws.data.streamLastDeliveredSequence = sequence;
}

export function sendWatchMessage(
  ws: ServerWebSocket<WebSocketData>,
  sequence: number,
  message: string,
): void {
  if (sequence <= (ws.data.watchLastDeliveredSequence ?? -1)) {
    return;
  }

  ws.send(message);
  ws.data.watchLastDeliveredSequence = sequence;
}

export async function getHighestStoredStreamSequence(
  engine: Engine,
  workflowId: string,
  key: string,
): Promise<number> {
  const tailSequence = await loadStoredStreamTailSequence(engine.storage, workflowId, key);
  if (tailSequence !== null) {
    return tailSequence;
  }

  const prefix = KEYS.streamChunkPrefix(workflowId, key);

  for await (const [storageKey] of engine.storage.scan(prefix, { reverse: true, limit: 1 })) {
    const sequenceText = storageKey.slice(prefix.length);
    const sequence = Number.parseInt(sequenceText, 10);
    if (Number.isSafeInteger(sequence) && sequence >= 0) {
      return sequence;
    }
  }

  return -1;
}

export async function getHighestStoredWatchSequence(
  engine: Engine,
  workflowId: string,
): Promise<number> {
  const prefix = KEYS.eventPrefix(workflowId);

  for await (const [storageKey] of engine.storage.scan(prefix, { reverse: true, limit: 50 })) {
    const sequence = parseSequenceFromEventKey(prefix, storageKey);
    if (sequence !== null) return sequence;
  }

  return -1;
}

export function addStreamSocket(
  context: ServerContext,
  workflowId: string,
  ws: ServerWebSocket<WebSocketData>,
): boolean {
  if (!addWorkflowStreamConnection(context, workflowId, ws)) {
    return false;
  }

  let sockets = context.streamSockets.get(workflowId);
  if (!sockets) {
    sockets = new Set();
    context.streamSockets.set(workflowId, sockets);
  }
  sockets.add(ws);
  return true;
}

export function addWatchSocket(
  context: ServerContext,
  workflowId: string,
  ws: ServerWebSocket<WebSocketData>,
): boolean {
  if (!addWorkflowStreamConnection(context, workflowId, ws)) {
    return false;
  }

  let sockets = context.watchSockets.get(workflowId);
  if (!sockets) {
    sockets = new Set();
    context.watchSockets.set(workflowId, sockets);
  }
  sockets.add(ws);
  return true;
}

export function removeStreamSocket(
  context: ServerContext,
  ws: ServerWebSocket<WebSocketData>,
): void {
  const workflowId = ws.data.workflowId;
  if (!workflowId) return;

  const sockets = context.streamSockets.get(workflowId);
  if (!sockets) return;

  sockets.delete(ws);
  if (sockets.size === 0) {
    context.streamSockets.delete(workflowId);
  }
}

export function removeWatchSocket(
  context: ServerContext,
  ws: ServerWebSocket<WebSocketData>,
): void {
  const workflowId = ws.data.workflowId;
  if (!workflowId) return;

  const sockets = context.watchSockets.get(workflowId);
  if (!sockets) return;

  sockets.delete(ws);
  if (sockets.size === 0) {
    context.watchSockets.delete(workflowId);
  }
}

export function removeWorkflowStreamConnection(
  context: ServerContext,
  ws: ServerWebSocket<WebSocketData>,
): void {
  const workflowId = ws.data.workflowId;
  if (!workflowId || !ws.data.workflowStreamConnectionAccepted) return;

  ws.data.workflowStreamConnectionAccepted = false;
  const currentCount = context.workflowStreamConnectionCounts.get(workflowId);
  if (currentCount === undefined || currentCount <= 1) {
    context.workflowStreamConnectionCounts.delete(workflowId);
    return;
  }

  context.workflowStreamConnectionCounts.set(workflowId, currentCount - 1);
}

function addWorkflowStreamConnection(
  context: ServerContext,
  workflowId: string,
  ws: ServerWebSocket<WebSocketData>,
): boolean {
  const currentCount = context.workflowStreamConnectionCounts.get(workflowId) ?? 0;
  const maxConnections = context.maxStreamConnectionsPerWorkflow;
  if (currentCount >= maxConnections) {
    ws.close(
      STREAM_CONNECTION_POLICY_CLOSE_CODE,
      `maximum stream connections per workflow (${maxConnections}) exceeded`,
    );
    return false;
  }

  context.workflowStreamConnectionCounts.set(workflowId, currentCount + 1);
  ws.data.workflowStreamConnectionAccepted = true;
  return true;
}

export function flushPendingStreamMessages(
  _context: ServerContext,
  ws: ServerWebSocket<WebSocketData>,
): void {
  const pendingMessages = ws.data.pendingStreamMessages ?? [];
  pendingMessages.sort((left, right) => left.sequence - right.sequence);

  for (const pending of pendingMessages) {
    sendStreamMessage(ws, pending.sequence, pending.message);
  }

  ws.data.pendingStreamMessages = [];
}

export function flushPendingWatchMessages(
  _context: ServerContext,
  ws: ServerWebSocket<WebSocketData>,
): void {
  const pendingMessages = ws.data.pendingWatchMessages ?? [];
  pendingMessages.sort((left, right) => left.sequence - right.sequence);

  for (const pending of pendingMessages) {
    sendWatchMessage(ws, pending.sequence, pending.message);
  }

  ws.data.pendingWatchMessages = [];
}

export function publishTokenMessage(
  context: ServerContext,
  workflowId: string,
  sequence: number,
  message: string,
): void {
  const sockets = context.streamSockets.get(workflowId);
  if (!sockets) return;

  for (const ws of sockets) {
    if (ws.data.streamReplayInProgress) {
      ws.data.pendingStreamMessages ??= [];
      ws.data.pendingStreamMessages.push({ sequence, message });
      continue;
    }

    sendStreamMessage(ws, sequence, message);
  }
}

export function publishWatchMessage(
  context: ServerContext,
  workflowId: string,
  sequence: number,
  message: string,
): void {
  const sockets = context.watchSockets.get(workflowId);
  if (!sockets) return;

  for (const ws of sockets) {
    if (ws.data.watchReplayInProgress) {
      ws.data.pendingWatchMessages ??= [];
      ws.data.pendingWatchMessages.push({ sequence, message });
      continue;
    }

    sendWatchMessage(ws, sequence, message);
  }
}

/**
 * Send existing token chunks from storage to a newly connected stream client,
 * so it can catch up on tokens emitted before the connection was established.
 */
export async function replayTokenStream(
  context: ServerContext,
  engine: Engine,
  ws: ServerWebSocket<WebSocketData>,
  workflowId: string,
): Promise<void> {
  ws.data.streamLastDeliveredSequence = -1;

  try {
    const requestedResumeFrom = ws.data.resumeFrom;
    const after =
      requestedResumeFrom === undefined
        ? -1
        : Math.min(
            requestedResumeFrom,
            await getHighestStoredStreamSequence(engine, workflowId, 'tokens'),
          );
    ws.data.streamLastDeliveredSequence = after;
    const chunks =
      after >= 0
        ? await engine.getStreamChunks(workflowId, 'tokens', { after })
        : await engine.getStreamChunks(workflowId, 'tokens');

    for (const chunk of chunks) {
      if (typeof chunk.value !== 'object' || chunk.value === null) {
        continue;
      }

      sendStreamMessage(
        ws,
        chunk.sequence,
        JSON.stringify({
          type: TOKEN_EVENT_TYPE,
          timestamp: Date.now(),
          sequence: chunk.sequence,
          data: chunk.value,
        }),
      );
    }
  } catch (error) {
    console.error(`[weft] Failed to replay token stream for workflow "${workflowId}":`, error);
  } finally {
    ws.data.streamReplayInProgress = false;
    flushPendingStreamMessages(context, ws);
  }
}

/**
 * Send stored raw watch events to a newly connected watch client. The raw
 * watch transport keeps its historical frame shape but now honors the same
 * `resumeFrom` cursor query parameter used by token streams.
 */
export async function replayWatchEvents(
  context: ServerContext,
  engine: Engine,
  ws: ServerWebSocket<WebSocketData>,
  workflowId: string,
): Promise<void> {
  ws.data.watchLastDeliveredSequence = -1;

  try {
    const requestedResumeFrom = ws.data.resumeFrom;
    const after =
      requestedResumeFrom === undefined
        ? -1
        : Math.min(requestedResumeFrom, await getHighestStoredWatchSequence(engine, workflowId));
    ws.data.watchLastDeliveredSequence = after;
    const prefix = KEYS.eventPrefix(workflowId);
    const scanOptions = after >= 0 ? { gt: KEYS.event(workflowId, after) } : undefined;

    for await (const [storageKey, value] of engine.storage.scan(prefix, scanOptions)) {
      const sequence = parseSequenceFromEventKey(prefix, storageKey);
      if (sequence === null || sequence <= after) continue;
      const decoded = decodeStoredWatchEvent(value);
      if (!isStoredWatchEvent(decoded)) continue;
      sendWatchMessage(
        ws,
        sequence,
        JSON.stringify({
          type: decoded.type,
          timestamp: decoded.timestamp,
          data: decoded.data,
          sequence,
          cursor: String(sequence),
        }),
      );
    }
  } catch (error) {
    console.error(`[weft] Failed to replay watch events for workflow "${workflowId}":`, error);
  } finally {
    ws.data.watchReplayInProgress = false;
    flushPendingWatchMessages(context, ws);
  }
}

function decodeStoredWatchEvent(value: Uint8Array): unknown {
  try {
    return decode(value);
  } catch {
    return null;
  }
}

function parseSequenceFromEventKey(prefix: string, storageKey: string): number | null {
  if (!storageKey.startsWith(prefix)) return null;
  const rawSequence = storageKey.slice(prefix.length);
  if (!/^\d+$/.test(rawSequence)) return null;
  const sequence = Number.parseInt(rawSequence, 10);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

function isStoredWatchEvent(
  value: unknown,
): value is { type: string; timestamp: number; data: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['type'] === 'string' &&
    typeof record['timestamp'] === 'number' &&
    typeof record['data'] === 'object' &&
    record['data'] !== null
  );
}
