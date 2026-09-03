/**
 * `activateCatalogRevisionCandidate` — a thin engine-level wrapper around
 * `WorkflowCatalog.activateCandidate()`, the guarded activation primitive
 * (WFT-9/WFT-10). Awaits catalog readiness, reads pre-activation state,
 * calls the guarded primitive, and dispatches the correct catalog event(s):
 * the shared installed/activated/draining helper on success, or
 * `WorkflowRevisionActivationRejectedEvent` directly on refusal (only this
 * wrapper's caller ever sees a refusal — `activateRegistered`'s own
 * drain-path producer, in `catalog-readiness.ts`, always succeeds).
 *
 * Package-internal only in this batch: no server operation, no root
 * export. `WorkflowCatalog.activateCandidate()` itself has no production
 * caller yet either (`workflow-catalog.ts`'s own docs: "reused by later
 * dynamic-loading work, WFT-13+") — this wrapper is exercised solely by its
 * own direct unit tests, matching that same forward-looking status.
 *
 * Never imports `./index.ts` as a value (only as a type, matching
 * `catalog-readiness.ts`'s own import-cycle discipline for itself) — the
 * `Engine` class import here is `import type`, erased at build time.
 *
 * @module core/engine/catalog-activation
 */

import type { ActivateCandidateOptions } from '../catalog/index.ts';
import type { WorkflowRevisionManifest } from '../contract/types.ts';
import { WorkflowRevisionActivationRejectedEvent } from '../events/catalog-events.ts';
import { dispatchCatalogInstallAndActivatedEvents } from './catalog-events.ts';
import { ensureWorkflowCatalogReady, getWorkflowCatalog } from './catalog-readiness.ts';
import type { Engine } from './index.ts';

/**
 * Activate `candidateManifest` for `name` through the catalog's guarded
 * primitive (`checkWorkflowCompatibility`-gated, single-shot CAS). On
 * success, dispatches `catalog:revision-installed` (when genuinely new
 * content), `catalog:revision-draining` (when displacing a prior active
 * revision), and `catalog:revision-activated`. On refusal, dispatches
 * `catalog:activation-rejected` carrying only the bounded `reason` code
 * (and, for `'incompatible'`, the bounded `incompatibilityReasons` array) —
 * never the full `WorkflowCompatibilityVerdict` object.
 */
export async function activateCatalogRevisionCandidate(
  engine: Engine,
  name: string,
  candidateManifest: WorkflowRevisionManifest,
  options?: ActivateCandidateOptions,
): Promise<void> {
  await ensureWorkflowCatalogReady(engine);
  const catalog = getWorkflowCatalog(engine);

  const preExisting = await catalog.hasInstalled(name, candidateManifest.revision);
  // Storage-aware, not `catalog.resolveActive()`'s synchronous in-memory
  // read: a second process can durably move `name`'s active pointer
  // without ever touching this process's cache, and the dispatched
  // `catalog:revision-draining`/`catalog:revision-activated` events must
  // name the actual previously-active revision, not this process's stale
  // boot-time view of it.
  const pointerBefore = (await catalog.resolveActiveDurable(name)) ?? null;

  const result = await catalog.activateCandidate(name, candidateManifest, options);

  if (result.applied) {
    dispatchCatalogInstallAndActivatedEvents(
      engine,
      name,
      candidateManifest.revision,
      preExisting,
      pointerBefore,
      result.pointer,
    );
    return;
  }

  if (result.reason === 'incompatible') {
    engine.dispatchEvent(
      new WorkflowRevisionActivationRejectedEvent(
        name,
        candidateManifest.revision,
        result.reason,
        result.verdict.compatible ? undefined : result.verdict.reasons,
      ),
    );
    return;
  }

  engine.dispatchEvent(
    new WorkflowRevisionActivationRejectedEvent(name, candidateManifest.revision, result.reason),
  );
}
