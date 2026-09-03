/**
 * `activateCatalogRevisionCandidate` — a thin engine-level wrapper around
 * `WorkflowCatalog.activateCandidate()`, the guarded activation primitive
 * (WFT-9/WFT-10). Awaits catalog readiness, reads pre-activation state,
 * calls the guarded primitive, dispatches the correct catalog event(s), and
 * returns the primitive's own structured result verbatim:
 * the shared installed/activated/draining helper on success, or
 * `WorkflowRevisionActivationRejectedEvent` directly on refusal.
 *
 * `engine.workflows.activate()` (WFT-11,
 * `core/engine/engine-workflows-namespace.ts`) is this wrapper's production
 * caller — the only practical way an external caller reaches the guarded
 * candidate-activation primitive, so routing it through here (rather than
 * calling `WorkflowCatalog.activateCandidate()` directly) is what makes a
 * manual activation dispatch `catalog:revision-installed`/
 * `catalog:revision-activated`/`catalog:revision-draining`/
 * `catalog:activation-rejected` the same way `engine.register()`'s
 * drain path already does.
 *
 * Never imports `./index.ts` as a value (only as a type, matching
 * `catalog-readiness.ts`'s own import-cycle discipline for itself) — the
 * `Engine` class import here is `import type`, erased at build time.
 *
 * @module core/engine/catalog-activation
 */

import type {
  ActivateCandidateOptions,
  WorkflowCatalogActivationResult,
} from '../catalog/index.ts';
import type { WorkflowRevisionManifest } from '../contract/types.ts';
import { WorkflowRevisionActivationRejectedEvent } from '../events/catalog-events.ts';
import { dispatchCatalogInstallAndActivatedEvents } from './catalog-events.ts';
import { ensureWorkflowCatalogReady, getWorkflowCatalog } from './catalog-readiness.ts';
import type { Engine } from './index.ts';

/**
 * Activate `candidateManifest` for `name` through the catalog's guarded
 * primitive (`checkWorkflowCompatibility`-gated, single-shot CAS), and
 * return its structured result verbatim. On success, dispatches
 * `catalog:revision-installed` (when genuinely new content),
 * `catalog:revision-draining` (when displacing a prior active revision),
 * and `catalog:revision-activated`. On refusal, dispatches
 * `catalog:activation-rejected` carrying only the bounded `reason` code
 * (and, for `'incompatible'`, the bounded `incompatibilityReasons` array) —
 * never the full `WorkflowCompatibilityVerdict` object.
 */
export async function activateCatalogRevisionCandidate(
  engine: Engine,
  name: string,
  candidateManifest: WorkflowRevisionManifest,
  options?: ActivateCandidateOptions,
): Promise<WorkflowCatalogActivationResult> {
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
    return result;
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
    return result;
  }

  engine.dispatchEvent(
    new WorkflowRevisionActivationRejectedEvent(name, candidateManifest.revision, result.reason),
  );
  return result;
}
