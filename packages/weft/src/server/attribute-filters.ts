/**
 * URL search-parameter parsers for `AttributeFilter` shapes.
 *
 * Both the `weft.workflows.list` REST binding (`extractInput` in
 * `operations/list-workflows.ts`) and any future endpoint that
 * accepts `attr.{name}=...` query parameters share these helpers.
 *
 * Single source of truth: a fix here lands in every caller without
 * the drift hazard of duplicated parsing logic across operations.
 *
 * @module server/attribute-filters
 */

import type { AttributeFilterScalarValue } from '../core/types.ts';

type ParsedAttributeFilter = {
  key: string;
  value?: AttributeFilterScalarValue | AttributeFilterScalarValue[] | undefined;
  gt?: AttributeFilterScalarValue | undefined;
  lt?: AttributeFilterScalarValue | undefined;
  gte?: AttributeFilterScalarValue | undefined;
  lte?: AttributeFilterScalarValue | undefined;
};

/**
 * Parse `attr.{name}={value}`, `attr.{name}.gt={value}`,
 * `attr.{name}.lt={value}`, `attr.{name}.gte={value}`, and
 * `attr.{name}.lte={value}` query parameters into a list of
 * `AttributeFilter` records. Each filter aggregates exact-match
 * and range constraints for one attribute key.
 *
 * Unknown operators after the second dot (e.g.
 * `attr.foo.bogus={value}`) are silently skipped — the alternative
 * (a 400) would let any client typo escalate into an unconstrained
 * range scan, which is worse than the typo being ignored.
 */
export function parseAttributeFilters(params: URLSearchParams): ParsedAttributeFilter[] {
  const filterMap = new Map<string, ParsedAttributeFilter>();

  for (const [key, value] of params) {
    if (!key.startsWith('attr.')) continue;

    const rest = key.slice(5); // strip "attr."
    const dotIndex = rest.indexOf('.');

    if (dotIndex === -1) {
      // Exact match: attr.{name}={value}
      const name = rest;
      const existing = filterMap.get(name) ?? { key: name };
      existing.value = appendExactAttributeValue(existing.value, inferAttributeValue(value));
      filterMap.set(name, existing);
    } else {
      // Range: attr.{name}.{op}={value}
      const name = rest.slice(0, dotIndex);
      const operator = rest.slice(dotIndex + 1);
      const existing = filterMap.get(name) ?? { key: name };

      if (operator === 'gt') {
        existing.gt = inferAttributeValue(value);
        filterMap.set(name, existing);
      } else if (operator === 'lt') {
        existing.lt = inferAttributeValue(value);
        filterMap.set(name, existing);
      } else if (operator === 'gte') {
        existing.gte = inferAttributeValue(value);
        filterMap.set(name, existing);
      } else if (operator === 'lte') {
        existing.lte = inferAttributeValue(value);
        filterMap.set(name, existing);
      }
      // Unknown operators are silently skipped to avoid unconstrained range scans.
    }
  }

  return [...filterMap.values()];
}

function appendExactAttributeValue(
  current: AttributeFilterScalarValue | AttributeFilterScalarValue[] | undefined,
  next: AttributeFilterScalarValue,
): AttributeFilterScalarValue | AttributeFilterScalarValue[] {
  if (current === undefined) return next;

  const currentValues = Array.isArray(current) ? current : [current];
  return [...currentValues, next];
}

/**
 * Infer a typed `SearchAttributeValue` from its URL-decoded string.
 * Booleans and numbers parse first, otherwise the raw string is
 * preserved. The empty string stays a string (it would otherwise
 * coerce to `0` via `Number('')`).
 */
export function inferAttributeValue(raw: string): AttributeFilterScalarValue {
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  const asNumber = Number(raw);
  if (!Number.isNaN(asNumber) && raw.trim() !== '') return asNumber;

  return raw;
}
