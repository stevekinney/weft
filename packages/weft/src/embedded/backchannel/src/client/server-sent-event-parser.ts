/**
 * One Server-Sent Events message: its optional `id` and `event` fields and its
 * `data`, with multiple `data` lines joined by a newline.
 *
 * @example
 * ```ts
 * import type { ServerSentEventFrame } from '@lostgradient/backchannel/client';
 *
 * const frame: ServerSentEventFrame = { id: '7', event: 'ping', data: '{"replayComplete":true}' };
 * console.log(frame.event);
 * ```
 */
export type ServerSentEventFrame = {
  /** The `id` field: the cursor to resume after this message. */
  readonly id?: string;
  /** The `event` field; absent for the default `message` event. */
  readonly event?: string;
  /** The `data` field. */
  readonly data: string;
};

/**
 * What {@link parseServerSentEventChunk} found in a chunk: the complete frames,
 * and the text of a frame that has not finished, which the next call takes as
 * its `previousRemainder`.
 *
 * @example
 * ```ts
 * import { parseServerSentEventChunk } from '@lostgradient/backchannel/client';
 *
 * const { frames, remainder } = parseServerSentEventChunk('data: one\n\ndata: tw');
 * console.log(frames.length, remainder); // 1 data: tw
 * ```
 */
export type ServerSentEventParseResult = {
  /** The complete frames, in order. */
  readonly frames: ReadonlyArray<ServerSentEventFrame>;
  /** The unfinished tail. */
  readonly remainder: string;
};

type ServerSentEventFrameParts = {
  id: string | undefined;
  event: string | undefined;
  dataLines: string[];
};

/**
 * Split a chunk of an event stream into frames. Pass each chunk's `remainder`
 * back as the next call's `previousRemainder`, so a frame that arrives in two
 * chunks is read once, whole. Comments and unknown fields are ignored, and a
 * frame with no field at all is dropped.
 *
 * @example
 * ```ts
 * import { parseServerSentEventChunk } from '@lostgradient/backchannel/client';
 *
 * const first = parseServerSentEventChunk('id: 1\ndata: {"a":');
 * const second = parseServerSentEventChunk('1}\n\n', first.remainder);
 * console.log(second.frames[0]?.data); // {"a":1}
 * ```
 */
export function parseServerSentEventChunk(
  text: string,
  previousRemainder = '',
): ServerSentEventParseResult {
  const combined = `${previousRemainder}${text}`.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const parts = combined.split('\n\n');
  const remainder = parts.pop() ?? '';
  const frames = parts.map(parseServerSentEventFrame).filter((frame) => frame !== null);
  return { frames, remainder };
}

function parseServerSentEventFrame(block: string): ServerSentEventFrame | null {
  const parts: ServerSentEventFrameParts = {
    id: undefined,
    event: undefined,
    dataLines: [],
  };

  for (const rawLine of block.split('\n')) {
    applyServerSentEventLine(parts, rawLine);
  }

  return frameFromParts(parts);
}

function applyServerSentEventLine(parts: ServerSentEventFrameParts, rawLine: string): void {
  if (rawLine === '' || rawLine.startsWith(':')) return;
  const { field, value } = splitServerSentEventLine(rawLine);
  if (field === 'id') {
    parts.id = value;
  } else if (field === 'event') {
    parts.event = value;
  } else if (field === 'data') {
    parts.dataLines.push(value);
  }
}

function splitServerSentEventLine(rawLine: string): { field: string; value: string } {
  const separator = rawLine.indexOf(':');
  const field = separator === -1 ? rawLine : rawLine.slice(0, separator);
  const rawValue = separator === -1 ? '' : rawLine.slice(separator + 1);
  return {
    field,
    value: rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue,
  };
}

function frameFromParts(parts: ServerSentEventFrameParts): ServerSentEventFrame | null {
  if (parts.id === undefined && parts.event === undefined && parts.dataLines.length === 0) {
    return null;
  }
  return {
    ...(parts.id === undefined ? {} : { id: parts.id }),
    ...(parts.event === undefined ? {} : { event: parts.event }),
    data: parts.dataLines.join('\n'),
  };
}
