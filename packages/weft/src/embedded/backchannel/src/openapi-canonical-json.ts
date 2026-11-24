/**
 * Canonical JSON utilities for OpenAPI schema deduplication.
 *
 * @module server/openapi-canonical-json
 */

/**
 * Produce a stable JSON string with object keys sorted recursively and array
 * order preserved.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);

  const sorted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    sorted[key] = sortKeys(entry);
  }
  return sorted;
}
