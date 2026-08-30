import { validateAttributeType } from '../search-attributes.ts';
import type { SearchAttributeValue } from '../types.ts';
import type { ContextInternals } from './internals.ts';

export function validateAttribute(
  internals: ContextInternals,
  key: string,
  value: SearchAttributeValue,
): void {
  if (internals.searchAttributeSchema) {
    if (!(key in internals.searchAttributeSchema)) {
      throw new Error(
        `Unknown search attribute "${key}". Registered attributes: ${Object.keys(internals.searchAttributeSchema).join(', ')}`,
      );
    }
    validateAttributeType(key, value, internals.searchAttributeSchema[key]!);
  }
}

export function setAttribute(
  internals: ContextInternals,
  key: string,
  value: SearchAttributeValue,
): void {
  validateAttribute(internals, key, value);
  internals.searchAttributes[key] = value;
  internals.pendingAttributeChanges ??= {};
  internals.pendingAttributeChanges[key] = value;
}

export function setAttributes(
  internals: ContextInternals,
  attributes: Record<string, SearchAttributeValue>,
): void {
  for (const [key, value] of Object.entries(attributes)) {
    validateAttribute(internals, key, value);
  }
  for (const [key, value] of Object.entries(attributes)) {
    internals.searchAttributes[key] = value;
    internals.pendingAttributeChanges ??= {};
    internals.pendingAttributeChanges[key] = value;
  }
}

export function getAttribute<T extends SearchAttributeValue = SearchAttributeValue>(
  internals: ContextInternals,
  key: string,
): T | undefined {
  return internals.searchAttributes[key] as T | undefined;
}

export function getAttributes(
  internals: ContextInternals,
): Readonly<Record<string, SearchAttributeValue>> {
  return { ...internals.searchAttributes };
}
