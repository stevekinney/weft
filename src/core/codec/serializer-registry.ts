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
 * only for instance-identity matching and its `.name`.
 */
type RegistrableConstructor<T> = abstract new (...args: never[]) => T;

type RegistryEntry = {
  typeId: number;
  constructor: RegistrableConstructor<unknown>;
  handlers: SerializerHandlers<unknown>;
};

// Reserved extension-type range for user-registered serializers. Built-in
// extension types occupy 1–6 (see extension-codec.ts); custom serializers
// allocate from 100 upward so they can never collide with a built-in type.
const CUSTOM_SERIALIZER_TYPE_BASE = 100;
const CUSTOM_SERIALIZER_TYPE_LIMIT = 127;

const registryByConstructor = new Map<RegistrableConstructor<unknown>, RegistryEntry>();
let nextTypeId = CUSTOM_SERIALIZER_TYPE_BASE;

/**
 * Register a custom (de)serializer for `constructor` on Weft's checkpoint codec.
 * Once registered, any instance of `constructor` that crosses the codec — an
 * activity result, workflow input, signal payload, or error — round-trips
 * through `handlers` instead of the generic structured-clone fallback (which,
 * for errors, would otherwise drop subclass fields like a `ZodError`'s
 * `.issues`).
 *
 * Matching is by exact constructor identity, and the built-in `Error` encoder
 * defers to a registered serializer. The other built-in extension types
 * (`Date`, `RegExp`, `Map`, `Set`) do NOT defer: registering a serializer for a
 * subclass of one of those built-ins has no effect, because the built-in
 * encoder matches the instance first. Register serializers for your own classes
 * (or `Error` subclasses), not for built-in-collection subclasses.
 *
 * Registration is process-global and one-shot per constructor: call it once at
 * module load, before constructing any engine. A second registration for the
 * same constructor, or registering more types than the reserved extension-type
 * range allows, throws.
 *
 * A checkpoint written with a registered serializer is only fully decodable by a
 * process that registered the same serializer; register all expected types at
 * startup so recovery sees the same registry the original run did.
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
 * registerSerializer(RateLimitError, {
 *   toJSON: (error) => ({ retryAfterMs: error.retryAfterMs }),
 *   fromJSON: (data) => new RateLimitError((data as { retryAfterMs: number }).retryAfterMs),
 * });
 * ```
 */
export function registerSerializer<T>(
  constructor: RegistrableConstructor<T>,
  handlers: SerializerHandlers<T>,
): void {
  const key = constructor as RegistrableConstructor<unknown>;
  if (registryByConstructor.has(key)) {
    throw new Error(
      `A serializer is already registered for ${constructor.name || 'an anonymous constructor'}; ` +
        'registerSerializer is one-shot per constructor.',
    );
  }
  if (nextTypeId > CUSTOM_SERIALIZER_TYPE_LIMIT) {
    throw new Error(
      `Cannot register more than ${CUSTOM_SERIALIZER_TYPE_LIMIT - CUSTOM_SERIALIZER_TYPE_BASE + 1} ` +
        'custom serializers; the reserved extension-type range is exhausted.',
    );
  }

  const typeId = nextTypeId;
  nextTypeId += 1;
  const entry: RegistryEntry = {
    typeId,
    constructor: key,
    handlers: handlers as SerializerHandlers<unknown>,
  };
  registryByConstructor.set(key, entry);

  registerCustomExtensionType(entry);
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

// Set lazily by extension-codec.ts to avoid a module import cycle: the registry
// must register encoders on the SAME shared extensionCodec instance, but
// extension-codec.ts imports this module for `hasRegisteredSerializer`.
let sharedExtensionCodec: ExtensionCodec | undefined;
// The codec's own `undefined`-preprocessing, injected at bind time. Passed in
// (rather than imported) to avoid a static cycle: extension-codec.ts imports
// this module for `hasRegisteredSerializer`/`bindSerializerRegistryToCodec`.
let replaceUndefinedInCodec: ((value: unknown, visited: Set<object>) => unknown) | undefined;

/**
 * Wire the shared extensionCodec so registrations attach to the live codec,
 * along with the codec's `replaceUndefined` preprocessor so custom-serializer
 * output is encoded with the same `undefined` semantics as the public `encode()`.
 */
export function bindSerializerRegistryToCodec(
  codec: ExtensionCodec,
  replaceUndefined: (value: unknown, visited: Set<object>) => unknown,
): void {
  sharedExtensionCodec = codec;
  replaceUndefinedInCodec = replaceUndefined;
}

function registerCustomExtensionType(entry: RegistryEntry): void {
  if (sharedExtensionCodec === undefined || replaceUndefinedInCodec === undefined) {
    throw new Error(
      'Serializer registry is not bound to a codec; this is an internal Weft wiring error.',
    );
  }
  // Capture the bound codec + preprocessor as non-undefined locals so the
  // encode/decode closures (invoked later) reference definitely-defined values,
  // and so a custom serializer's own nested values round-trip through the same
  // codec with identical `undefined` handling.
  const codec = sharedExtensionCodec;
  const replaceUndefined = replaceUndefinedInCodec;
  codec.register({
    type: entry.typeId,
    encode(value: unknown): Uint8Array | null {
      if (typeof value === 'object' && value !== null && value.constructor === entry.constructor) {
        // Run the same undefined-preprocessing the public encode() applies, so a
        // toJSON() result with `undefined` fields round-trips identically.
        const preprocessed = replaceUndefined(entry.handlers.toJSON(value), new Set());
        return msgpackEncode(preprocessed, { extensionCodec: codec });
      }
      return null;
    },
    decode(data: Uint8Array): unknown {
      return entry.handlers.fromJSON(msgpackDecode(data, { extensionCodec: codec }));
    },
  });
}

/**
 * Test-only reset of the global registry. Production code never unregisters —
 * a stale serializer could misread a checkpoint — but tests need isolation
 * between registration cases.
 *
 * This clears the registry map and resets the type-id counter to the base. The
 * encoders already attached to the shared `ExtensionCodec` are not removed (the
 * msgpack codec has no removal API), but `ExtensionCodec.register` overwrites
 * the entry for a given type id, so the next registration after a reset — which
 * reuses the base type id — replaces both the encoder and decoder for that id.
 * Reset is therefore safe for per-test isolation; it is not a general
 * "unregister" for a long-lived process.
 */
export function resetSerializerRegistryForTesting(): void {
  registryByConstructor.clear();
  nextTypeId = CUSTOM_SERIALIZER_TYPE_BASE;
}
