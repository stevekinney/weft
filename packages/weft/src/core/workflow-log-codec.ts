/**
 * The persisted form of a run's `ctx.log` lines (COR-1811): the public line and result shapes, the
 * bounds' defaults, the cuts that keep a line within its budget, and the decoders for a stored
 * line and a stored counter. {@link createWorkflowLogStore} in `workflow-log-store.ts` composes
 * them into the sink, the reader, and the retention pass.
 *
 * @module core/workflow-log-codec
 */

import type { WorkflowLogLevel } from './types/workflow-log.ts';

/** How many lines a run keeps when the host does not say. */
export const DEFAULT_MAXIMUM_LOG_LINES_PER_RUN = 500;

/**
 * The most lines a run may be allowed to keep, whatever the host asks for: it keeps one write of
 * a run's lines, with its evictions and counter, inside a storage backend's batch limit.
 */
export const MAXIMUM_LOG_LINES_PER_RUN_LIMIT = 5000;

/** How many bytes a line's message, and its attributes, may take when the host does not say. */
export const DEFAULT_MAXIMUM_LOG_LINE_BYTES = 2048;

/** What a cut message ends with, so a reader can see it was cut. */
export const WORKFLOW_LOG_TRUNCATION_MARKER = '… [truncated]';

const LEVELS: ReadonlySet<string> = new Set<WorkflowLogLevel>(['debug', 'info', 'warn', 'error']);
export const ENCODER = new TextEncoder();
export const DECODER = new TextDecoder();

/**
 * One persisted `ctx.log` line, as {@link WorkflowLogStore.read} and `Engine.getLogs` return it.
 *
 * @example
 * ```ts
 * import type { WorkflowLogLine } from '@lostgradient/weft';
 * const describeLine = (line: WorkflowLogLine) => `${line.sequence} ${line.level} ${line.message}`;
 * ```
 */
export interface WorkflowLogLine {
  /** The line's position among the run's lines, counted from zero and never reused. */
  readonly sequence: number;
  /**
   * The index of the durable step the workflow body was about to run when it logged, or `null`
   * for a line stored without one (written before lines carried a step).
   */
  readonly step: number | null;
  /** The severity the workflow logged at. */
  readonly level: WorkflowLogLevel;
  /** The message, cut with {@link WORKFLOW_LOG_TRUNCATION_MARKER} when it was too long. */
  readonly message: string;
  /** Milliseconds since the epoch at which the line was logged. */
  readonly timestamp: number;
  /** The workflow type that logged the line. */
  readonly workflowType: string;
  /** The attributes the workflow logged, absent when it logged none or they could not be kept. */
  readonly attributes?: Record<string, unknown>;
  /** Whether the message was cut, or the attributes were dropped for size or because they could not be stored. */
  readonly truncated: boolean;
}

/**
 * What {@link WorkflowLogStore.read} and `Engine.getLogs` answer: the lines still kept, oldest
 * first, and how many lines the run lost to the per-run cap.
 *
 * @example
 * ```ts
 * import type { WorkflowLogsResult } from '@lostgradient/weft';
 * const summary = (result: WorkflowLogsResult) => `${result.lines.length} kept, ${result.dropped} dropped`;
 * ```
 */
export interface WorkflowLogsResult {
  /** The kept lines, oldest first, narrowed to one step when the read asked for it. */
  readonly lines: WorkflowLogLine[];
  /** How many of the run's lines the cap evicted or retention removed, whatever step the read narrowed to. */
  readonly dropped: number;
}

/** The counter record of one run's lines. */
export interface Counter {
  /** The sequence the next line takes. */
  next: number;
  /** The sequence of the oldest line that may still be kept. */
  first: number;
  /** Lines evicted by the cap or removed by retention. */
  dropped: number;
  /** When the run last wrote a line, on the store's clock. */
  updatedAt: number;
}

/** A buffered line, not yet given a sequence. */
export interface PendingLine {
  readonly step: number | null;
  readonly level: WorkflowLogLevel;
  readonly message: string;
  readonly timestamp: number;
  readonly workflowType: string;
  readonly attributes?: string;
  readonly truncated: boolean;
}

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** `message`, cut on a code point boundary to at most `maximumBytes`, ending in the marker when cut. */
export function cutMessage(
  message: string,
  maximumBytes: number,
): { readonly text: string; readonly cut: boolean } {
  if (ENCODER.encode(message).byteLength <= maximumBytes) return { text: message, cut: false };
  const room = Math.max(
    0,
    maximumBytes - ENCODER.encode(WORKFLOW_LOG_TRUNCATION_MARKER).byteLength,
  );
  let used = 0;
  let text = '';
  for (const character of message) {
    const width = utf8Length(character.codePointAt(0) ?? 0);
    if (used + width > room) break;
    used += width;
    text += character;
  }
  return { text: text + WORKFLOW_LOG_TRUNCATION_MARKER, cut: true };
}

/** The attributes as JSON, or `undefined` when there are none, they cannot be stored, or they are too large. */
export function serializeAttributes(
  attributes: Record<string, unknown> | undefined,
  maximumBytes: number,
): { readonly json: string | undefined; readonly dropped: boolean } {
  if (attributes === undefined) return { json: undefined, dropped: false };
  try {
    const json = JSON.stringify(attributes);
    if (json === undefined || ENCODER.encode(json).byteLength > maximumBytes) {
      return { json: undefined, dropped: true };
    }
    return { json, dropped: false };
  } catch {
    return { json: undefined, dropped: true };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(DECODER.decode(bytes));
  } catch {
    return undefined;
  }
}

export function decodeCounter(bytes: Uint8Array | null): Counter | undefined {
  if (bytes === null) return undefined;
  const value = parseJson(bytes);
  if (!isPlainObject(value)) return undefined;
  const { next, first, dropped, updatedAt } = value;
  if (
    !isNonNegativeInteger(next) ||
    !isNonNegativeInteger(first) ||
    !isNonNegativeInteger(dropped) ||
    typeof updatedAt !== 'number'
  ) {
    return undefined;
  }
  return { next, first, dropped, updatedAt };
}

export function decodeLine(sequence: number, bytes: Uint8Array): WorkflowLogLine | undefined {
  const value = parseJson(bytes);
  if (!isPlainObject(value)) return undefined;
  const { level, message, timestamp, workflowType, step, attributes, truncated } = value;
  if (
    typeof level !== 'string' ||
    !LEVELS.has(level) ||
    typeof message !== 'string' ||
    typeof timestamp !== 'number'
  ) {
    return undefined;
  }
  return {
    sequence,
    step: isNonNegativeInteger(step) ? step : null,
    level: level as WorkflowLogLevel,
    message,
    timestamp,
    workflowType: typeof workflowType === 'string' ? workflowType : '',
    ...(isPlainObject(attributes) && { attributes }),
    truncated: truncated === true,
  };
}

/** The sequence a line key ends with, or `undefined` for a key that is not a line of `prefix`. */
export function sequenceOfKey(prefix: string, key: string): number | undefined {
  if (!key.startsWith(prefix)) return undefined;
  const tail = key.slice(prefix.length);
  if (!/^\d+$/.test(tail)) return undefined;
  const sequence = Number(tail);
  return Number.isSafeInteger(sequence) ? sequence : undefined;
}
