/**
 * Encode storage bytes as base64 without relying on Node-only Buffer APIs.
 */
const BYTE_STRING_CHUNK_SIZE = 512;

/** Encode bytes as standard base64, in chunks so a large value never overflows the argument limit. */
export function encodeBytesToBase64(value: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += BYTE_STRING_CHUNK_SIZE) {
    chunks.push(String.fromCharCode(...value.subarray(offset, offset + BYTE_STRING_CHUNK_SIZE)));
  }
  return btoa(chunks.join(''));
}

/**
 * Decode base64 storage bytes without relying on Node-only Buffer APIs.
 */
export function decodeBase64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Whether `value` is a non-null object that can be read as a record of unknown values. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
