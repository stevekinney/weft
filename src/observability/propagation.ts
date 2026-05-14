/**
 * W3C Trace Context propagation helpers.
 *
 * Implements parsing, formatting, and injection/extraction of the
 * `traceparent` header as defined in the W3C Trace Context specification.
 *
 * @see https://www.w3.org/TR/trace-context/
 * @module propagation
 */

// ---------------------------------------------------------------------------
// Portable random hex generation (Web Crypto API, available in all runtimes)
// ---------------------------------------------------------------------------

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Parsed W3C trace context fields from a `traceparent` header.
 *
 * @example
 * ```ts
 * import { formatTraceParent, type TraceContext } from 'weft/observability';
 *
 * const context: TraceContext = {
 *   version: '00',
 *   traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
 *   spanId: '00f067aa0ba902b7',
 *   traceFlags: 1,
 * };
 * console.log(formatTraceParent(context));
 * ```
 */
export interface TraceContext {
  version: string;
  traceId: string;
  spanId: string;
  traceFlags: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRACEPARENT_HEADER = 'traceparent';
const TRACEPARENT_REGEX = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ALL_ZEROS_TRACE_ID = '00000000000000000000000000000000';
const ALL_ZEROS_SPAN_ID = '0000000000000000';

// ---------------------------------------------------------------------------
// Parsing and formatting
// ---------------------------------------------------------------------------

/**
 * Parse a W3C traceparent header string.
 *
 * @example
 * ```ts
 * import { parseTraceParent } from 'weft';
 *
 * const ctx = parseTraceParent(
 *   '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
 * );
 * console.log(ctx?.traceId);  // '4bf92f3577b34da6a3ce929d0e0e4736'
 * console.log(ctx?.traceFlags); // 1
 * ```
 */
export function parseTraceParent(value: string): TraceContext | null {
  const match = TRACEPARENT_REGEX.exec(value);

  if (!match) return null;

  const [, version, traceId, spanId, flags] = match;

  if (traceId === ALL_ZEROS_TRACE_ID) return null;
  if (spanId === ALL_ZEROS_SPAN_ID) return null;

  return {
    version: version!,
    traceId: traceId!,
    spanId: spanId!,
    traceFlags: parseInt(flags!, 16),
  };
}

/**
 * Format a TraceContext to a W3C traceparent string.
 *
 * @example
 * ```ts
 * import { formatTraceParent, generateTraceId, generateSpanId } from 'weft';
 *
 * const header = formatTraceParent({
 *   version: '00',
 *   traceId: generateTraceId(),
 *   spanId: generateSpanId(),
 *   traceFlags: 1,
 * });
 * console.log(header); // '00-<32hex>-<16hex>-01'
 * ```
 */
export function formatTraceParent(context: TraceContext): string {
  const flags = context.traceFlags.toString(16).padStart(2, '0');
  return `${context.version}-${context.traceId}-${context.spanId}-${flags}`;
}

// ---------------------------------------------------------------------------
// Header injection and extraction
// ---------------------------------------------------------------------------

/**
 * Extract and parse a `traceparent` header from a headers map.
 *
 * @example
 * ```ts
 * import { extractTraceParent } from 'weft/observability';
 *
 * const headers = new Map([
 *   ['traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
 * ]);
 * console.log(extractTraceParent(headers)?.traceId);
 * ```
 */
export function extractTraceParent(headers: Map<string, string>): TraceContext | null {
  const value = headers.get(TRACEPARENT_HEADER);
  if (!value) return null;
  return parseTraceParent(value);
}

/**
 * Format and inject a `traceparent` header into a headers map.
 *
 * @example
 * ```ts
 * import { generateSpanId, generateTraceId, injectTraceParent } from 'weft/observability';
 *
 * const headers = new Map<string, string>();
 * injectTraceParent(headers, {
 *   version: '00',
 *   traceId: generateTraceId(),
 *   spanId: generateSpanId(),
 *   traceFlags: 1,
 * });
 * console.log(headers.has('traceparent'));
 * ```
 */
export function injectTraceParent(headers: Map<string, string>, context: TraceContext): void {
  headers.set(TRACEPARENT_HEADER, formatTraceParent(context));
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a random trace ID (32 hex chars / 16 bytes).
 *
 * @example
 * ```ts
 * import { generateTraceId } from 'weft';
 *
 * const traceId = generateTraceId();
 * console.log(traceId.length);  // 32
 * console.log(/^[0-9a-f]{32}$/.test(traceId)); // true
 * ```
 */
export function generateTraceId(): string {
  return randomHex(16);
}

/**
 * Generate a random span ID (16 hex chars / 8 bytes).
 *
 * @example
 * ```ts
 * import { generateSpanId } from 'weft';
 *
 * const spanId = generateSpanId();
 * console.log(spanId.length);  // 16
 * console.log(/^[0-9a-f]{16}$/.test(spanId)); // true
 * ```
 */
export function generateSpanId(): string {
  return randomHex(8);
}
