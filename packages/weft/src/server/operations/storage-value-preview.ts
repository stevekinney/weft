/**
 * The preview of one raw storage value: its size, what kind of value it is, and at most its first
 * {@link STORAGE_VALUE_PREVIEW_BYTES} as text, so a storage browser can show a very large value
 * without moving all of it. The raw `GET /v1/storage/:key` still returns every byte, which is what
 * a copy of the value reads.
 *
 * @module storage-value-preview
 */

/** The most bytes of a value a preview carries: 64 KB. */
export const STORAGE_VALUE_PREVIEW_BYTES = 64 * 1024;

/**
 * What a whole value is, judged on every byte of it, never on the preview alone:
 *
 * - `json`: UTF-8 text that parses as one JSON value.
 * - `text`: UTF-8 text that is not JSON (an empty value is text).
 * - `binary`: bytes that are not valid UTF-8, which carry no preview.
 */
export type StorageValueFormat = 'json' | 'text' | 'binary';

/** One value's preview. */
export interface StorageValuePreview {
  /** The size of the whole value, in bytes. */
  readonly byteLength: number;
  /** What the whole value is. */
  readonly format: StorageValueFormat;
  /**
   * The value's first bytes as text, cut back to the last whole character at or before
   * {@link STORAGE_VALUE_PREVIEW_BYTES}, or `null` for a binary value.
   */
  readonly preview: string | null;
  /** True when {@link StorageValuePreview.preview} is shorter than the value. */
  readonly truncated: boolean;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/** Whether `byte` continues a multi-byte UTF-8 character (`10xxxxxx`). */
function isContinuationByte(byte: number): boolean {
  return (byte & 0b1100_0000) === 0b1000_0000;
}

/**
 * The length of the longest prefix of `value` no longer than `limit` that ends on a character
 * boundary, so a cut never splits a multi-byte character into something that is not UTF-8.
 */
function characterBoundary(value: Uint8Array, limit: number): number {
  if (value.byteLength <= limit) return value.byteLength;
  let end = limit;
  // A UTF-8 character is at most four bytes, so at most three continuation bytes are stepped over.
  while (end > 0 && end > limit - 3 && isContinuationByte(value[end] ?? 0)) end -= 1;
  return end;
}

function isJson(text: string): boolean {
  if (text.trim().length === 0) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Previews one raw value. The format is judged on the whole value; the preview is its first
 * {@link STORAGE_VALUE_PREVIEW_BYTES} at most, cut on a character boundary.
 *
 * @example
 * ```ts
 * import { previewStorageValue } from './storage-value-preview.ts';
 *
 * const preview = previewStorageValue(new TextEncoder().encode('{"dismissed":true}'));
 * console.log(preview.format, preview.truncated); // 'json' false
 * ```
 */
export function previewStorageValue(value: Uint8Array): StorageValuePreview {
  let text: string;
  try {
    text = strictUtf8.decode(value);
  } catch {
    return { byteLength: value.byteLength, format: 'binary', preview: null, truncated: false };
  }
  const format: StorageValueFormat = isJson(text) ? 'json' : 'text';
  if (value.byteLength <= STORAGE_VALUE_PREVIEW_BYTES) {
    return { byteLength: value.byteLength, format, preview: text, truncated: false };
  }
  const end = characterBoundary(value, STORAGE_VALUE_PREVIEW_BYTES);
  return {
    byteLength: value.byteLength,
    format,
    preview: strictUtf8.decode(value.subarray(0, end)),
    truncated: true,
  };
}
