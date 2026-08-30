import { decode as msgpackDecode, encode as msgpackEncode } from '@msgpack/msgpack';

import { extensionCodec, replaceUndefined } from './extension-codec.ts';

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
  return msgpackEncode(preprocessed, { extensionCodec });
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
