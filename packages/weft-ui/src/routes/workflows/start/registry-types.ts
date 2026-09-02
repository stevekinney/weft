/**
 * `weft.system.registry`'s generated operation-client output types
 * `workflows` (a manifest array, v2 — WFT-6) and `activeRevisions`/
 * `activities` as `unknown` by design — `get-registry.ts` (weft server)
 * deliberately treats those dictionaries/arrays as opaque on the wire
 * ("trusting the builder's TypeScript types … is enough for discovery"; a
 * `z.record()` schema would silently drop `__proto__`-named entries). This
 * module narrows that `unknown` back into the real, documented shape
 * (`RegistrySnapshot`, `weft/src/core/registry-snapshot.ts` — not exported
 * from `@lostgradient/weft`'s public surface) with a runtime type guard
 * rather than a bare cast, per this repo's "prefer type guards over
 * assertions" convention, then resolves each name's *active* manifest —
 * `activeRevisions[name] === manifest.revision` — the same resolution rule
 * `registry-view.ts` and the engine-side `registry-contract-builder.ts`/
 * `codegen-validate.ts` use.
 */

export interface RegistryWorkflowEntry {
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly description?: string;
  readonly tags?: readonly string[];
}

interface WorkflowRevisionManifestLike {
  readonly name: string;
  readonly revision: string;
  readonly contract: unknown;
}

/**
 * Project a manifest's `.contract` down to the `RegistryWorkflowEntry`
 * fields this module declares — `name`/`workflowVersion`/`signals`/etc.
 * that `WorkflowContract` also carries are deliberately not passed
 * through, matching the same projection `codegen-validate.ts` (weft
 * server) performs from the identical source shape.
 */
function toRegistryWorkflowEntry(value: unknown): RegistryWorkflowEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const entry: {
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    description?: string;
    tags?: readonly string[];
  } = {};
  if (typeof record['inputSchema'] === 'object' && record['inputSchema'] !== null) {
    entry.inputSchema = record['inputSchema'] as Record<string, unknown>;
  }
  if (typeof record['outputSchema'] === 'object' && record['outputSchema'] !== null) {
    entry.outputSchema = record['outputSchema'] as Record<string, unknown>;
  }
  if (typeof record['description'] === 'string') entry.description = record['description'];
  if (Array.isArray(record['tags'])) entry.tags = record['tags'] as readonly string[];
  return entry;
}

function isWorkflowRevisionManifestLike(value: unknown): value is WorkflowRevisionManifestLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['name'] === 'string' &&
    typeof (value as Record<string, unknown>)['revision'] === 'string' &&
    'contract' in value
  );
}

/**
 * Narrows the registry's opaque `workflows`/`activeRevisions` fields into
 * `Record<name, RegistryWorkflowEntry>`, keeping only each name's currently
 * active manifest's `.contract` and dropping anything malformed (defensive
 * — the server always sends the documented shape here).
 *
 * Built on `Object.create(null)`: a workflow literally named `__proto__` is
 * grammar-valid and must be stored as an own property, not silently
 * dropped by the language's `obj['__proto__'] = value` prototype-mutation
 * special case (see `core/registry-snapshot.ts`'s identical rationale).
 */
export function narrowRegistryWorkflows(
  workflows: unknown,
  activeRevisions: unknown,
): Record<string, RegistryWorkflowEntry> {
  if (!Array.isArray(workflows)) return {};
  if (typeof activeRevisions !== 'object' || activeRevisions === null) return {};
  const activeMap = activeRevisions as Record<string, unknown>;

  const result: Record<string, RegistryWorkflowEntry> = Object.create(null) as Record<
    string,
    RegistryWorkflowEntry
  >;
  for (const manifest of workflows) {
    if (!isWorkflowRevisionManifestLike(manifest)) continue;
    if (!Object.hasOwn(activeMap, manifest.name)) continue;
    if (activeMap[manifest.name] !== manifest.revision) continue;
    const entry = toRegistryWorkflowEntry(manifest.contract);
    if (entry === undefined) continue;
    result[manifest.name] = entry;
  }
  return result;
}
