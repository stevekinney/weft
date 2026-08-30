/**
 * Deterministic canonical JSON serialization for arbitrary values.
 *
 * Object keys are sorted at every depth so two values that differ only in
 * key order serialize identically — the property any hash-then-compare
 * scheme (manifest digests, contract hashes) depends on.
 *
 * @module worker/manifest/canonical-json
 */

function sortedEntryKeys(record: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.keys(record).toSorted();
}

/**
 * Serialize an arbitrary value with object keys sorted at every depth.
 *
 * Accepts `unknown` rather than a `JSONValue` bound because callers such as
 * a JSON-Schema converter's output are structurally JSON-safe by
 * construction (trusted, already-serialized-once data) without necessarily
 * satisfying that type at the TypeScript level. `undefined` values inside
 * objects are dropped, matching `JSON.stringify`'s own behavior, since this
 * function is a drop-in canonical replacement for it.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJsonStringify(entry)).join(',')}]`;
  }

  const record = value as Readonly<Record<string, unknown>>;
  const entries = sortedEntryKeys(record)
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJsonStringify(record[key])}`);
  return `{${entries.join(',')}}`;
}
