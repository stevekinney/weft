/**
 * Shared `DiscoveryInfo` type and helper for applying it to API discovery documents.
 *
 * @module server/discovery-info
 */

/**
 * Operator-supplied metadata applied uniformly to all three discovery documents
 * (`/openapi.json`, `/openrpc.json`, `/asyncapi.json`). Set it once on
 * `serve({ discoveryInfo })` and the description, contact, license, and
 * external-docs fields appear in every discovery surface from a single source,
 * so the three documents never drift.
 *
 * @example
 * ```ts
 * import { serve, type DiscoveryInfo } from '@lostgradient/weft/server';
 * import { Engine, MemoryStorage } from '@lostgradient/weft';
 *
 * const discoveryInfo: DiscoveryInfo = {
 *   description: 'Order processing API',
 *   contact: { name: 'Platform', email: 'platform@example.com' },
 *   license: { name: 'MIT' },
 * };
 *
 * await using engine = new Engine({ storage: new MemoryStorage() });
 * await using server = serve({ engine, discoveryInfo });
 * void server;
 * ```
 */
export type DiscoveryInfo = {
  /** Long-form description rendered in each document's `info.description`. */
  description?: string;
  /** Contact details rendered in each document's `info.contact`. */
  contact?: { name?: string; url?: string; email?: string };
  /** License rendered in each document's `info.license`. */
  license?: { name: string; url?: string };
  /**
   * External documentation reference. **Placement is asymmetric across the
   * three discovery documents:**
   *
   * - OpenAPI 3.1: rendered inside `info.externalDocs` (or at the document
   *   root depending on the OpenAPI generator's chosen location, but
   *   semantically attached to the document's metadata block).
   * - OpenRPC 1.3.2: rendered inside `info.externalDocs`.
   * - AsyncAPI 3.0.0: rendered at the **document top-level**, NOT inside
   *   `info`. The AsyncAPI 3.0 spec moved `externalDocs` out of `info`.
   *
   * `applyDiscoveryInfo` does NOT place this field; each generator's call
   * site is responsible for picking the spec-correct location.
   */
  externalDocs?: { description?: string; url: string };
};

/**
 * Merge `DiscoveryInfo` fields into a document's `info` object (or top-level
 * for AsyncAPI 3.0 `externalDocs`).
 *
 * Returns a shallow copy of `target` with the discovery info fields applied.
 * Fields absent from `info` are omitted from the output.
 */
export function applyDiscoveryInfo(
  target: Record<string, unknown>,
  info: DiscoveryInfo | undefined,
): Record<string, unknown> {
  if (info === undefined) return target;
  const result = { ...target };
  if (info.description !== undefined) result['description'] = info.description;
  if (info.contact !== undefined) result['contact'] = { ...info.contact };
  if (info.license !== undefined) result['license'] = { ...info.license };
  // externalDocs is applied at the call site (document top-level for AsyncAPI,
  // inside info for OpenAPI/OpenRPC)
  return result;
}
