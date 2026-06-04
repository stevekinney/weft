import { ExtensionCodec, decode as msgpackDecode, encode as msgpackEncode } from '@msgpack/msgpack';

import {
  coerceCodecArray,
  coerceCodecRecord,
  decodeCodecDate,
  encodeCodecDate,
} from '../codec-helpers.ts';
import { bindSerializerRegistryToCodec, hasRegisteredSerializer } from './serializer-registry.ts';

// ---------------------------------------------------------------------------
// Extension type identifiers
// ---------------------------------------------------------------------------

const EXTENSION_TYPE_DATE = 1;
const EXTENSION_TYPE_REGEXP = 2;
const EXTENSION_TYPE_MAP = 3;
const EXTENSION_TYPE_SET = 4;
const EXTENSION_TYPE_UNDEFINED = 5;
const EXTENSION_TYPE_ERROR = 6;

// ---------------------------------------------------------------------------
// Helpers for safe type narrowing from msgpack decode results
// ---------------------------------------------------------------------------

export const extensionCodec = new ExtensionCodec();

// Wire the user-serializer registry to this shared codec so registerSerializer()
// attaches its custom extension encoders to the same instance encode()/decode()
// use, and hand it `replaceUndefined` (hoisted below) so custom-serializer
// output is encoded with the same `undefined` semantics as the public encode().
// Done before the built-in types register; order does not matter because
// registrations are dynamic.
bindSerializerRegistryToCodec(extensionCodec, replaceUndefined);

// Date (ext type 1): float64 milliseconds since epoch
extensionCodec.register({
  type: EXTENSION_TYPE_DATE,
  encode: encodeCodecDate,
  decode: decodeCodecDate,
});

// RegExp (ext type 2): encoded as { source, flags } object
extensionCodec.register({
  type: EXTENSION_TYPE_REGEXP,
  encode(value: unknown): Uint8Array | null {
    if (value instanceof RegExp) {
      return msgpackEncode({ source: value.source, flags: value.flags });
    }
    return null;
  },
  decode(data: Uint8Array): RegExp {
    const decoded = coerceCodecRecord(msgpackDecode(data));
    const source = typeof decoded['source'] === 'string' ? decoded['source'] : '';
    const flags = typeof decoded['flags'] === 'string' ? decoded['flags'] : '';
    return new RegExp(source, flags);
  },
});

// Map (ext type 3): encoded as array of [key, value] pairs
extensionCodec.register({
  type: EXTENSION_TYPE_MAP,
  encode(value: unknown): Uint8Array | null {
    if (value instanceof Map) {
      const entries = [...value.entries()];
      return msgpackEncode(entries, { extensionCodec });
    }
    return null;
  },
  decode(data: Uint8Array): Map<unknown, unknown> {
    const decoded = coerceCodecArray(msgpackDecode(data, { extensionCodec }));
    const entries = decoded.map((entry) => {
      const pair = coerceCodecArray(entry);
      return [pair[0], pair[1]] as const;
    });
    return new Map(entries);
  },
});

// Set (ext type 4): encoded as array of values
extensionCodec.register({
  type: EXTENSION_TYPE_SET,
  encode(value: unknown): Uint8Array | null {
    if (value instanceof Set) {
      const elements = [...value.values()];
      return msgpackEncode(elements, { extensionCodec });
    }
    return null;
  },
  decode(data: Uint8Array): Set<unknown> {
    const elements = coerceCodecArray(msgpackDecode(data, { extensionCodec }));
    return new Set(elements);
  },
});

// undefined (ext type 5): encoded as empty buffer.
// Note: msgpack treats undefined the same as null (via `== null` check) before
// the extension codec can intercept it. We use a sentinel object that the
// extension codec *can* see, then replace undefined with the sentinel before
// encoding and restore it after decoding.

/**
 * Sentinel object used to represent `undefined` so the extension codec can
 * detect it. We use a unique symbol tag for identification.
 */
const UNDEFINED_SENTINEL_TAG = Symbol('UndefinedSentinel');

interface UndefinedSentinel {
  readonly __tag: typeof UNDEFINED_SENTINEL_TAG;
}

const undefinedSentinel: UndefinedSentinel = Object.freeze({
  __tag: UNDEFINED_SENTINEL_TAG,
});

function isUndefinedSentinel(value: unknown): value is UndefinedSentinel {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__tag' in value &&
    // After the `in` check, we know __tag exists; use indexed access
    (value as Record<string, unknown>)['__tag'] === UNDEFINED_SENTINEL_TAG
  );
}

extensionCodec.register({
  type: EXTENSION_TYPE_UNDEFINED,
  encode(value: unknown): Uint8Array | null {
    if (isUndefinedSentinel(value)) {
      return new Uint8Array(0);
    }
    return null;
  },
  decode(): undefined {
    return undefined;
  },
});

// Error (ext type 6): encoded as { name, message, stack } object.
// Defers to a user-registered serializer (see serializer-registry.ts) when the
// value's exact constructor has one — so a registered Error subclass (e.g. a
// ZodError) round-trips through its custom handler and keeps subclass fields
// like `.issues`, instead of being flattened to name/message/stack here. The
// deferral lives in this encoder (rather than relying on extension-codec
// registration order) because msgpack tries encoders in registration order and
// this generic Error encoder is registered first.
extensionCodec.register({
  type: EXTENSION_TYPE_ERROR,
  encode(value: unknown): Uint8Array | null {
    if (value instanceof Error && !hasRegisteredSerializer(value)) {
      return msgpackEncode({
        name: value.name,
        message: value.message,
        stack: value.stack,
      });
    }
    return null;
  },
  decode(data: Uint8Array): Error {
    const decoded = coerceCodecRecord(msgpackDecode(data));
    const name = typeof decoded['name'] === 'string' ? decoded['name'] : 'Error';
    const message = typeof decoded['message'] === 'string' ? decoded['message'] : '';
    const stack = typeof decoded['stack'] === 'string' ? decoded['stack'] : undefined;
    const error = new Error(message);
    error.name = name;
    if (stack !== undefined) {
      error.stack = stack;
    }
    return error;
  },
});

// ---------------------------------------------------------------------------
// Undefined preprocessing
// ---------------------------------------------------------------------------

/**
 * Recursively replace `undefined` with the sentinel so msgpack's encoder
 * routes it through the extension codec instead of encoding it as null.
 */
export function replaceUndefined(value: unknown, visited: Set<object>): unknown {
  if (value === undefined) return undefinedSentinel;
  if (value === null || typeof value !== 'object') return value;
  if (visited.has(value)) return value;

  visited.add(value);
  try {
    return replaceObjectUndefined(value, visited);
  } finally {
    visited.delete(value);
  }
}

function replaceObjectUndefined(value: object, visited: Set<object>): unknown {
  if (Array.isArray(value)) {
    return replaceArrayUndefined(value, visited);
  }

  if (value instanceof Map) {
    return replaceMapUndefined(value, visited);
  }

  if (value instanceof Set) {
    return replaceSetUndefined(value, visited);
  }

  if (isNestedValueFree(value)) {
    return value;
  }

  return replaceRecordUndefined(value, visited);
}

function replaceArrayUndefined(value: unknown[], visited: Set<object>): unknown[] {
  const result: unknown[] = Array.from({ length: value.length });
  for (let index = 0; index < value.length; index++) {
    result[index] = replaceUndefined(value[index], visited);
  }
  return result;
}

function replaceMapUndefined(
  value: Map<unknown, unknown>,
  visited: Set<object>,
): Map<unknown, unknown> {
  const result = new Map<unknown, unknown>();
  for (const [key, mapValue] of value) {
    result.set(replaceUndefined(key, visited), replaceUndefined(mapValue, visited));
  }
  return result;
}

function replaceSetUndefined(value: Set<unknown>, visited: Set<object>): Set<unknown> {
  const result = new Set<unknown>();
  for (const setValue of value) {
    result.add(replaceUndefined(setValue, visited));
  }
  return result;
}

function isNestedValueFree(value: object): boolean {
  return (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Error ||
    value instanceof Uint8Array ||
    value instanceof ArrayBuffer ||
    // A registered-serializer instance must reach the extension codec with its
    // class identity intact; do not walk it into a plain record here. Its own
    // toJSON output gets replaceUndefined applied inside the custom encoder.
    hasRegisteredSerializer(value)
  );
}

function replaceRecordUndefined(value: object, visited: Set<object>): Record<string, unknown> {
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    result[key] = replaceUndefined(record[key], visited);
  }
  return result;
}
