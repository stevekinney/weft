/**
 * Bounded validation for the open-ended `capabilities` record on a worker
 * manifest.
 *
 * `isJSONValue()` already rejects the values JSON cannot round-trip — cycles,
 * `-0`, exotic prototypes — but it is deliberately unbounded in depth, key
 * count, and string size. A manifest arrives from a worker we do not trust, so
 * the depth and size ceilings have to be imposed here rather than delegated.
 *
 * @module worker/manifest/capabilities
 */

import { isJSONValue, type JSONValue } from '../../core/json.ts';
import type { ManifestValidationFailure } from './failure.ts';
import { manifestFailure } from './failure.ts';
import {
  MAX_MANIFEST_CAPABILITY_COUNT,
  MAX_MANIFEST_CAPABILITY_DEPTH,
  MAX_MANIFEST_CAPABILITY_STRING_BYTES,
} from './limits.ts';
import { utf8ByteLength } from './utf8.ts';

/**
 * Walk a proven `JSONValue` enforcing depth and string-size ceilings.
 *
 * Returns the first violation, or `undefined` when the whole value is within
 * bounds. `isJSONValue()` has already ruled out cycles, so the recursion
 * terminates on structure alone and the depth counter is a policy bound rather
 * than a safety net.
 */
function checkCapabilityValue(
  value: JSONValue,
  path: string,
  depth: number,
): ManifestValidationFailure | undefined {
  if (depth > MAX_MANIFEST_CAPABILITY_DEPTH) {
    return manifestFailure(
      'capability_too_deep',
      `exceeds the maximum capability nesting depth of ${MAX_MANIFEST_CAPABILITY_DEPTH}`,
      path,
    );
  }

  if (typeof value === 'string') return checkCapabilityString(value, path);
  if (Array.isArray(value)) return checkCapabilityArray(value, path, depth);
  if (value !== null && typeof value === 'object') {
    return checkCapabilityObject(value as { readonly [key: string]: JSONValue }, path, depth);
  }

  return undefined;
}

function checkCapabilityString(value: string, path: string): ManifestValidationFailure | undefined {
  const bytes = utf8ByteLength(value);
  if (bytes > MAX_MANIFEST_CAPABILITY_STRING_BYTES) {
    return manifestFailure(
      'capability_string_too_long',
      `is ${bytes} bytes, exceeding the maximum capability string size of ${MAX_MANIFEST_CAPABILITY_STRING_BYTES}`,
      path,
    );
  }
  return undefined;
}

function checkCapabilityArray(
  value: readonly JSONValue[],
  path: string,
  depth: number,
): ManifestValidationFailure | undefined {
  for (const [index, entry] of value.entries()) {
    const failure = checkCapabilityValue(entry, `${path}[${String(index)}]`, depth + 1);
    if (failure !== undefined) return failure;
  }
  return undefined;
}

function checkCapabilityObject(
  record: { readonly [key: string]: JSONValue },
  path: string,
  depth: number,
): ManifestValidationFailure | undefined {
  for (const key of Object.keys(record)) {
    const failure = checkCapabilityValue(record[key] as JSONValue, `${path}.${key}`, depth + 1);
    if (failure !== undefined) return failure;
  }
  return undefined;
}

/**
 * Validate the manifest `capabilities` record from untrusted input.
 *
 * Capabilities are descriptive only. Nothing here consults their meaning —
 * a capability never grants authorization or affects routing without an
 * explicit host policy — so this checks shape and size and nothing else.
 */
export function parseManifestCapabilities(
  value: unknown,
  path: string,
): { ok: true; capabilities: Readonly<Record<string, JSONValue>> } | ManifestValidationFailure {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return manifestFailure('invalid_field', 'must be a JSON object', path);
  }

  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record);
  if (keys.length > MAX_MANIFEST_CAPABILITY_COUNT) {
    return manifestFailure(
      'too_many_capabilities',
      `declares ${keys.length} capabilities, exceeding the maximum of ${MAX_MANIFEST_CAPABILITY_COUNT}`,
      path,
    );
  }

  const capabilities: Record<string, JSONValue> = Object.create(null) as Record<string, JSONValue>;
  for (const key of keys) {
    const entry = record[key];
    if (!isJSONValue(entry)) {
      return manifestFailure('invalid_capability_value', 'must be a JSON value', `${path}.${key}`);
    }

    const failure = checkCapabilityValue(entry, `${path}.${key}`, 1);
    if (failure !== undefined) return failure;

    capabilities[key] = entry;
  }

  return { ok: true, capabilities };
}
