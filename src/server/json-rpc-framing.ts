/**
 * Shared newline-delimited framing helper for JSON-RPC over stdio.
 *
 * Both the MCP stdio transport (`src/ai/mcp/transport-stdio.ts`) and the
 * runtime stdio subcommand (Phase 13) consume this. Phase 6 locked in
 * the framing contract against the inline buffer logic in
 * `StdioTransport.#startReadLoop`; Phase 7 (this module) extracts that
 * logic into one pure function that both transports call.
 *
 * Contract:
 *   - Input:  `buffer` (leftover from the previous call) + `chunk` (new
 *             bytes decoded to string).
 *   - Output: an array of `lines` (complete, newline-terminated, trimmed,
 *             non-empty) plus a `buffer` to feed into the next call.
 *   - Split:  on `\n`. `\r` is treated as surrounding whitespace and
 *             trimmed — standard `trim()` behavior. CRLF framing works
 *             transparently.
 *   - Blanks: lines that are empty after `trim()` are silently dropped.
 *             They are framing artifacts, not empty payloads — if every
 *             caller had to filter them, eventually one would forget and
 *             log a malformed-JSON warning on a legitimately blank frame.
 *
 * Pure: no I/O, no allocations beyond the returned arrays/string, no
 * state. Safe to call from any context.
 */

export type FramingResult = {
  readonly lines: ReadonlyArray<string>;
  readonly buffer: string;
};

/**
 * Append `chunk` to `buffer`, split off every complete newline-terminated
 * frame, and return the extracted lines plus the leftover buffer.
 *
 * Lines are trimmed; empty lines (after trim) are dropped silently.
 */
export function splitNewlineDelimitedBuffer(buffer: string, chunk: string): FramingResult {
  let working = buffer + chunk;
  const lines: string[] = [];
  let newlineIndex = working.indexOf('\n');
  while (newlineIndex !== -1) {
    const line = working.slice(0, newlineIndex).trim();
    working = working.slice(newlineIndex + 1);
    if (line.length > 0) lines.push(line);
    newlineIndex = working.indexOf('\n');
  }
  return { lines, buffer: working };
}
