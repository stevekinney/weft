import { ExtensionCodec, decode as msgpackDecode, encode as msgpackEncode } from '@msgpack/msgpack';

/**
 * Encode/decode handlers for a custom structured type that crosses Weft's
 * checkpoint codec. `toJSON` reduces an instance to a plain, msgpack-encodable
 * value; `fromJSON` rebuilds the instance from that value on the far side.
 *
 * The handlers must round-trip deterministically: a value encoded and then
 * decoded must reconstruct an equivalent instance, with field order and content
 * stable across calls (the codec backs replay-deterministic checkpoints).
 *
 * @example
 * ```ts
 * import { type SerializerHandlers } from '@lostgradient/weft';
 *
 * class ValidationError extends Error {
 *   constructor(
 *     message: string,
 *     readonly issues: string[],
 *   ) {
 *     super(message);
 *     this.name = 'ValidationError';
 *   }
 * }
 *
 * const handlers: SerializerHandlers<ValidationError> = {
 *   toJSON: (error) => ({ message: error.message, issues: error.issues }),
 *   fromJSON: (data) => {
 *     const record = data as { message: string; issues: string[] };
 *     return new ValidationError(record.message, record.issues);
 *   },
 * };
 * void handlers;
 * ```
 */
export type SerializerHandlers<T> = {
  toJSON(value: T): unknown;
  fromJSON(data: unknown): T;
};

/**
 * Constructor of a registrable type. Uses a `never[]`-rest abstract constructor
 * so it accepts any class (a concrete class is assignable to an abstract
 * constructor whose parameters are `never[]`) without an `any`. The handlers,
 * not the constructor signature, own (de)serialization; the constructor is used
 * only for instance-identity matching.
 */
type RegistrableConstructor<T> = abstract new (...args: never[]) => T;

type RegistryEntry = {
  tag: string;
  constructor: RegistrableConstructor<unknown>;
  handlers: SerializerHandlers<unknown>;
};

// A single reserved extension-type id carries every custom-serialized value.
// Built-in extension types occupy 1–6 (see extension-codec.ts); 100 is outside
// that range. The type discriminant is a developer-supplied string `tag` stored
// INSIDE the payload (`{ tag, data }`), not the numeric extension id — so decode
// resolves the handler by tag regardless of registration order or count, and a
// checkpoint written by one process decodes correctly in another that
// registered the same tags in any order.
const CUSTOM_SERIALIZER_EXTENSION_TYPE = 100;

const registryByConstructor = new Map<RegistrableConstructor<unknown>, RegistryEntry>();
const registryByTag = new Map<string, RegistryEntry>();

/**
 * Register a custom (de)serializer for `constructor` on Weft's checkpoint codec.
 * Once registered, any instance of `constructor` that crosses the codec — an
 * activity result, workflow input, signal payload, or error — round-trips
 * through `handlers` instead of the generic structured-clone fallback (which,
 * for errors, would otherwise drop subclass fields like a `ZodError`'s
 * `.issues`).
 *
 * `options.tag` is a stable, developer-chosen discriminant stored inside each
 * encoded value. Decode resolves the handler by this tag, so registration order
 * and count are irrelevant and a checkpoint stays decodable across deploys.
 * Choose an explicit, durable string — do NOT rely on `constructor.name`, which
 * a minified build mangles, silently breaking cross-build decode.
 *
 * Matching is by exact constructor identity, and the built-in `Error` encoder
 * defers to a registered serializer. The other built-in extension types
 * (`Date`, `RegExp`, `Map`, `Set`) do NOT defer: registering a serializer for a
 * subclass of one of those built-ins has no effect, because the built-in
 * encoder matches the instance first. Register serializers for your own classes
 * (or `Error` subclasses), not for built-in-collection subclasses.
 *
 * Registration is process-global and one-shot per constructor and per tag: call
 * it once at module load, before constructing any engine. Re-registering the
 * same constructor, or reusing a `tag` already taken by another constructor,
 * throws. A checkpoint written with a registered serializer is decodable by any
 * process that registered the same tag → handler.
 *
 * @example
 * ```ts
 * import { registerSerializer } from '@lostgradient/weft';
 *
 * class RateLimitError extends Error {
 *   constructor(readonly retryAfterMs: number) {
 *     super('rate limited');
 *     this.name = 'RateLimitError';
 *   }
 * }
 *
 * registerSerializer(
 *   RateLimitError,
 *   {
 *     toJSON: (error) => ({ retryAfterMs: error.retryAfterMs }),
 *     fromJSON: (data) => new RateLimitError((data as { retryAfterMs: number }).retryAfterMs),
 *   },
 *   { tag: 'RateLimitError' },
 * );
 * ```
 */
export function registerSerializer<T>(
  constructor: RegistrableConstructor<T>,
  handlers: SerializerHandlers<T>,
  options: { tag: string },
): void {
  const key = constructor as RegistrableConstructor<unknown>;
  const { tag } = options;
  if (typeof tag !== 'string' || tag.length === 0) {
    throw new Error('registerSerializer requires a non-empty string options.tag.');
  }
  if (registryByConstructor.has(key)) {
    throw new Error(
      `A serializer is already registered for ${constructor.name || 'an anonymous constructor'}; ` +
        'registerSerializer is one-shot per constructor.',
    );
  }
  if (registryByTag.has(tag)) {
    throw new Error(
      `A serializer is already registered with tag "${tag}"; serializer tags must be unique.`,
    );
  }

  const entry: RegistryEntry = {
    tag,
    constructor: key,
    handlers: handlers as SerializerHandlers<unknown>,
  };
  registryByConstructor.set(key, entry);
  registryByTag.set(tag, entry);
}

/**
 * Whether `value` is an instance of a registered constructor. The built-in
 * Error extension encoder consults this to defer to a registered serializer
 * (so a registered Error subclass uses its custom handler, not the generic
 * Error encoding), regardless of extension-encoder registration order.
 */
export function hasRegisteredSerializer(value: object): boolean {
  return registryByConstructor.has(value.constructor as RegistrableConstructor<unknown>);
}

/**
 * Wire the shared extensionCodec so the single custom-serializer extension type
 * is registered on the live codec, along with the codec's `replaceUndefined`
 * preprocessor so custom-serializer output is encoded with the same `undefined`
 * semantics as the public `encode()`. Called once at codec construction.
 * `replaceUndefined` is passed in rather than imported to avoid a static cycle:
 * extension-codec.ts imports this module for `hasRegisteredSerializer`.
 */
export function bindSerializerRegistryToCodec(
  codec: ExtensionCodec,
  replaceUndefined: (value: unknown, visited: Set<object>) => unknown,
): void {
  codec.register({
    type: CUSTOM_SERIALIZER_EXTENSION_TYPE,
    encode(value: unknown): Uint8Array | null {
      if (typeof value !== 'object' || value === null) {
        return null;
      }
      const entry = registryByConstructor.get(value.constructor as RegistrableConstructor<unknown>);
      if (entry === undefined) {
        return null;
      }
      // Embed the stable tag alongside the serialized payload so decode resolves
      // the handler by tag, not by a positional extension id. Run the same
      // undefined-preprocessing the public encode() applies so a toJSON() result
      // with `undefined` fields round-trips identically.
      const data = replaceUndefined(entry.handlers.toJSON(value), new Set());
      return msgpackEncode({ tag: entry.tag, data }, { extensionCodec: codec });
    },
    decode(bytes: Uint8Array): unknown {
      const payload = msgpackDecode(bytes, { extensionCodec: codec });
      if (typeof payload !== 'object' || payload === null || !('tag' in payload)) {
        throw new Error('Corrupt custom-serializer payload: missing tag.');
      }
      const { tag, data } = payload as { tag: unknown; data: unknown };
      if (typeof tag !== 'string') {
        throw new Error('Corrupt custom-serializer payload: tag is not a string.');
      }
      const entry = registryByTag.get(tag);
      if (entry === undefined) {
        throw new Error(
          `No serializer registered for tag "${tag}". Register it (with the same tag) before ` +
            'decoding a checkpoint that used it.',
        );
      }
      return entry.handlers.fromJSON(data);
    },
  });
}

/**
 * Test-only reset of the global registry. Production code never unregisters —
 * a stale serializer could misread a checkpoint — but tests need isolation
 * between registration cases. Clears both tag and constructor maps; the single
 * extension-type decoder stays bound to the codec and simply finds an empty
 * registry until the next registration.
 */
export function resetSerializerRegistryForTesting(): void {
  registryByConstructor.clear();
  registryByTag.clear();
}
