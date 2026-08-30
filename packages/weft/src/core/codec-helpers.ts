/** Coerce a decoded MessagePack value to an object record for extension decoding. */
export function coerceCodecRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** Coerce a decoded MessagePack value to an array for extension decoding. */
export function coerceCodecArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Encode a Date extension payload as float64 milliseconds since epoch. */
export function encodeCodecDate(value: unknown): Uint8Array | null {
  if (!(value instanceof Date)) {
    return null;
  }

  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value.getTime());
  return new Uint8Array(buffer);
}

/** Decode a Date extension payload from float64 milliseconds since epoch. */
export function decodeCodecDate(data: Uint8Array): Date {
  const milliseconds = new DataView(data.buffer, data.byteOffset, data.byteLength).getFloat64(0);
  return new Date(milliseconds);
}
