/**
 * Byte-level WebSocket client for testing RemoteWorker protocol durability
 * under network failure. Built on `Bun.connect` so tests can drop application
 * frames, terminate the underlying TCP socket without a WebSocket close frame,
 * and assert exact wire behavior. Not re-exported from `src/testing/index.ts`.
 * @internal
 */

import type { Socket } from 'bun';

import {
  parseServerToWorkerMessage,
  type ServerToWorkerMessage,
  type WorkerToServerMessage,
} from '../worker/protocol.ts';
import {
  computeHandshakeAccept,
  concatChunks,
  generateHandshakeKey,
  OPCODE_BINARY,
  OPCODE_CLOSE,
  OPCODE_CONTINUATION,
  OPCODE_PING,
  OPCODE_PONG,
  OPCODE_TEXT,
  tryParseFrame,
  validateHandshakeHeaders,
  writeCloseFrame,
  writePongFrame,
  writeTextFrame,
  type ParsedFrame,
} from './worker-fault-injection-frames.test-support.ts';

/** Handler for inbound server → worker protocol messages. */
export type ServerToWorkerHandler = (m: ServerToWorkerMessage) => void;
/** Result of a `closed` resolution: the WebSocket close code and reason. */
export type CloseInfo = { code: number; reason: string };
/** Options accepted by {@link connectFaultInjectingWorker}. */
export type ConnectOptions = {
  url: string;
  workerId?: string;
  onAnyInbound?: ServerToWorkerHandler;
  handshakeTimeoutMs?: number;
};
/** Predicate used by `nextServerMessage` / `expectNoServerMessage`. */
export type ServerMessagePredicate = (m: ServerToWorkerMessage) => boolean;

/** Fault-injecting WebSocket worker stream. See {@link connectFaultInjectingWorker}. */
export type FaultInjectingWorker = {
  send(payload: WorkerToServerMessage): void;
  onServerMessage(handler: ServerToWorkerHandler): () => void;
  nextServerMessage(
    predicate: ServerMessagePredicate,
    options?: { timeoutMs?: number },
  ): Promise<ServerToWorkerMessage>;
  expectNoServerMessage(
    predicate: ServerMessagePredicate,
    options: { timeoutMs: number },
  ): Promise<void>;
  partition(): void;
  heal(): void;
  hardClose(): Promise<void>;
  cleanClose(): Promise<void>;
  readonly closed: Promise<CloseInfo>;
  readonly closedState: 'open' | 'closed';
  readonly workerId: string | undefined;
};

type ClientState = {
  socket: Socket | null;
  handshakeBuffer: Uint8Array;
  frameBuffer: Uint8Array;
  handshakeResolved: boolean;
  closedState: 'open' | 'closed';
  partitioned: boolean;
  messageHandlers: Set<ServerToWorkerHandler>;
  anyInboundHandler: ServerToWorkerHandler | undefined;
  /** Messages buffered for waiters not yet installed; drained by `nextServerMessage` before its handler attaches. */
  inboundBuffer: ServerToWorkerMessage[];
  closeResolvers: Array<(info: CloseInfo) => void>;
  pendingError: unknown;
};

/** Connect to a worker WebSocket endpoint and complete the RFC 6455 handshake. */
export async function connectFaultInjectingWorker(
  options: ConnectOptions,
): Promise<FaultInjectingWorker> {
  const parsedUrl = new URL(options.url);
  if (parsedUrl.protocol !== 'ws:') {
    throw new Error(`Unsupported protocol for fault-injecting worker: ${parsedUrl.protocol}`);
  }
  const hostname = parsedUrl.hostname;
  const port = Number(parsedUrl.port || 80);
  const pathWithQuery = `${parsedUrl.pathname}${parsedUrl.search}`;
  const handshakeKey = generateHandshakeKey();
  const expectedAccept = await computeHandshakeAccept(handshakeKey);

  const state = createClientState(options.onAnyInbound);
  const closed = new Promise<CloseInfo>((resolve) => {
    state.closeResolvers.push(resolve);
  });

  return new Promise<FaultInjectingWorker>((resolve, reject) => {
    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 1_000;
    const handshakeTimer = setTimeout(() => {
      if (state.handshakeResolved) return;
      state.handshakeResolved = true;
      endSocketSafely(state.socket);
      reject(new Error('WebSocket handshake timeout'));
    }, handshakeTimeoutMs);

    const onHandshakeSuccess = (): void => {
      clearTimeout(handshakeTimer);
      resolve(buildHandle(state, options, closed));
    };
    const onHandshakeFailure = (error: Error): void => {
      clearTimeout(handshakeTimer);
      endSocketSafely(state.socket);
      reject(error);
    };

    const connectPromise = Bun.connect({
      hostname,
      port,
      socket: {
        open(socket) {
          state.socket = socket;
          sendHandshakeRequest(socket, pathWithQuery, hostname, port, handshakeKey);
        },
        data(_socket, chunk) {
          if (!state.handshakeResolved) {
            handleHandshakeChunk(
              state,
              chunk,
              expectedAccept,
              onHandshakeSuccess,
              onHandshakeFailure,
            );
            return;
          }
          handleFrameChunk(state, chunk);
        },
        close() {
          finalizeClose(state, { code: 1006, reason: '' });
        },
        end() {
          finalizeClose(state, { code: 1006, reason: '' });
        },
        error(_socket, error) {
          if (!state.handshakeResolved) {
            state.handshakeResolved = true;
            clearTimeout(handshakeTimer);
            reject(error);
            return;
          }
          state.pendingError = error;
          finalizeClose(state, { code: 1006, reason: '' });
        },
      },
    });
    void connectPromise.catch((error: unknown) => {
      if (state.handshakeResolved) return;
      state.handshakeResolved = true;
      clearTimeout(handshakeTimer);
      reject(error);
    });
  });
}

function createClientState(anyInbound: ServerToWorkerHandler | undefined): ClientState {
  return {
    socket: null,
    handshakeBuffer: new Uint8Array(0),
    frameBuffer: new Uint8Array(0),
    handshakeResolved: false,
    closedState: 'open',
    partitioned: false,
    messageHandlers: new Set(),
    anyInboundHandler: anyInbound,
    inboundBuffer: [],
    closeResolvers: [],
    pendingError: null,
  };
}

function sendHandshakeRequest(
  socket: Socket,
  pathWithQuery: string,
  hostname: string,
  port: number,
  handshakeKey: string,
): void {
  socket.write(
    [
      `GET ${pathWithQuery} HTTP/1.1`,
      `Host: ${hostname}:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${handshakeKey}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'),
  );
}

function endSocketSafely(socket: Socket | null): void {
  if (socket === null) return;
  try {
    socket.end();
  } catch {
    // Already closed.
  }
}

function buildHandle(
  state: ClientState,
  options: ConnectOptions,
  closed: Promise<CloseInfo>,
): FaultInjectingWorker {
  return {
    send(payload) {
      if (state.partitioned) return;
      if (state.closedState === 'closed' || state.socket === null) return;
      writeTextFrame(state.socket, JSON.stringify(payload));
    },
    onServerMessage(handler) {
      state.messageHandlers.add(handler);
      return () => state.messageHandlers.delete(handler);
    },
    nextServerMessage(predicate, opt) {
      return waitForServerMessage(state, predicate, opt?.timeoutMs ?? 1_000);
    },
    expectNoServerMessage(predicate, opt) {
      return waitForNoServerMessage(state, predicate, opt.timeoutMs, closed);
    },
    partition() {
      state.partitioned = true;
    },
    heal() {
      state.partitioned = false;
    },
    async hardClose() {
      if (state.closedState === 'closed' || state.socket === null) return;
      state.socket.end();
      await closed;
    },
    async cleanClose() {
      if (state.closedState === 'closed' || state.socket === null) return;
      writeCloseFrame(state.socket, 1_000, '');
      await closed;
    },
    closed,
    get closedState() {
      return state.closedState;
    },
    get workerId() {
      return options.workerId;
    },
  };
}

function waitForServerMessage(
  state: ClientState,
  predicate: ServerMessagePredicate,
  timeoutMs: number,
): Promise<ServerToWorkerMessage> {
  // Drain the buffer first so a message that arrived between two awaits is
  // not lost. The buffer is consumed left-to-right; non-matching entries
  // ahead of the match remain in the buffer for later waiters.
  for (let index = 0; index < state.inboundBuffer.length; index += 1) {
    const candidate = state.inboundBuffer[index]!;
    if (predicate(candidate)) {
      state.inboundBuffer.splice(index, 1);
      return Promise.resolve(candidate);
    }
  }
  return new Promise<ServerToWorkerMessage>((resolve, reject) => {
    const listener: ServerToWorkerHandler = (m) => {
      if (!predicate(m)) return;
      clearTimeout(timer);
      state.messageHandlers.delete(listener);
      // Remove the matched message from the buffer so a later waiter does
      // not also try to consume it.
      const bufferIndex = state.inboundBuffer.indexOf(m);
      if (bufferIndex !== -1) state.inboundBuffer.splice(bufferIndex, 1);
      resolve(m);
    };
    const timer = setTimeout(() => {
      state.messageHandlers.delete(listener);
      reject(new Error(`nextServerMessage timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
    state.messageHandlers.add(listener);
  });
}

function waitForNoServerMessage(
  state: ClientState,
  predicate: ServerMessagePredicate,
  timeoutMs: number,
  closed: Promise<CloseInfo>,
): Promise<void> {
  // If a matching message is already buffered from before the waiter was
  // installed, that counts as "received" — the negative assertion fails.
  for (const candidate of state.inboundBuffer) {
    if (predicate(candidate)) {
      return Promise.reject(
        new Error('expectNoServerMessage received a matching message (buffered before wait)'),
      );
    }
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      state.messageHandlers.delete(listener);
    };
    const listener: ServerToWorkerHandler = (m) => {
      if (!predicate(m)) return;
      cleanup();
      reject(new Error('expectNoServerMessage received a matching message'));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
    state.messageHandlers.add(listener);
    void closed.then(
      (info) => {
        cleanup();
        reject(
          new Error(`expectNoServerMessage saw socket close (${String(info.code)}) during wait`),
        );
        return undefined;
      },
      () => undefined,
    );
  });
}

function handleHandshakeChunk(
  state: ClientState,
  chunk: Uint8Array,
  expectedAccept: string,
  onSuccess: () => void,
  onFailure: (error: Error) => void,
): void {
  state.handshakeBuffer = concatChunks(state.handshakeBuffer, chunk);
  const decoded = new TextDecoder('utf-8').decode(state.handshakeBuffer);
  const headerEnd = decoded.indexOf('\r\n\r\n');
  if (headerEnd === -1) return;

  const headerSection = decoded.slice(0, headerEnd);
  const validation = validateHandshakeHeaders(headerSection, expectedAccept);
  if (validation !== null) {
    onFailure(validation);
    return;
  }

  state.handshakeResolved = true;
  const rest = state.handshakeBuffer.slice(headerEnd + 4);
  state.handshakeBuffer = new Uint8Array(0);
  if (rest.length > 0) {
    state.frameBuffer = concatChunks(state.frameBuffer, rest);
  }
  onSuccess();
  if (state.frameBuffer.length > 0) {
    drainFrameBuffer(state);
  }
}

function handleFrameChunk(state: ClientState, chunk: Uint8Array): void {
  state.frameBuffer = concatChunks(state.frameBuffer, chunk);
  drainFrameBuffer(state);
}

function drainFrameBuffer(state: ClientState): void {
  while (true) {
    let frame: ParsedFrame | null;
    try {
      frame = tryParseFrame(state.frameBuffer);
    } catch (error) {
      fail(state, error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (frame === null) return;
    state.frameBuffer = state.frameBuffer.slice(frame.consumed);
    onFrame(state, frame);
  }
}

function onFrame(state: ClientState, frame: ParsedFrame): void {
  if (!frame.fin || frame.opcode === OPCODE_CONTINUATION) {
    fail(state, new Error('Fragmented WebSocket frames are not supported by the test helper'));
    return;
  }

  switch (frame.opcode) {
    case OPCODE_TEXT:
      onTextFrame(state, frame.payload);
      return;
    case OPCODE_BINARY:
      fail(state, new Error('Binary WebSocket frames are not supported by the test helper'));
      return;
    case OPCODE_PING:
      if (state.socket !== null && state.closedState === 'open') {
        writePongFrame(state.socket, frame.payload);
      }
      return;
    case OPCODE_PONG:
      return;
    case OPCODE_CLOSE:
      onCloseFrame(state, frame.payload);
      return;
    default:
      fail(state, new Error(`Unsupported WebSocket opcode 0x${frame.opcode.toString(16)}`));
  }
}

function onTextFrame(state: ClientState, payload: Uint8Array): void {
  if (state.partitioned) return;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    fail(state, new Error('Server sent a non-UTF-8 text frame'));
    return;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    fail(state, new Error(`Server sent invalid JSON: ${text}`));
    return;
  }
  const parsed = parseServerToWorkerMessage(parsedJson);
  if (!parsed.ok) {
    fail(state, new Error(`Server sent an unparseable protocol message: ${parsed.error.message}`));
    return;
  }
  state.anyInboundHandler?.(parsed.message);
  // Buffer every parsed message so callers that install a
  // `nextServerMessage` waiter after the frame already arrived can still
  // see it. `nextServerMessage` drains the buffer of matching entries
  // before installing its handler.
  state.inboundBuffer.push(parsed.message);
  for (const handler of Array.from(state.messageHandlers)) {
    handler(parsed.message);
  }
}

function onCloseFrame(state: ClientState, payload: Uint8Array): void {
  const closeInfo = parseCloseFrame(payload);
  if (state.socket !== null && state.closedState === 'open') {
    writeCloseFrame(state.socket, closeInfo.code, closeInfo.reason);
    endSocketSafely(state.socket);
  }
  finalizeClose(state, closeInfo);
}

function parseCloseFrame(payload: Uint8Array): CloseInfo {
  if (payload.length < 2) return { code: 1005, reason: '' };
  const code = (payload[0]! << 8) | payload[1]!;
  const reason =
    payload.length > 2 ? new TextDecoder('utf-8', { fatal: false }).decode(payload.slice(2)) : '';
  return { code, reason };
}

function fail(state: ClientState, error: Error): void {
  state.pendingError = error;
  if (state.socket !== null && state.closedState === 'open') {
    endSocketSafely(state.socket);
  }
  finalizeClose(state, { code: 1002, reason: error.message });
}

function finalizeClose(state: ClientState, info: CloseInfo): void {
  if (state.closedState === 'closed') return;
  state.closedState = 'closed';
  for (const resolver of state.closeResolvers.splice(0)) {
    resolver(info);
  }
}
