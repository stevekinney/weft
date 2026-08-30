import { canonicalJson } from './openapi-canonical-json.ts';

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function asPlainObject(value: unknown): Record<string, unknown> {
  if (isPlainObject(value)) return value;
  return {};
}

export function normalizeJsonObject(value: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(canonicalJson(value));
  return asPlainObject(parsed);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
