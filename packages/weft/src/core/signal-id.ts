const MAX_SIGNAL_ID_BYTES = 128;
const textEncoder = new TextEncoder();

export function isSignalIdWithinByteLimit(signalId: string): boolean {
  return textEncoder.encode(signalId).byteLength <= MAX_SIGNAL_ID_BYTES;
}

export function validateSignalId(signalId: string): void {
  if (signalId.length === 0) {
    throw new Error('signalId must be non-empty');
  }

  if (!isSignalIdWithinByteLimit(signalId)) {
    throw new Error(`signalId must be at most ${String(MAX_SIGNAL_ID_BYTES)} bytes`);
  }
}
