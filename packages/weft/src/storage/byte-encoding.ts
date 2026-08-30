/**
 * Encode storage bytes as base64 without relying on Node-only Buffer APIs.
 */
const BYTE_STRING_CHUNK_SIZE = 512;

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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
