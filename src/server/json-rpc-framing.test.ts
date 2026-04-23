/**
 * Tests for `splitNewlineDelimitedBuffer` — the shared newline-delimited
 * framing helper that both the MCP stdio transport
 * (`src/ai/mcp/transport-stdio.ts`) and the runtime stdio subcommand
 * (`src/server/stdio-session.ts`, Phase 13) consume.
 *
 * Phase 6 locked in a character-table of framing behavior against the
 * inline buffer logic inside `StdioTransport.#startReadLoop`. Phase 7
 * extracts that logic into this pure function — the tests below cover
 * the same character table at the unit level so a regression in the
 * shared helper breaks here BEFORE it reaches either transport.
 */

import { describe, expect, it } from 'bun:test';

import { splitNewlineDelimitedBuffer } from './json-rpc-framing.ts';

describe('splitNewlineDelimitedBuffer', () => {
  it('splits a single complete line and returns an empty remainder', () => {
    const result = splitNewlineDelimitedBuffer('', 'hello\n');
    expect(result.lines).toEqual(['hello']);
    expect(result.buffer).toBe('');
  });

  it('returns an empty lines array when no newline is present', () => {
    const result = splitNewlineDelimitedBuffer('', 'partial');
    expect(result.lines).toEqual([]);
    expect(result.buffer).toBe('partial');
  });

  it('accumulates partial lines across calls', () => {
    const first = splitNewlineDelimitedBuffer('', 'par');
    expect(first.lines).toEqual([]);
    expect(first.buffer).toBe('par');

    const second = splitNewlineDelimitedBuffer(first.buffer, 'tial\n');
    expect(second.lines).toEqual(['partial']);
    expect(second.buffer).toBe('');
  });

  it('splits multiple complete lines in a single chunk', () => {
    const result = splitNewlineDelimitedBuffer('', 'one\ntwo\nthree\n');
    expect(result.lines).toEqual(['one', 'two', 'three']);
    expect(result.buffer).toBe('');
  });

  it('keeps the trailing partial line in the buffer when the last chunk has no newline', () => {
    const result = splitNewlineDelimitedBuffer('', 'one\ntwo\nthr');
    expect(result.lines).toEqual(['one', 'two']);
    expect(result.buffer).toBe('thr');
  });

  it('reassembles lines split across chunk boundaries', () => {
    let buffer = '';
    const lines: string[] = [];
    for (const chunk of ['{"id":', '1,"res', 'ult":"ok"}\n']) {
      const result = splitNewlineDelimitedBuffer(buffer, chunk);
      buffer = result.buffer;
      lines.push(...result.lines);
    }
    expect(lines).toEqual(['{"id":1,"result":"ok"}']);
    expect(buffer).toBe('');
  });

  it('trims CRLF (\\r\\n) line endings to just the content', () => {
    // The reader splits on `\n`; the trailing `\r` is part of the line
    // content before the split, so it must be trimmed. Otherwise
    // `JSON.parse` on a line ending with `\r` may still succeed (the
    // `\r` is whitespace) but downstream string-equality checks fail.
    const result = splitNewlineDelimitedBuffer('', 'hello\r\nworld\r\n');
    expect(result.lines).toEqual(['hello', 'world']);
    expect(result.buffer).toBe('');
  });

  it('trims surrounding whitespace on each line', () => {
    const result = splitNewlineDelimitedBuffer('', '  spaced  \ntabbed\t\n');
    expect(result.lines).toEqual(['spaced', 'tabbed']);
  });

  it('skips empty lines (after trim) so callers do not see framing artifacts', () => {
    // Blank lines between frames are framing artifacts, not empty
    // payloads. They must not appear in `lines` — otherwise every
    // consumer has to filter them, and one that forgets logs a
    // "malformed JSON" warning on a legitimately blank frame.
    const result = splitNewlineDelimitedBuffer('', '\n\none\n   \ntwo\n');
    expect(result.lines).toEqual(['one', 'two']);
    expect(result.buffer).toBe('');
  });

  it('does not emit a trailing empty line when the chunk ends with a newline', () => {
    const result = splitNewlineDelimitedBuffer('', 'done\n');
    expect(result.lines).toEqual(['done']);
    expect(result.buffer).toBe('');
  });

  it('handles a chunk that is only a single newline', () => {
    const result = splitNewlineDelimitedBuffer('existing', '\n');
    expect(result.lines).toEqual(['existing']);
    expect(result.buffer).toBe('');
  });

  it('absorbs a single oversize line (~1 MB) without corruption', () => {
    const payload = 'x'.repeat(1024 * 1024);
    const result = splitNewlineDelimitedBuffer('', payload + '\n');
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toBe(payload);
    expect(result.buffer).toBe('');
  });

  it('preserves an incomplete oversize line in the buffer for the next call', () => {
    const payload = 'y'.repeat(1024 * 1024);
    const result = splitNewlineDelimitedBuffer('', payload);
    expect(result.lines).toEqual([]);
    expect(result.buffer.length).toBe(1024 * 1024);
  });

  it('is pure — repeat calls with the same inputs produce equal outputs', () => {
    const a = splitNewlineDelimitedBuffer('prefix', 'rest\nnext');
    const b = splitNewlineDelimitedBuffer('prefix', 'rest\nnext');
    expect(a).toEqual(b);
  });
});
