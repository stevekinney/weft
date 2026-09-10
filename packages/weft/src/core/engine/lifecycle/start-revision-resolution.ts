/**
 * Resolve the exact revision a fresh `startWorkflow()` call — or a schedule's
 * pin capture (WFT-20, `pinned-schedule-revision.ts`) — is about to commit
 * to. Extracted out of `lifecycle/start.ts` so both that module and the
 * schedule pin-capture path import the SAME logic instead of duplicating the
 * `registeredCatalogRevisions`-fallback + `ensureWorkflowCatalogReady()`
 * recheck rule; `start.ts` imports these back unchanged.
 *
 * @module core/engine/lifecycle/start-revision-resolution
 */

import { ensureWorkflowCatalogReady } from '../catalog-readiness.ts';
import type { Engine } from '../index.ts';
import type { EngineInternals } from '../internals.ts';

/**
 * The exact executable artifact a start is about to run: the resolved
 * dynamic-source candidate revision, or — for an eager registration, which
 * never populates `resolvedRevision` — this process's own
 * `registeredCatalogRevisions` entry for `type` (the revision of the code
 * actually loaded here, NOT `inFlightRevision`, which for an eager type
 * falls back to the catalog's cached ACTIVE pointer and can name a revision
 * this process never loaded under a multi-engine deployment). Synchronous,
 * on purpose: every top-level engine.* method already awaits
 * `ensureWorkflowCatalogReady()` before reaching a call site that needs this,
 * so this map is populated by the time the overwhelmingly common case gets
 * here. `undefined` means "genuinely not cached yet"; the caller falls back
 * to {@link resolveStartRevisionUncached}.
 */
export function resolveCachedStartRevision(
  internals: EngineInternals,
  type: string,
  resolvedRevision: string | undefined,
): string | undefined {
  return resolvedRevision ?? internals.registeredCatalogRevisions.get(type);
}

/**
 * The rare fallback {@link resolveCachedStartRevision} defers to: a fired
 * schedule occurrence or a delayed-start timer calls `startWorkflow`
 * directly from background scheduler code, with no top-level
 * `ensureWorkflowCatalogReady()` gate already awaited. Re-checks catalog
 * readiness once, then re-reads the cache.
 */
export async function resolveStartRevisionUncached(
  internals: EngineInternals,
  type: string,
): Promise<string> {
  await ensureWorkflowCatalogReady(internals.engine as unknown as Engine);
  const afterReadiness = internals.registeredCatalogRevisions.get(type);
  if (afterReadiness !== undefined) {
    return afterReadiness;
  }
  // Unreachable in practice: `type` resolved to a real `registration` at
  // this call's only call sites, so it is either an eager registration
  // (which `ensureWorkflowCatalogReady()` always assigns a revision to) or
  // a resolved dynamic source (which always populates `resolvedRevision`,
  // handled entirely by {@link resolveCachedStartRevision} and never
  // reaching here). Fail loud rather than silently persisting a workflow
  // record with no revision identity.
  throw new Error(
    `Cannot start workflow "${type}": no catalog revision is registered for this ` +
      'eagerly-registered type, even after re-checking catalog readiness. This should be ' +
      'unreachable.',
  );
}
