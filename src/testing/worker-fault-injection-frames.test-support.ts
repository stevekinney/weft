/**
 * Minimal RFC 6455 WebSocket frame primitives used by the fault-injecting
 * worker client. Test-only; not re-exported from `src/testing/index.ts`.
 *
 * @internal
 */

import type { Socket } from 'bun';

export const OPCODE_CONTINUATION = 0x0;
export const OPCODE_TEXT = 0x1;
export const OPCODE_BINARY = 0x2;
export const OPCODE_CLOSE = 0x8;
export const OPCODE_PING = 0x9;
export const OPCODE_PONG = 0xa;

const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Base64-encode bytes for the WebSocket handshake key. */
export function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Generate a random 16-byte WebSocket handshake key, base64-encoded per RFC 6455. */
export function generateHandshakeKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64Encode(bytes);
}

/** Compute the expected `Sec-WebSocket-Accept` SHA-1+base64 value for a handshake key. */
export async function computeHandshakeAccept(key: string): Promise<string> {
  const inputBytes = new TextEncoder().encode(key + HANDSHAKE_GUID);
  const digest = await crypto.subtle.digest('SHA-1', inputBytes);
  return base64Encode(new Uint8Array(digest));
}

/** Validate the server's HTTP/1.1 101 Switching Protocols response. Returns an Error on failure, null on success. */
export function validateHandshakeHeaders(
  headerSection: string,
  expectedAccept: string,
): Error | null {
  const lines = headerSection.split('\r\n');
  const statusLine = lines[0] ?? '';
  if (!statusLine.startsWith('HTTP/1.1 101 ')) {
    return new Error(`WebSocket handshake failed: ${statusLine}`);
  }
  const headers = new Map<string, string>();
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  if ((headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
    return new Error('WebSocket handshake missing or invalid Upgrade header');
  }
  if (headers.get('sec-websocket-accept') !== expectedAccept) {
    return new Error('WebSocket handshake Sec-WebSocket-Accept mismatch');
  }
  return null;
}

/**
 * Parsed application or control frame returned by {@link tryParseFrame}.
 *
 * @example
 * ```ts
 * import type { ParsedFrame, OPCODE_TEXT } from './worker-fault-injection-frames.test-support.ts';
 * declare const frame: ParsedFrame;
 * if (frame.opcode === 0x1) void frame.payload;
 * ```
 */
export type ParsedFrame = {
  opcode: number;
  fin: boolean;
  payload: Uint8Array;
  consumed: number;
};

/**
 * Concatenate two `Uint8Array` chunks; used by the rolling read buffer.
 *
 * @example
 * ```ts
 * import { concatChunks } from './worker-fault-injection-frames.test-support.ts';
 * const merged = concatChunks(new Uint8Array([1, 2]), new Uint8Array([3]));
 * ```
 */
export function concatChunks(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}

/**
 * Parse a single WebSocket frame from the start of `buffer`. Returns `null`
 * when the buffer holds an incomplete frame. Throws on masked server frames
 * (a protocol violation per RFC 6455 §5.1).
 *
 * @example
 * ```ts
 * import { tryParseFrame } from './worker-fault-injection-frames.test-support.ts';
 * const frame = tryParseFrame(new Uint8Array([0x81, 0x00]));
 * ```
 */
export function tryParseFrame(buffer: Uint8Array): ParsedFrame | null {
  if (buffer.length < 2) return null;

  const firstByte = buffer[0]!;
  const secondByte = buffer[1]!;
  const fin = (firstByte & 0x80) !== 0;
  const opcode = firstByte & 0x0f;
  const masked = (secondByte & 0x80) !== 0;
  if (masked) {
    throw new Error('Server sent a masked frame, which is a protocol violation');
  }

  let payloadLength = secondByte & 0x7f;
  let cursor = 2;
  if (payloadLength === 126) {
    if (buffer.length < cursor + 2) return null;
    payloadLength = (buffer[cursor]! << 8) | buffer[cursor + 1]!;
    cursor += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < cursor + 8) return null;
    let extended = 0n;
    for (let index = 0; index < 8; index += 1) {
      extended = (extended << 8n) | BigInt(buffer[cursor + index]!);
    }
    if (extended > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('WebSocket frame payload length exceeds Number.MAX_SAFE_INTEGER');
    }
    payloadLength = Number(extended);
    cursor += 8;
  }

  if (buffer.length < cursor + payloadLength) return null;
  const payload = buffer.slice(cursor, cursor + payloadLength);
  return { opcode, fin, payload, consumed: cursor + payloadLength };
}

/**
 * Apply a 4-byte mask to a payload per RFC 6455 §5.3. Returns a fresh array
 * so the caller can reuse the input buffer.
 *
 * @example
 * ```ts
 * import { maskPayload } from './worker-fault-injection-frames.test-support.ts';
 * const masked = maskPayload(new Uint8Array([1]), new Uint8Array([0xff, 0, 0, 0]));
 * ```
 */
export function maskPayload(payload: Uint8Array, mask: Uint8Array): Uint8Array {
  const masked = new Uint8Array(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index]! ^ mask[index % 4]!;
  }
  return masked;
}

/**
 * Build a client → server WebSocket frame: FIN=1, masked. The mask is
 * randomized per call.
 *
 * @example
 * ```ts
 * import { buildClientFrame, OPCODE_TEXT } from './worker-fault-injection-frames.test-support.ts';
 * const frame = buildClientFrame(OPCODE_TEXT, new TextEncoder().encode('hello'));
 * ```
 */
export function buildClientFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const mask = new Uint8Array(4);
  crypto.getRandomValues(mask);
  const masked = maskPayload(payload, mask);

  let header: Uint8Array;
  const length = payload.length;
  if (length < 126) {
    header = new Uint8Array(2);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | length;
  } else if (length < 0x1_0000) {
    header = new Uint8Array(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header[2] = (length >> 8) & 0xff;
    header[3] = length & 0xff;
  } else {
    header = new Uint8Array(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    let remaining = BigInt(length);
    for (let index = 9; index >= 2; index -= 1) {
      header[index] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
  }

  const frame = new Uint8Array(header.length + 4 + masked.length);
  frame.set(header, 0);
  frame.set(mask, header.length);
  frame.set(masked, header.length + 4);
  return frame;
}

/** Write a text frame on the underlying TCP socket. */
export function writeTextFrame(socket: Socket, text: string): void {
  socket.write(buildClientFrame(OPCODE_TEXT, new TextEncoder().encode(text)));
}

/** Write a pong frame echoing the server's ping payload. */
export function writePongFrame(socket: Socket, payload: Uint8Array): void {
  socket.write(buildClientFrame(OPCODE_PONG, payload));
}

/** Write a close frame with the given code and reason. */
export function writeCloseFrame(socket: Socket, code: number, reason: string): void {
  const reasonBytes = new TextEncoder().encode(reason);
  const payload = new Uint8Array(2 + reasonBytes.length);
  payload[0] = (code >> 8) & 0xff;
  payload[1] = code & 0xff;
  payload.set(reasonBytes, 2);
  socket.write(buildClientFrame(OPCODE_CLOSE, payload));
}
