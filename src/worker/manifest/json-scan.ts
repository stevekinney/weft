/**
 * Duplicate-key detection for JSON text.
 *
 * `JSON.parse` resolves `{"a":1,"a":2}` to `{a: 2}` silently. For a manifest
 * that is unacceptable: two peers reading the same bytes could disagree about
 * which artifact digest a worker claimed, and a digest computed after parsing
 * would attest to only one of them. Duplicate keys are therefore rejected
 * while the text is still text.
 *
 * The scanner is a structural pass, not a full parser — it locates strings and
 * object boundaries well enough to collect key names per object, and leaves
 * every other validity question to `JSON.parse`, which runs afterwards.
 *
 * @module worker/manifest/json-scan
 */

import { MAX_JSON_SCAN_NESTING_DEPTH } from './limits.ts';

/**
 * Read a JSON string literal starting at the opening quote.
 *
 * Returns the decoded key text and the index just past the closing quote.
 * Escapes only need to be handled well enough to not mistake an escaped quote
 * for the end of the string; `JSON.parse` validates the rest.
 */
function readString(text: string, start: number): { value: string; next: number } | undefined {
  let value = '';
  let index = start + 1;

  while (index < text.length) {
    const char = text[index] as string;

    if (char === '\\') {
      const escaped = text[index + 1];
      if (escaped === undefined) return undefined;
      // Preserve the escape verbatim. Two keys that differ only in escaping
      // ("a" vs "a") are the same key once parsed, so decode the common
      // single-character escapes and unicode escapes to compare like for like.
      if (escaped === 'u') {
        const hex = text.slice(index + 2, index + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
        const code = Number.parseInt(hex, 16);
        value += String.fromCharCode(code);
        index += 6;
        continue;
      }
      const simple: Record<string, string> = {
        '"': '"',
        '\\': '\\',
        '/': '/',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
      };
      const decoded = simple[escaped];
      if (decoded === undefined) return undefined;
      value += decoded;
      index += 2;
      continue;
    }

    if (char === '"') return { value, next: index + 1 };

    value += char;
    index += 1;
  }

  return undefined;
}

/**
 * Report the first duplicate key in JSON text, or `undefined` when every
 * object has unique keys.
 *
 * Malformed text yields `undefined` rather than a diagnosis: this pass only
 * answers the duplicate-key question, and `JSON.parse` gives a better message
 * for everything else. Text nested deeper than
 * {@link MAX_JSON_SCAN_NESTING_DEPTH} is treated the same way — the scan
 * bails before the open-container stack can grow without bound.
 */
export function findDuplicateJsonKey(text: string): string | undefined {
  // One key set per open object. Arrays push a placeholder so depth tracking
  // stays aligned without collecting anything.
  const stack: (Set<string> | undefined)[] = [];
  let expectKey = false;
  let index = 0;

  while (index < text.length) {
    const char = text[index] as string;

    if (char === '"') {
      const parsed = readString(text, index);
      if (parsed === undefined) return undefined;

      if (expectKey) {
        const keys = stack[stack.length - 1];
        if (keys !== undefined) {
          if (keys.has(parsed.value)) return parsed.value;
          keys.add(parsed.value);
        }
        expectKey = false;
      }

      index = parsed.next;
      continue;
    }

    if ((char === '{' || char === '[') && stack.length >= MAX_JSON_SCAN_NESTING_DEPTH) {
      return undefined;
    }

    expectKey = applyStructuralCharacter(char, stack, expectKey);
    index += 1;
  }

  return undefined;
}

/**
 * Apply one structural character to the open-container stack and report
 * whether the next string encountered will be an object key.
 */
function applyStructuralCharacter(
  char: string,
  stack: (Set<string> | undefined)[],
  expectKey: boolean,
): boolean {
  switch (char) {
    case '{':
      stack.push(new Set<string>());
      return true;
    case '[':
      stack.push(undefined);
      return false;
    case '}':
    case ']':
      stack.pop();
      return false;
    case ',':
      // A comma inside an object introduces the next key; inside an array it
      // introduces the next element.
      return stack[stack.length - 1] !== undefined;
    default:
      return expectKey;
  }
}
