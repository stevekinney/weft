import { Encoder, decode as msgpackDecode } from '@msgpack/msgpack';

import { extensionCodec, replaceUndefined } from './extension-codec.ts';

// One reusable encoder. `msgpack.encode()` constructs a fresh `Encoder` and its 2 KiB backing
// buffer on every call, which is a measurable share of the workflow-start admission path
// (two encodes per start), and returns a view into that buffer rather than an exact-size copy.
// `Encoder#encode` returns an exact-size copy and clones itself when re-entered (an extension
// encoder that calls back into `encode`), so sharing one instance is safe.
//
// The encoder grows its scratch buffer to fit the largest value it has encoded and never shrinks
// it, so after an encode larger than this the shared instance is replaced. One oversized input,
// checkpoint or signal therefore does not pin its size in memory for the life of the process,
// while the small payloads of the start path keep reusing one instance.
export const SHARED_ENCODER_RETAINED_BUFFER_LIMIT_BYTES = 1024 * 1024;

let sharedEncoder = new Encoder({ extensionCodec });

/** The size of the shared encoder's scratch buffer, for tests that check it is released. */
export function sharedEncoderScratchBytesForTesting(): number {
  return (sharedEncoder as unknown as { bytes: Uint8Array }).bytes.byteLength;
}

// Public API
// ---------------------------------------------------------------------------

/**
 * Encode a value to MessagePack bytes with structuredClone semantics.
 *
 * @example
 * ```ts
 * import { encode, decode } from '@lostgradient/weft';
 *
 * const data = { name: 'Alice', createdAt: new Date(), tags: new Set(['admin']) };
 * const bytes = encode(data);
 * console.log(bytes instanceof Uint8Array); // true
 *
 * const restored = decode(bytes) as typeof data;
 * console.log(restored.name);          // 'Alice'
 * console.log(restored.tags instanceof Set); // true
 * ```
 */
export function encode(value: unknown): Uint8Array {
  const preprocessed = replaceUndefined(value, new Set());
  let bytes: Uint8Array;
  try {
    bytes = sharedEncoder.encode(preprocessed);
  } catch (error) {
    // A value can grow the scratch buffer and then fail further in, so the size of what it would
    // have produced is unknown. Failures are rare; start over rather than keep what it grew.
    sharedEncoder = new Encoder({ extensionCodec });
    throw error;
  }
  if (bytes.byteLength > SHARED_ENCODER_RETAINED_BUFFER_LIMIT_BYTES) {
    sharedEncoder = new Encoder({ extensionCodec });
  }
  return bytes;
}

/**
 * Decode MessagePack bytes back to a value.
 *
 * @example
 * ```ts
 * import { encode, decode } from '@lostgradient/weft';
 *
 * const original = { id: 42, labels: new Map([['env', 'prod']]) };
 * const bytes = encode(original);
 * const result = decode(bytes) as typeof original;
 * console.log(result.id);                      // 42
 * console.log(result.labels.get('env'));        // 'prod'
 * ```
 */
export function decode(bytes: Uint8Array): unknown {
  return msgpackDecode(bytes, { extensionCodec });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
