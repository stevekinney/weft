/**
 * Copy arbitrary `Uint8Array` data into a fresh `ArrayBuffer` for Web APIs that
 * reject `SharedArrayBuffer`-backed views.
 */
export function copyBytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
