/**
 * Shared plain-object predicate for untrusted manifest input.
 *
 * `typeof value === 'object'` alone accepts `Date`, `Map`, `RegExp`, and other
 * exotic-prototype instances — `Object.keys()` on those returns an empty
 * array, so a hostile or malformed manifest field silently parses as an
 * empty collection instead of being rejected. Only a plain object literal or
 * a null-prototype object is a JSON object.
 *
 * @module worker/manifest/is-record
 */

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}
