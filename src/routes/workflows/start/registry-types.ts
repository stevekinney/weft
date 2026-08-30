/**
 * `weft.system.registry`'s generated operation-client output types
 * `workflows`/`activities` as `unknown` by design — `get-registry.ts`
 * (weft server) deliberately treats those dictionaries as opaque on the
 * wire ("trusting the builder's TypeScript types … is enough for
 * discovery"; a `z.record()` schema would silently drop `__proto__`-named
 * entries). This module narrows that `unknown` back into the real,
 * documented shape (`RegistrySnapshot`, `weft/src/core/registry-snapshot.ts`
 * — not exported from `@lostgradient/weft`'s public surface) with a runtime
 * type guard rather than a bare cast, per this repo's "prefer type guards
 * over assertions" convention.
 */

export interface RegistryWorkflowEntry {
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly description?: string;
  readonly tags?: readonly string[];
}

function isRegistryWorkflowEntry(value: unknown): value is RegistryWorkflowEntry {
  return typeof value === 'object' && value !== null;
}

/** Narrows the registry's opaque `workflows` field into `Record<string, RegistryWorkflowEntry>`, dropping any entry that isn't a plain object (defensive — the server always sends objects here). */
export function narrowRegistryWorkflows(workflows: unknown): Record<string, RegistryWorkflowEntry> {
  if (typeof workflows !== 'object' || workflows === null) return {};

  const result: Record<string, RegistryWorkflowEntry> = {};
  for (const [name, entry] of Object.entries(workflows)) {
    if (isRegistryWorkflowEntry(entry)) result[name] = entry;
  }
  return result;
}
