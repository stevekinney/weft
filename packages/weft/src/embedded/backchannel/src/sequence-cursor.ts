/**
 * Sequence cursors: the opaque cursor of a sequenced event feed (a non-negative sequence to the feed,
 * a string to a client), and the parser of a cursor-like query value. Imports nothing, so every feed
 * and transport can share it.
 *
 * @module server/sequence-cursor
 */

export interface ParsedSequenceCursor {
  error?: string;
  value?: number;
}

const DECIMAL_INTEGER_PATTERN = /^-?\d+$/;

/** Reads an optional cursor from a request parameter, or reports it as invalid. */
export function parseOptionalSequenceCursor(
  rawValue: string | null | undefined,
  parameterName: string,
): ParsedSequenceCursor {
  if (rawValue === null || rawValue === undefined) {
    return {};
  }

  if (rawValue.trim().length === 0) {
    return {
      error: `Invalid ${parameterName}: ${rawValue}`,
    };
  }

  if (!DECIMAL_INTEGER_PATTERN.test(rawValue)) {
    return {
      error: `Invalid ${parameterName}: ${rawValue}`,
    };
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < -1) {
    return {
      error: `Invalid ${parameterName}: ${rawValue}`,
    };
  }

  return { value };
}

/**
 * Opaque cursor into a workflow or fleet event feed. Durable workflow and
 * fleet feeds use numeric cursors; in-memory backends use an incarnation and
 * sequence so a reconnect after restart can report a gap. Pass the cursor
 * back as `fromCursor` to resume a feed, and never parse it in a client.
 *
 * @example
 * ```ts
 * import type { Cursor } from '@lostgradient/backchannel';
 * import type { EventEnvelope } from '@lostgradient/weft';
 *
 * declare const envelope: EventEnvelope;
 * const lastCursor: Cursor = envelope.cursor;
 * void lastCursor;
 * ```
 */
export type Cursor = string;

const CURSOR_PATTERN = /^(?:-1|\d+)$/;

/** Encode a non-negative integer sequence as an opaque cursor. */
export function encodeCursor(sequence: number): Cursor {
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new Error(`encodeCursor: sequence must be a non-negative integer, got ${sequence}`);
  }
  return String(sequence);
}

/**
 * Decode an opaque cursor back to its sequence. `-1` is the initial
 * sentinel for "before the first event"; malformed input returns null.
 */
export function decodeCursor(cursor: Cursor): number | null {
  if (!CURSOR_PATTERN.test(cursor)) return null;
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < -1) return null;
  return value;
}

function decodeCursorOrThrow(cursor: Cursor): number {
  const sequence = decodeCursor(cursor);
  if (sequence === null) throw new Error('Invalid cursor');
  return sequence;
}

/** Compares two cursors by sequence position. */
export function compareCursor(a: Cursor, b: Cursor): 'before' | 'at' | 'after' {
  const delta = decodeCursorOrThrow(a) - decodeCursorOrThrow(b);
  return delta === 0 ? 'at' : delta < 0 ? 'before' : 'after';
}

/** An event envelope a replay-and-live feed can order: its sequence and its cursor. */
export type SequencedEventEnvelope = {
  /** The envelope's position in the log. */
  readonly sequence: number;
  /** The opaque token a consumer passes back to resume after this envelope. */
  readonly cursor: Cursor;
};
