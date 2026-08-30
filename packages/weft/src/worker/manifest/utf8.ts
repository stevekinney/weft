/**
 * UTF-8 byte measurement for manifest bounds.
 *
 * Manifest limits are expressed in bytes rather than code units so a worker
 * cannot smuggle several times the intended payload through astral-plane
 * characters, each of which costs one UTF-16 `.length` but four UTF-8 bytes.
 *
 * @module worker/manifest/utf8
 */

const encoder = new TextEncoder();

/** UTF-8 byte length of a string. */
export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

/** Encode a string to UTF-8 bytes. */
export function utf8Encode(value: string): Uint8Array {
  return encoder.encode(value);
}
