/**
 * JSON primitive values that can safely cross checkpoint, storage, and
 * tool/effect boundaries.
 *
 * @example
 * ```ts
 * import type { JSONPrimitive } from '@lostgradient/weft';
 *
 * const value: JSONPrimitive = 'ready';
 * ```
 */
export type JSONPrimitive = string | number | boolean | null;

/**
 * Recursive JSON-safe value. Used for effect-log outputs, durable operation
 * payloads, and any data that crosses serialization boundaries inside weft.
 *
 * @example
 * ```ts
 * import type { JSONValue } from '@lostgradient/weft';
 *
 * const value: JSONValue = { count: 1, tags: ['ready'] };
 * ```
 */
export type JSONValue = JSONPrimitive | ReadonlyArray<JSONValue> | { [key: string]: JSONValue };

/**
 * Return true when a value is JSON-safe — i.e. composed entirely of strings,
 * finite numbers, booleans, `null`, arrays of those, and plain objects whose
 * values are JSON-safe. Detects and rejects cyclic structures.
 *
 * @example
 * ```ts
 * import { isJSONValue } from '@lostgradient/weft';
 *
 * isJSONValue({ count: 1, tags: ['ready'] }); // true
 * isJSONValue(new Date());                    // false
 * ```
 */
export function isJSONValue(value: unknown): value is JSONValue {
  const seen = new WeakSet<object>();

  const walk = (current: unknown): current is JSONValue => {
    if (isJSONPrimitive(current)) return true;
    if (isUnsupportedJSONType(current)) return false;

    if (Array.isArray(current)) return isJSONArray(current, seen, walk);

    if (typeof current === 'object') return isJSONObject(current, seen, walk);

    return false;
  };

  return walk(value);
}

/**
 * Coerce an unknown value into a JSON-safe value. Already-safe values pass
 * through unchanged. `undefined`, `bigint`, `symbol`, and `Error` instances
 * fall back to safe representations; anything else that fails `JSON.stringify`
 * is replaced with `null`.
 *
 * @example
 * ```ts
 * import { normalizeJSONValue } from '@lostgradient/weft';
 *
 * normalizeJSONValue({ count: 1 });        // { count: 1 }
 * normalizeJSONValue(new Error('boom'));    // { name: 'Error', message: 'boom' }
 * normalizeJSONValue(undefined);            // null
 * ```
 */
export function normalizeJSONValue(value: unknown): JSONValue {
  if (value === undefined) {
    return null;
  }

  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  if (isJSONValue(value)) {
    return value;
  }

  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      return fallbackJSONValue(value);
    }
    const parsed = JSON.parse(serialized) as unknown;
    return isJSONValue(parsed) ? parsed : fallbackJSONValue(value);
  } catch {
    return fallbackJSONValue(value);
  }
}

type JSONValueWalker = (current: unknown) => current is JSONValue;

function isJSONPrimitive(value: unknown): value is JSONPrimitive {
  if (value === null) return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  return typeof value === 'string' || typeof value === 'boolean';
}

function isUnsupportedJSONType(value: unknown): boolean {
  const type = typeof value;
  return type === 'undefined' || type === 'bigint' || type === 'function' || type === 'symbol';
}

function isJSONArray(
  value: readonly unknown[],
  seen: WeakSet<object>,
  walk: JSONValueWalker,
): value is ReadonlyArray<JSONValue> {
  if (seen.has(value)) return false;
  seen.add(value);
  for (const item of value) {
    if (!walk(item)) return false;
  }
  seen.delete(value);
  return true;
}

function isJSONObject(
  value: object,
  seen: WeakSet<object>,
  walk: JSONValueWalker,
): value is { [key: string]: JSONValue } {
  if (!isPlainObject(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  for (const item of Object.values(value)) {
    if (!walk(item)) return false;
  }
  seen.delete(value);
  return true;
}

function fallbackJSONValue(value: unknown): JSONValue {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'symbol') {
    return value.description ?? null;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
