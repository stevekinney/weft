import {
  decode as decodeMessagePack,
  encode as encodeMessagePack,
  validateCloneable,
} from '../core/codec.ts';
import { isJSONValue, type JSONValue } from '../core/json.ts';

import { storageDeleteRange, type DeleteRangeOptions } from './delete-range.ts';
import {
  assertStorageBatchOperationCount,
  storageConditionalBatch,
  storageCount,
  storageDeletePrefix,
  storageHas,
  storageKeys,
  type BatchOperation,
  type ConditionalBatchCondition,
  type ScanOptions,
  type Storage,
} from './interface.ts';

/**
 * Encode/decode pair that bridges a typed domain value to and from `Uint8Array`.
 *
 * Implement this interface to plug a custom serialization format into
 * {@link withCodec}. Two built-in factories — {@link jsonCodec} and
 * {@link msgpackCodec} — cover the most common cases.
 *
 * @example
 * ```ts
 * import { type StorageCodec, withCodec, MemoryStorage } from '@lostgradient/weft';
 *
 * const encoder = new TextEncoder();
 * const decoder = new TextDecoder();
 *
 * const csvCodec: StorageCodec<string[]> = {
 *   encode: (row) => encoder.encode(row.join(',')),
 *   decode: (bytes) => decoder.decode(bytes).split(','),
 * };
 *
 * await using raw = new MemoryStorage();
 * const store = withCodec(raw, csvCodec);
 * await store.put('row:1', ['alice', '30', 'eng']);
 * const row = await store.get('row:1');
 * console.log(row?.join('|'));
 * ```
 */
export interface StorageCodec<Value> {
  encode(value: Value): Uint8Array;
  decode(bytes: Uint8Array): Value;
}

/**
 * Validator or narrowing function passed as an optional argument to
 * {@link jsonCodec} and {@link msgpackCodec}.
 *
 * Receives the raw decoded value (`unknown`) and must return the strongly-typed
 * `Value` — either by assertion after runtime validation or by throwing when the
 * shape is unexpected.  Omitting it leaves the codec untyped (`JSONValue` /
 * `MessagePackValue`).
 */
export type StorageValueParser<Value> = (value: unknown) => Value;

export type MessagePackPrimitive = bigint | boolean | null | number | string | undefined;

/**
 * Recursive union of every value that MessagePack can encode and decode.
 *
 * A superset of {@link JSONValue} that additionally supports `Date`, `Map`,
 * `Set`, `Uint8Array`, `RegExp`, `Error`, `ArrayBuffer`, and `bigint`. Its
 * array branch is `ReadonlyArray` (matching `JSONValue`), so every `JSONValue`
 * — including `readonly` arrays and `as const` tuples — is assignable here and
 * accepted by `msgpackCodec<Value extends MessagePackValue>`. The encoder only
 * reads its input, so a readonly bound is sound. Prefer this codec when your
 * domain objects contain binary data or richly-typed primitives that JSON
 * cannot represent without custom serialisation.
 */
export type MessagePackValue =
  | ArrayBuffer
  | Date
  | Error
  | Map<MessagePackValue, MessagePackValue>
  | MessagePackPrimitive
  | ReadonlyArray<MessagePackValue>
  | RegExp
  | Set<MessagePackValue>
  | Uint8Array
  | { [key: string]: MessagePackValue };

/**
 * Typed version of `BatchOperation` — a put or delete applied as part of an
 * atomic batch in a {@link TypedStorage} instance.
 *
 * Build an array of these and pass it to `TypedStorage.batch()` to apply
 * multiple mutations in a single round-trip without encoding each value
 * individually at the call site.
 *
 * @example
 * ```ts
 * import { MemoryStorage, withCodec, jsonCodec, type TypedBatchOperation } from '@lostgradient/weft';
 *
 * await using raw = new MemoryStorage();
 * const store = withCodec(raw, jsonCodec());
 *
 * const ops: TypedBatchOperation<{ count: number }>[] = [
 *   { type: 'put', key: 'a', value: { count: 1 } },
 *   { type: 'put', key: 'b', value: { count: 2 } },
 *   { type: 'delete', key: 'old' },
 * ];
 * await store.batch(ops);
 * ```
 */
export type TypedBatchOperation<Value> =
  { type: 'put'; key: string; value: Value } | { type: 'delete'; key: string };

/**
 * Typed compare-and-swap precondition used by
 * {@link ConditionalTypedStorage.conditionalBatch}.
 *
 * @example
 * ```ts
 * import { type TypedConditionalBatchCondition } from '@lostgradient/weft/storage';
 *
 * type SessionMetadata = { lastUsedAt: string };
 * const condition: TypedConditionalBatchCondition<SessionMetadata> = {
 *   key: 'session:1',
 *   expectedValue: { lastUsedAt: '2026-06-01T00:00:00.000Z' },
 * };
 * console.log(condition.key); // 'session:1'
 * ```
 */
export type TypedConditionalBatchCondition<Value> = {
  /** Key whose current decoded value must match `expectedValue`. */
  key: string;
  /** Required current value, or `null` to require the key to be absent. */
  expectedValue: Value | null;
};

/**
 * Options for {@link withCodec}.
 *
 * @example
 * ```ts
 * import { type CodecStorageOptions } from '@lostgradient/weft/storage';
 *
 * const options: CodecStorageOptions = {
 *   disposeUnderlyingStorage: false,
 * };
 * console.log(options.disposeUnderlyingStorage); // false
 * ```
 */
export type CodecStorageOptions = {
  /**
   * Whether disposing the typed wrapper also disposes the wrapped storage.
   * Defaults to `true` to preserve the owning-wrapper behavior. Set `false`
   * when several typed views share the same storage instance.
   */
  disposeUnderlyingStorage?: boolean;
};

/**
 * Disposable typed key-value store interface over a raw {@link Storage}.
 *
 * Mirrors the `Storage` interface but operates on `Value` instead of
 * `Uint8Array` — encoding and decoding is handled transparently by the
 * underlying codec.  Obtain a `TypedStorage` via {@link withCodec},
 * {@link jsonCodec}, or {@link msgpackCodec} rather than implementing it
 * directly. Note: `TypedStorage` intentionally does not surface
 * `Storage.query` or `Storage.scoped` — drop down to the underlying raw
 * storage to use those operations.
 *
 * @example
 * ```ts
 * import { MemoryStorage, withCodec, jsonCodec, type TypedStorage } from '@lostgradient/weft';
 *
 * type User = { name: string; age: number };
 *
 * await using raw = new MemoryStorage();
 * const users: TypedStorage<User> = withCodec(
 *   raw,
 *   jsonCodec((v) => v as User),
 * );
 *
 * await users.put('user:1', { name: 'Alice', age: 30 });
 * const alice = await users.get('user:1');
 * console.log(alice?.name); // 'Alice'
 * ```
 */
export interface TypedStorage<Value> extends Disposable {
  get(key: string): Promise<Value | null>;
  put(key: string, value: Value): Promise<void>;
  delete(key: string): Promise<void>;
  scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Value]>;
  batch(operations: TypedBatchOperation<Value>[]): Promise<void>;
  has(key: string): Promise<boolean>;
  deletePrefix(prefix: string): Promise<number>;
  // Optional: keeps adding deleteRange a non-breaking change for external
  // implementers of this publicly-exported interface.
  deleteRange?(prefix: string, options: DeleteRangeOptions): Promise<number>;
  keys(prefix: string, options?: ScanOptions): AsyncIterable<string>;
  count(prefix: string): Promise<number>;
}

/**
 * Typed storage returned by {@link withCodec}. It extends the base
 * {@link TypedStorage} shape with compare-and-swap support without requiring
 * every external `TypedStorage` implementation to define the method.
 */
export interface ConditionalTypedStorage<Value> extends TypedStorage<Value> {
  conditionalBatch(
    conditions: TypedConditionalBatchCondition<Value>[],
    operations: TypedBatchOperation<Value>[],
  ): Promise<boolean>;
}

class CodecStorage<Value> implements ConditionalTypedStorage<Value> {
  #storage: Storage;
  #codec: StorageCodec<Value>;
  #disposeUnderlyingStorage: boolean;

  constructor(storage: Storage, codec: StorageCodec<Value>, options: CodecStorageOptions = {}) {
    this.#storage = storage;
    this.#codec = codec;
    this.#disposeUnderlyingStorage = options.disposeUnderlyingStorage ?? true;
  }

  async get(key: string): Promise<Value | null> {
    const value = await this.#storage.get(key);
    return value === null ? null : this.#codec.decode(value);
  }

  async put(key: string, value: Value): Promise<void> {
    await this.#storage.put(key, this.#codec.encode(value));
  }

  async delete(key: string): Promise<void> {
    await this.#storage.delete(key);
  }

  async *scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Value]> {
    for await (const [key, value] of this.#storage.scan(prefix, options)) {
      yield [key, this.#codec.decode(value)];
    }
  }

  async batch(operations: TypedBatchOperation<Value>[]): Promise<void> {
    assertStorageBatchOperationCount('batch operations', operations.length);
    await this.#storage.batch(this.#encodeOperations(operations));
  }

  #encodeOperations(operations: TypedBatchOperation<Value>[]): BatchOperation[] {
    const encodedOperations: BatchOperation[] = operations.map((operation) => {
      if (operation.type === 'put') {
        return {
          type: 'put',
          key: operation.key,
          value: this.#codec.encode(operation.value),
        };
      }

      return operation;
    });

    return encodedOperations;
  }

  #encodeConditions(
    conditions: TypedConditionalBatchCondition<Value>[],
  ): ConditionalBatchCondition[] {
    return conditions.map((condition) => ({
      key: condition.key,
      expectedValue:
        condition.expectedValue === null ? null : this.#codec.encode(condition.expectedValue),
    }));
  }

  async conditionalBatch(
    conditions: TypedConditionalBatchCondition<Value>[],
    operations: TypedBatchOperation<Value>[],
  ): Promise<boolean> {
    return storageConditionalBatch(
      this.#storage,
      this.#encodeConditions(conditions),
      this.#encodeOperations(operations),
    );
  }

  async has(key: string): Promise<boolean> {
    return storageHas(this.#storage, key);
  }

  async deletePrefix(prefix: string): Promise<number> {
    return storageDeletePrefix(this.#storage, prefix);
  }

  async deleteRange(prefix: string, options: DeleteRangeOptions): Promise<number> {
    // Keys and bounds are value-agnostic, so the codec is not involved.
    return storageDeleteRange(this.#storage, prefix, options);
  }

  keys(prefix: string, options?: ScanOptions): AsyncIterable<string> {
    return storageKeys(this.#storage, prefix, options);
  }

  async count(prefix: string): Promise<number> {
    return storageCount(this.#storage, prefix);
  }

  [Symbol.dispose](): void {
    if (!this.#disposeUnderlyingStorage) {
      return;
    }
    this.#storage[Symbol.dispose]();
  }
}

/**
 * Wraps a raw {@link Storage} with a {@link StorageCodec} to produce a
 * {@link TypedStorage} that encodes and decodes values automatically.
 *
 * Use the built-in {@link jsonCodec} or {@link msgpackCodec} factories as the
 * `codec` argument, or supply a custom implementation.  The returned store
 * disposes the underlying storage when its own `[Symbol.dispose]` is called
 * unless `disposeUnderlyingStorage: false` is provided.
 *
 * @example
 * ```ts
 * import { MemoryStorage, withCodec, jsonCodec } from '@lostgradient/weft';
 *
 * type Config = { retries: number; timeout: number };
 *
 * await using raw = new MemoryStorage();
 * const configStore = withCodec(raw, jsonCodec<Config>((v) => v as Config));
 *
 * await configStore.put('cfg:default', { retries: 3, timeout: 5000 });
 * const cfg = await configStore.get('cfg:default');
 * console.log(cfg?.retries); // 3
 * ```
 */
export function withCodec<Value>(
  storage: Storage,
  codec: StorageCodec<Value>,
  options: CodecStorageOptions = {},
): ConditionalTypedStorage<Value> {
  return new CodecStorage(storage, codec, options);
}

function encodeJsonValue(value: JSONValue): Uint8Array {
  try {
    if (!isJSONValue(value)) {
      throw new TypeError('jsonCodec only supports JSON-serializable values.');
    }
    const serializedValue = JSON.stringify(value);
    if (serializedValue === undefined) {
      throw new TypeError('jsonCodec only supports JSON-serializable values.');
    }

    return new TextEncoder().encode(serializedValue);
  } catch (error) {
    throw new TypeError('jsonCodec only supports JSON-serializable values.', {
      cause: error,
    });
  }
}

function encodeMessagePackValue(value: MessagePackValue): Uint8Array {
  const validationResult = validateCloneable(value);
  if (!validationResult.valid) {
    throw new TypeError(
      `msgpackCodec only supports structuredClone-compatible values. ${validationResult.errors[0]?.reason ?? ''}`.trim(),
    );
  }

  return encodeMessagePack(value);
}

function decodeJsonValue(bytes: Uint8Array): JSONValue {
  const decodedValue = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  // JSON.parse only produces JSON-compatible primitives, arrays, and plain objects.
  return decodedValue as JSONValue;
}

function decodeMessagePackValue(bytes: Uint8Array): MessagePackValue {
  const decodedValue = decodeMessagePack(bytes);
  const validationResult = validateCloneable(decodedValue);
  if (!validationResult.valid) {
    throw new TypeError(
      `msgpackCodec decoded a non-cloneable value. ${validationResult.errors[0]?.reason ?? ''}`.trim(),
    );
  }

  return decodedValue as MessagePackValue;
}

/**
 * Creates a {@link StorageCodec} that serialises values as UTF-8 JSON.
 *
 * Call without arguments to get a `StorageCodec<JSONValue>`.  Pass an optional
 * {@link StorageValueParser} to narrow the output to a concrete type — useful
 * when you have a Zod schema or manual shape check.
 *
 * @example
 * ```ts
 * import { MemoryStorage, withCodec, jsonCodec } from '@lostgradient/weft';
 *
 * type Point = { x: number; y: number };
 * const isPoint = (v: unknown): v is Point =>
 *   typeof v === 'object' && v !== null && 'x' in v && 'y' in v;
 *
 * await using raw = new MemoryStorage();
 * const points = withCodec(raw, jsonCodec<Point>((v) => {
 *   if (!isPoint(v)) throw new TypeError('not a Point');
 *   return v;
 * }));
 *
 * await points.put('p:1', { x: 10, y: 20 });
 * const p = await points.get('p:1');
 * console.log(p?.x); // 10
 * ```
 */
export function jsonCodec(): StorageCodec<JSONValue>;
export function jsonCodec<Value extends JSONValue>(
  parse: StorageValueParser<Value>,
): StorageCodec<Value>;
export function jsonCodec<Value extends JSONValue>(
  parse?: StorageValueParser<Value>,
): StorageCodec<JSONValue> | StorageCodec<Value> {
  return {
    encode(value: JSONValue): Uint8Array {
      return encodeJsonValue(value);
    },
    decode(bytes: Uint8Array): JSONValue | Value {
      const decodedValue = decodeJsonValue(bytes);
      return parse ? parse(decodedValue) : decodedValue;
    },
  };
}

/**
 * Creates a {@link StorageCodec} that serialises values with MessagePack.
 *
 * Prefer this over {@link jsonCodec} when your domain objects contain binary
 * data (`Uint8Array`, `ArrayBuffer`), `Date`, `Map`, or `Set` — types that
 * JSON cannot round-trip without custom replacers.  Pass an optional
 * {@link StorageValueParser} to narrow the decoded type.
 *
 * @example
 * ```ts
 * import { MemoryStorage, withCodec, msgpackCodec } from '@lostgradient/weft';
 *
 * type Event = { ts: Date; payload: Uint8Array };
 *
 * await using raw = new MemoryStorage();
 * const events = withCodec(raw, msgpackCodec<Event>((v) => v as Event));
 *
 * const evt: Event = { ts: new Date(), payload: new Uint8Array([1, 2, 3]) };
 * await events.put('evt:1', evt);
 * const loaded = await events.get('evt:1');
 * console.log(loaded?.ts instanceof Date); // true
 * ```
 */
export function msgpackCodec(): StorageCodec<MessagePackValue>;
export function msgpackCodec<Value extends MessagePackValue>(
  parse: StorageValueParser<Value>,
): StorageCodec<Value>;
export function msgpackCodec<Value extends MessagePackValue>(
  parse?: StorageValueParser<Value>,
): StorageCodec<MessagePackValue> | StorageCodec<Value> {
  return {
    encode(value: MessagePackValue): Uint8Array {
      return encodeMessagePackValue(value);
    },
    decode(bytes: Uint8Array): MessagePackValue | Value {
      const decodedValue = decodeMessagePackValue(bytes);
      return parse ? parse(decodedValue) : decodedValue;
    },
  };
}
