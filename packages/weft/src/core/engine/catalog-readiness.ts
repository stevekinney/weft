/**
 * The sync/async boundary glue between `engine.register()` (synchronous,
 * cannot itself build a manifest — that requires `crypto.subtle`) and the
 * durable workflow catalog (async, WFT-9/WFT-10).
 *
 * `register()` stays byte-for-byte synchronous; `commitWorkflowDefinition`
 * (`registration.ts`) only pushes the workflow's name onto
 * `EngineInternals.pendingCatalogInstalls`. {@link ensureWorkflowCatalogReady}
 * is the memoized function that, on first call, restores the catalog from
 * storage, then drains `pendingCatalogInstalls` — building each pending
 * workflow's manifest via the already-existing
 * `buildWorkflowManifestForType` (`registry-workflow-manifest.ts`, reused
 * rather than reimplemented) and unconditionally activating it via
 * `WorkflowCatalog.activateRegistered`.
 *
 * Awaited at every entry point that can observe catalog state — see the
 * call sites in `index.ts` — so "restore catalog state before recovery or
 * any new start" holds.
 *
 * @module core/engine/catalog-readiness
 */

import { restoreWorkflowCatalog, WorkflowCatalog } from '../catalog/index.ts';
import { buildWorkflowManifestForType } from '../registry-workflow-manifest.ts';
import { EngineDisposedError } from './errors.ts';
import type { Engine } from './index.ts';
import { getInternals } from './internals.ts';

// Re-exported so `core/registry-snapshot.ts` (outside `src/core/engine/**`,
// so it cannot import `internals.ts` directly per the internal-imports
// allowlist) can reach it WITHOUT importing `./index.ts` — that would close
// an import cycle back through `core/registry-snapshot.ts` →
// `core/worker-execution-strategy.ts` → `core/worker-realm-readiness.ts` →
// `worker/manifest/**` → `core/engine/construction.ts` →
// `core/engine/index.ts`.
export { getWorkflowCatalog } from './internals.ts';

/**
 * Drain every name in `pendingCatalogInstalls`, building its manifest and
 * unconditionally activating it. Does NOT re-scan storage — only the queued
 * names are reprocessed, matching a re-arm after a late `register()` call.
 */
async function drainPendingCatalogInstalls(engine: Engine): Promise<void> {
  const internals = getInternals(engine);
  // Non-null by construction: `ensureWorkflowCatalogReady` always assigns
  // `workflowCatalog` synchronously, in the same async continuation, before
  // ever calling this function — there is no yield point in between where
  // something else could reset it.
  const catalog = internals.workflowCatalog!;

  // Snapshot-and-clear before awaiting anything, so a `register()` call that
  // lands while this drain is in flight queues into a FRESH array rather
  // than being silently absorbed into (or racing) the batch already being
  // processed.
  const pending = internals.pendingCatalogInstalls;
  internals.pendingCatalogInstalls = [];

  for (let index = 0; index < pending.length; index += 1) {
    const name = pending[index]!;
    try {
      const manifest = await buildWorkflowManifestForType(engine, name);
      if (manifest === undefined) {
        // The workflow was unregistered from `internals.registrations`
        // between being queued and this drain running. Nothing to install.
        continue;
      }
      const definition = engine.getWorkflowDefinition(name);
      if (definition === undefined) continue;
      await catalog.activateRegistered(name, manifest, definition);
    } catch (error) {
      // A transient/partial failure (e.g. `WorkflowCatalogActivationConflictError`
      // once the CAS retry budget is exhausted under sustained concurrent
      // writers, or a storage error mid-drain) must not silently drop the
      // name that failed, or any name still unprocessed behind it, from the
      // queue. Re-queue the failing name and everything after it — ahead of
      // any name a concurrent `register()` call queued into the fresh array
      // while this drain was in flight — so the next `ensureWorkflowCatalogReady`
      // call retries them instead of `isWorkflowCatalogReady` reporting a
      // false "ready" once the (now-empty) queue and `catalogRestored` line up.
      internals.pendingCatalogInstalls = [
        ...pending.slice(index),
        ...internals.pendingCatalogInstalls,
      ];
      throw error;
    }
  }
}

/**
 * Synchronous fast-path check: `true` once the catalog is restored and
 * nothing is pending, `false` when {@link ensureWorkflowCatalogReady} would
 * need to do real work. Every `ensureWorkflowCatalogReady` call site in
 * `index.ts` guards its `await` with this check first — `await`ing an
 * `async` function always costs one microtask tick even when the function's
 * own body takes the fast path internally (JS's `await` semantics, not an
 * implementation detail), so skipping the call entirely on an already-warm
 * engine is what "avoid promise-machinery overhead on the hot path" (the
 * WFT-9/WFT-10 design) actually requires — not just an early return inside
 * the async function.
 */
export function isWorkflowCatalogReady(engine: Engine): boolean {
  const internals = getInternals(engine);
  return internals.catalogRestored && internals.pendingCatalogInstalls.length === 0;
}

/**
 * Restore the workflow catalog from storage (once per engine instance) and
 * drain any workflow names `engine.register()` has queued since the last
 * drain. Memoized: concurrent callers await the same in-flight promise, and
 * a call after a prior drain resolved with newly queued names starts a
 * fresh drain rather than re-scanning storage.
 *
 * Also checks the {@link isWorkflowCatalogReady} fast path itself, so a
 * direct call (bypassing a call site's own guard — as in
 * `buildRegistrySnapshot`, or any future caller) is still cheap and correct
 * without relying on every caller remembering to pre-check.
 */
export async function ensureWorkflowCatalogReady(engine: Engine): Promise<void> {
  const internals = getInternals(engine);

  if (isWorkflowCatalogReady(engine)) {
    return;
  }

  if (internals.catalogDrainPromise !== null) {
    await internals.catalogDrainPromise;
    // A late register() call may have queued more names while we were
    // awaiting someone else's drain; re-check rather than assuming clean.
    return ensureWorkflowCatalogReady(engine);
  }

  const drainPromise = (async (): Promise<void> => {
    if (internals.disposed) {
      throw new EngineDisposedError();
    }
    if (!internals.catalogRestored) {
      internals.workflowCatalog = new WorkflowCatalog(
        internals.storage,
        await restoreWorkflowCatalog(internals.storage),
      );
      internals.catalogRestored = true;
    }
    await drainPendingCatalogInstalls(engine);
  })();

  internals.catalogDrainPromise = drainPromise;
  try {
    await drainPromise;
  } finally {
    if (internals.catalogDrainPromise === drainPromise) {
      internals.catalogDrainPromise = null;
    }
  }
}
