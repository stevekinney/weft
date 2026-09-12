/**
 * Dynamic workflow source fixtures for the dev harness (WFT-116). Registers
 * `invoice-reconciliation` as a `registerSource()` workflow at two
 * revisions, each chosen to leave the engine in one of the load states the
 * console's diagnostics surface has to render honestly:
 *
 * - `DYNAMIC_SOURCE_LOADABLE_REVISION` — a real, loadable module. Registered
 *   and never loaded, so it starts `idle` with no load duration; preloading
 *   it from the console is what turns it `ready` and installs it durably.
 *   Nothing here preloads it, because that transition IS the primary
 *   operator flow `tests/e2e/09-preload-dynamic-source.spec.ts` drives.
 * - `DYNAMIC_SOURCE_FAILING_REVISION` — its loader rejects, so preloading it
 *   produces the bounded `Conflict` + `reason: 'load-failed'` refusal and
 *   leaves `state: 'failed'` with a `lastFailureCategory` behind. Weft
 *   deliberately never forwards a loader's own message onto the wire
 *   (`preload-workflow-revision.ts`'s own catch says why), so that category
 *   is the only classified account of the failure — exactly the behavior the
 *   console re-fetches diagnostics to surface.
 *
 * `registerSource()` refuses a name already registered eagerly
 * (`source-registration.ts`), so this uses a name `fixtures/workflows.ts`
 * does not, and requires inline execution mode — which `Engine.create()`
 * defaults to.
 *
 * ## Why the loadable revision is a hash, not a friendly label
 *
 * A revision is a CONTENT identity, not a free-text tag. Under the default
 * strict compatibility policy (`requireExactRevision: true`),
 * `validateResolvedWorkflowSource()` builds the manifest the loaded module
 * actually produces and compares its revision against the descriptor's — a
 * descriptor naming `invoice-reconciliation-r1` for a module whose content
 * hashes to something else is refused as `artifact-revision-mismatch`. So
 * `DYNAMIC_SOURCE_LOADABLE_REVISION` is the revision
 * `dynamic-workflows/invoice-reconciliation.ts` genuinely derives, and
 * `dynamic-sources.test.ts` pins it against a real engine so editing that
 * module can never silently leave this constant stale.
 *
 * ## Why the loader spreads the module namespace
 *
 * `workflowSource()` documents its loader as a literal
 * `() => import('./x.ts')`, but that shape cannot currently pass validation
 * under Bun: `validateResolvedWorkflowSource()` gates on
 * `worker/manifest/is-record.ts`'s `isRecord`, which requires a `null` or
 * `Object.prototype` prototype, and Bun 1.4.2 gives a TypeScript module
 * namespace a prototype object carrying `__esModule`. The load is then
 * rejected as `missing-export` even though the export is right there.
 * Spreading into a plain object is the working shape today. Filed upstream
 * as WFT-166; drop the spread once that lands.
 *
 * ## Why this workflow never appears in the Registry table
 *
 * `weft.system.registry` is built from `internals.registrations`, which a
 * dynamic source never enters — not even after a preload installs a revision
 * durably. `invoice-reconciliation` is therefore reachable only through the
 * console's Dynamic workflow sources panel, which is why that panel exists.
 * Filed upstream as WFT-165.
 */
import { workflowSource, type WorkflowSourceHandle } from '@lostgradient/weft';

/** The one dynamic workflow name in the dev harness — never eagerly registered. */
export const DYNAMIC_SOURCE_WORKFLOW_NAME = 'invoice-reconciliation';

/**
 * The content-derived revision of `dynamic-workflows/invoice-reconciliation.ts`.
 * Pinned by `dynamic-sources.test.ts` against a real engine — if that test
 * fails, the module changed and this constant needs the new value it reports,
 * not a retry.
 */
export const DYNAMIC_SOURCE_LOADABLE_REVISION =
  'sha256:b11d3fa030a2d8af8e85e3d83ec246d5e4c68cdf5643803d4aca12c4b23c264b';

/**
 * Registered with a loader that rejects. Its label is arbitrary precisely
 * because the load fails before any revision comparison can happen — there
 * is no module content for it to have to match.
 */
export const DYNAMIC_SOURCE_FAILING_REVISION = 'invoice-reconciliation-unreachable';

/** Narrow structural interface — see `fixtures/workflows.ts` for the pattern this file follows. */
export interface DynamicSourcesEngine {
  registerSource(source: WorkflowSourceHandle): void;
}

/** See this module's doc on WFT-166 for why the namespace is spread rather than returned directly. */
async function loadInvoiceReconciliation(): Promise<Record<string, unknown>> {
  return { ...(await import('./dynamic-workflows/invoice-reconciliation.ts')) };
}

/**
 * A loader that always rejects, standing in for the real-world cases the
 * bounded `load-failed` classification exists for: an artifact that isn't
 * there, a network-mounted module that can't be read, an import that throws
 * at evaluation time. The message deliberately looks like one carrying a
 * filesystem path, so it is visible in review that the wire response never
 * repeats it.
 */
function loadUnreachableModule(): Promise<Record<string, unknown>> {
  return Promise.reject(
    new Error("ENOENT: no such file or directory, open '/srv/artifacts/invoice-unreachable.js'"),
  );
}

/**
 * Registers both source revisions. Loads neither: every revision starts
 * `idle`, and the console is what moves them. The console reads all of this
 * back through `weft.catalog.diagnostics`, never from this module.
 */
export function seedDynamicSources(engine: DynamicSourcesEngine): void {
  engine.registerSource(
    workflowSource(
      {
        name: DYNAMIC_SOURCE_WORKFLOW_NAME,
        location: './dynamic-workflows/invoice-reconciliation.ts',
        exportName: 'invoiceReconciliation',
        revision: DYNAMIC_SOURCE_LOADABLE_REVISION,
      },
      loadInvoiceReconciliation,
    ),
  );
  engine.registerSource(
    workflowSource(
      {
        name: DYNAMIC_SOURCE_WORKFLOW_NAME,
        location: './dynamic-workflows/invoice-unreachable.ts',
        exportName: 'invoiceReconciliation',
        revision: DYNAMIC_SOURCE_FAILING_REVISION,
      },
      loadUnreachableModule,
    ),
  );
}
