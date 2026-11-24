/**
 * COR-1472 guard: every union or list in Weft's source that names
 * `signal:received` also names `signal:waiting`, so a new enumeration of the
 * signal event kinds (an event map, a client-visible list, a notification rule
 * table, a broadcast message type) cannot quietly leave the new kind out.
 *
 * It reads source text rather than types, because several of these lists are
 * plain string arrays that no type ties to the event map. A mention counts as
 * an enumeration when it is an array element, a key (`'signal:received': …`),
 * or a member of a `|` union; a comparison or a call argument does not.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Glob } from 'bun';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const RECEIVED = /'signal:received'|"signal:received"|SignalReceivedEvent\.type/g;
const WAITING = /'signal:waiting'|"signal:waiting"|SignalWaitingEvent\.type/;
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

type Enumeration = { file: string; line: number; text: string };

/** The bracket that encloses `index`, found by scanning back over balanced pairs. */
function enclosingOpenBracket(source: string, index: number): number {
  const pending: string[] = [];
  for (let position = index - 1; position >= 0; position -= 1) {
    const character = source[position]!;
    if (character in CLOSERS) {
      pending.push(CLOSERS[character]!);
    } else if (character === '(' || character === '[' || character === '{') {
      if (pending.length === 0) return position;
      pending.pop();
    }
  }
  return -1;
}

/** The index of the bracket that closes the one opened at `open`. */
function matchingCloseBracket(source: string, open: number): number {
  let depth = 0;
  for (let position = open; position < source.length; position += 1) {
    const character = source[position]!;
    if (character === '(' || character === '[' || character === '{') depth += 1;
    if (character in CLOSERS) {
      depth -= 1;
      if (depth === 0) return position;
    }
  }
  return source.length;
}

/** Whether the mention at `[start, end)` enumerates a kind, rather than comparing or passing one. */
function isEnumeration(source: string, start: number, end: number, open: number): boolean {
  const before = source.slice(0, start).trimEnd();
  const after = source.slice(end).trimStart();
  if (before.endsWith('|') || after.startsWith('|')) return true;
  if (
    after.startsWith(':') &&
    (before.endsWith('{') || before.endsWith(',') || before.endsWith(';'))
  )
    return true;
  return open >= 0 && source[open] === '[' && (before.endsWith('[') || before.endsWith(','));
}

/** The construct a mention belongs to: its bracket, or for a bare union its statement. */
function enclosingConstruct(source: string, start: number, end: number, open: number): string {
  if (open >= 0) return source.slice(open, matchingCloseBracket(source, open) + 1);
  const statementStart = source.lastIndexOf(';', start) + 1;
  const statementEnd = source.indexOf(';', end);
  return source.slice(statementStart, statementEnd === -1 ? source.length : statementEnd);
}

function enumerationsMissingWaiting(file: string, source: string): Enumeration[] {
  const missing: Enumeration[] = [];
  for (const match of source.matchAll(RECEIVED)) {
    const start = match.index;
    const end = start + match[0].length;
    const open = enclosingOpenBracket(source, start);
    if (!isEnumeration(source, start, end, open)) continue;
    if (WAITING.test(enclosingConstruct(source, start, end, open))) continue;
    const line = source.slice(0, start).split('\n').length;
    missing.push({ file, line, text: source.split('\n')[line - 1]!.trim() });
  }
  return missing;
}

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const file of new Glob('**/*.{ts,svelte}').scanSync({ cwd: sourceRoot })) {
    if (/\.test(-d)?\.ts$|\.test-support\.ts$|\.svelte\.test\.ts$/.test(file)) continue;
    files.push(file);
  }
  return files;
}

describe('signal event kind enumerations', () => {
  it('name signal:waiting wherever they name signal:received', () => {
    const missing = sourceFiles().flatMap((file) =>
      enumerationsMissingWaiting(file, readFileSync(`${sourceRoot}${file}`, 'utf8')),
    );
    expect(missing).toEqual([]);
  });

  it('recognizes each enumeration shape and ignores comparisons', () => {
    const shapes = [
      "const kinds = ['signal:received', 'signal:delivered'] as const;",
      "type EventMap = { 'signal:received': SignalReceivedEvent; };",
      "const rules = { 'signal:received': { tier: 'info' } };",
      "type Message = { type: 'signal:received' | 'signal:delivered'; workflowId: string };",
      'const types = [SignalReceivedEvent.type, SignalDeliveredEvent.type];',
    ];
    for (const shape of shapes) {
      expect(enumerationsMissingWaiting('shape.ts', shape)).toHaveLength(1);
      const completed = shape
        .replace("'signal:received'", "'signal:received' | 'signal:waiting'")
        .replace('SignalReceivedEvent.type,', 'SignalReceivedEvent.type, SignalWaitingEvent.type,');
      expect(enumerationsMissingWaiting('shape.ts', completed)).toEqual([]);
    }

    const comparisons = [
      "if (data['type'] === 'signal:received') forward(data);",
      "broadcast({ type: 'signal:received', workflowId });",
      'tracer.startSpan(`signal:received:${name}`);',
    ];
    for (const comparison of comparisons) {
      expect(enumerationsMissingWaiting('comparison.ts', comparison)).toEqual([]);
    }
  });
});
