/**
 * Canonical payload digests for the durable application primitives (WFT-84).
 *
 * Idempotency binds a retry to `(caller, target, kind, payloadDigest)`, so the
 * digest has to be stable for values that are logically equal but built in a
 * different order. Object key insertion order, `Map` entry order, and `Set`
 * member order all change MessagePack bytes without changing meaning, so this
 * module canonicalizes those orderings first and only then hands the value to
 * Weft's structured-clone codec.
 *
 * Digesting the codec's own output — rather than a hand-rolled JSON walk — is
 * deliberate: `Uint8Array`, `Date`, `Map`, and `Set` keep their identity, so an
 * opaque multimodal or managed-asset reference contributes its real bytes to the
 * digest instead of being coerced to text.
 *
 * @module core/application-payload-digest
 */

import { encode } from './codec.ts';
import { WeftError } from './weft-error.ts';

/** Hard ceiling on nesting depth, so a hostile payload cannot exhaust the stack. */
const MAX_CANONICAL_DEPTH = 64;

/**
 * Thrown when a value cannot be canonicalized into a stable digest — a cycle, a
 * type the structured-clone codec cannot carry, or nesting past the depth
 * ceiling.
 *
 * Internal by design: callers see it re-thrown as the public
 * `ApplicationCommandValidationError` with this error as `cause`, so the public
 * error union stays small while the specific reason survives.
 */
export class PayloadDigestError extends WeftError<'PayloadDigestError'> {
  constructor(message: string) {
    super('PayloadDigestError', message);
  }
}

/**
 * Total order over two encodings: shorter first, then byte by byte.
 *
 * Ordering by length first is not arbitrary. MessagePack is self-delimiting, so
 * one encoding is never a strict prefix of another and a plain lexicographic
 * walk would leave its length tie-break permanently unreachable. Comparing
 * lengths up front keeps the order total and every branch real.
 */
function compareBytes(left: Uint8Array, right: Uint8Array): number {
  if (left.length !== right.length) return left.length - right.length;
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === null || prototype === Object.prototype;
}

/**
 * Rewrite a value so every unordered container has a deterministic order:
 * object keys sorted lexicographically, `Map` entries and `Set` members sorted
 * by the canonical encoding of their elements.
 */
function canonicalize(value: unknown, seen: Set<object>, depth: number): unknown {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new PayloadDigestError(
      `Payload nesting exceeds the ${MAX_CANONICAL_DEPTH}-level canonical digest ceiling.`,
    );
  }
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol') {
      throw new PayloadDigestError(`Payload contains a non-cloneable ${typeof value} value.`);
    }
    return value;
  }
  if (seen.has(value)) throw new PayloadDigestError('Payload contains a cycle.');
  seen.add(value);
  try {
    return canonicalizeObject(value, seen, depth);
  } finally {
    seen.delete(value);
  }
}

function canonicalizeObject(value: object, seen: Set<object>, depth: number): unknown {
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((element) => canonicalize(element, seen, depth + 1));
  }
  if (value instanceof Set) {
    return new Set(sortByEncoding([...value].map((m) => canonicalize(m, seen, depth + 1))));
  }
  if (value instanceof Map) {
    const entries = [...value].map(
      ([key, entryValue]) =>
        [canonicalize(key, seen, depth + 1), canonicalize(entryValue, seen, depth + 1)] as const,
    );
    // Tie-break on the WHOLE entry, not just the key. Distinct keys can encode
    // identically (two empty objects, say), and a stable sort would then preserve
    // insertion order — so the same Map built in a different order would digest
    // differently and an idempotent retry would report a spurious conflict.
    const sorted = entries
      .map((entry) => ({ entry, bytes: encode(entry) }))
      .toSorted((left, right) => compareBytes(left.bytes, right.bytes))
      .map(({ entry }) => entry);
    return new Map(sorted);
  }
  if (!isPlainObject(value)) {
    throw new PayloadDigestError(
      'Payload contains a class instance the canonical digest cannot order.',
    );
  }
  // A null prototype, not `{}`: an own `__proto__` key (which `JSON.parse` can
  // produce) would otherwise reassign the prototype instead of becoming a data
  // property, silently dropping it from the digest. Two payloads differing only
  // in `__proto__` would then collide and an idempotent retry would resolve to
  // the wrong command.
  const canonical: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).toSorted()) {
    Object.defineProperty(canonical, key, {
      value: canonicalize(Reflect.get(value, key), seen, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return canonical;
}

function sortByEncoding(values: readonly unknown[]): unknown[] {
  return values
    .map((value) => ({ value, bytes: encode(value) }))
    .toSorted((left, right) => compareBytes(left.bytes, right.bytes))
    .map(({ value }) => value);
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * SHA-256 the canonical encoding of an arbitrary structured-clone value.
 *
 * @throws {PayloadDigestError} When the value cycles, nests too deeply, or holds
 * a type the structured-clone codec cannot carry.
 */
export async function computePayloadDigest(value: unknown): Promise<string> {
  const canonical = canonicalize(value, new Set(), 0);
  return toHex(await crypto.subtle.digest('SHA-256', encode(canonical)));
}

/**
 * SHA-256 a list of opaque identity components, length-prefixed so no component
 * boundary can be forged by embedding a separator.
 */
export async function computeIdentityDigest(components: readonly string[]): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encode([...components])));
}
