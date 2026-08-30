/**
 * Shared operation filter for public discovery documents.
 *
 * @module server/discovery-filter
 */

import type { ErasedOperation } from './operation-catalog.ts';

/**
 * Return whether an operation should appear in generated discovery documents.
 *
 * Public operations are always discoverable. Non-public operations opt in with
 * `discoverable: true`; `discoverable: false` cannot hide a public operation.
 */
export function isDiscoverable(operation: ErasedOperation): boolean {
  if (operation.access.kind === 'public') return true;
  return operation.discoverable === true;
}
