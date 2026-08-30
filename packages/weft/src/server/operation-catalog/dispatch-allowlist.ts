/**
 * Catalog dispatch exemptions for transport-level session lifecycle primitives.
 */
export const DISPATCH_ALLOWLIST: ReadonlySet<string> = new Set([
  'weft.workflows.subscribe',
  'weft.workflows.unsubscribe',
]);
