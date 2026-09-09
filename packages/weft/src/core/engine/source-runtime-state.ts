/**
 * `EngineInternals.sources` — the single consolidated container for every
 * piece of process-local, in-memory state the dynamic workflow-source
 * pipeline (WFT-13/14, WFT-15/16) needs: registered candidates, in-flight
 * single-flight loads, per-caller waiter controllers, locally-resolved
 * definitions, and bounded per-`(name, revision)` diagnostics.
 *
 * WFT-13/14 originally spread this across five flat `EngineInternals`
 * fields (`workflowSourcesByName`, `sourceResolutionsInFlight`,
 * `sourceResolutionWaiterControllers`, `resolvedWorkflowSources`, plus the
 * `ResolvedSource` type alias). WFT-15/16 folds them into one field —
 * `internals.sources: WorkflowSourceRuntimeState` — both because
 * `internals.ts` and `lifecycle/start.ts` are already at the repository's
 * 500-line implementation-file ceiling (no headroom for four more
 * documented fields) and because the diagnostics state this batch adds
 * (`diagnostics`, `waitersByKey`, `lastResolvedRevisionByName`) is the same
 * kind of per-`(name, revision)` bookkeeping the original four fields
 * already were — one container, one owner.
 *
 * Every consumer reaches this state via `internals.sources.<field>` rather
 * than a flat `internals.<field>` — see `scripts/check-engine-internals-field-access.ts`,
 * which is updated in the same commit to the single `sources` name.
 *
 * @module core/engine/source-runtime-state
 */

import type { ActivityRegistry } from '../activity-registry.ts';
import type { WorkflowDefinition } from '../types.ts';
import type { FailureCategory } from '../types/identity.ts';

type SourceHandle = import('../source/index.ts').WorkflowSourceHandle;
type CatalogRevisionRecord = import('../catalog/index.ts').WorkflowRevisionRecord;
type WorkflowSourceKind = import('../source/index.ts').WorkflowSourceKind;

/** A successful `resolveWorkflowSource()`'s live, in-process definition and activity registry. */
export type ResolvedSource = { definition: WorkflowDefinition; activityRegistry: ActivityRegistry };

/**
 * Load-state machine for one `(name, revision)`, backing both the
 * `weft.catalog.diagnostics` `source` extension and the
 * `workflow-source:load-*` events. `'idle'` is the type-level starting
 * point before the first `resolveWorkflowSource()` call for a key, and IS
 * observable externally: `weft.catalog.diagnostics` reports it for any
 * `registerSource()`-registered revision that has never had a load start
 * (see `buildSourceDiagnostics()` in `catalog-removal.ts`), and no
 * `workflow-source:load-*` event is emitted for that state.
 */
export type SourceLoadState = 'idle' | 'loading' | 'ready' | 'failed' | 'cancelled';

/** Bounded, per-`(name, revision)` diagnostics — no manifest or contract content, only identity and state. */
export type SourceLoadDiagnostics = {
  state: SourceLoadState;
  kind: WorkflowSourceKind;
  requestedRevision: string;
  loadStartedAt: number | undefined;
  loadDurationMs: number | undefined;
  lastFailureCategory: FailureCategory | undefined;
};

/** The consolidated dynamic workflow-source runtime state — see the module doc. */
export type WorkflowSourceRuntimeState = {
  /** `registerSource()` candidates, keyed name then revision. Registering never invokes the loader. */
  byName: Map<string, Map<string, SourceHandle>>;
  /** In-flight `resolveWorkflowSource` single-flight load per `(name, revision)`. */
  resolutionsInFlight: Map<string, Map<string, Promise<CatalogRevisionRecord>>>;
  /** Per-caller `AbortController`s from in-flight `resolveWorkflowSource()` calls; disposal aborts every waiter without touching the shared load. */
  waiterControllers: Set<AbortController>;
  /**
   * Outstanding-waiter count per `(name, revision)`, keyed name then
   * revision — a flat composite-string key is not safe here, since unlike a
   * workflow `name`, a source `revision` is only byte-length-bounded, not
   * grammar-restricted, so it may contain whatever separator character a
   * flat key would pick. Incremented/decremented inside
   * `resolveWorkflowSource`'s own try/finally. Drives the `loading` ->
   * `cancelled` diagnostics transition: that transition fires only when
   * the LAST outstanding waiter for a key releases while the shared load
   * is still unsettled.
   */
  waitersByKey: Map<string, Map<string, number>>;
  /** A successful `resolveWorkflowSource()`'s live definition, keyed name then revision. */
  resolved: Map<string, Map<string, ResolvedSource>>;
  /** The revision `resolveExecutableRegistration()` most recently resolved for a name — used by the sync-only fallback readers (`finalizer.ts`, `constraints.ts`). */
  lastResolvedRevisionByName: Map<string, string>;
  /** Bounded per-`(name, revision)` load-state diagnostics, keyed name then revision. */
  diagnostics: Map<string, Map<string, SourceLoadDiagnostics>>;
};

/** Build an empty {@link WorkflowSourceRuntimeState}. */
export function createWorkflowSourceRuntimeState(): WorkflowSourceRuntimeState {
  return {
    byName: new Map(),
    resolutionsInFlight: new Map(),
    waiterControllers: new Set(),
    waitersByKey: new Map(),
    resolved: new Map(),
    lastResolvedRevisionByName: new Map(),
    diagnostics: new Map(),
  };
}

/** Read the nested `name -> revision -> value` count at `(name, revision)` from {@link WorkflowSourceRuntimeState.waitersByKey}, defaulting to `0`. */
export function readWaiterCount(
  waitersByKey: WorkflowSourceRuntimeState['waitersByKey'],
  name: string,
  revision: string,
): number {
  return waitersByKey.get(name)?.get(revision) ?? 0;
}

/** Increment the waiter count at `(name, revision)`, creating intermediate maps as needed. Returns the new count. */
export function incrementWaiterCount(
  waitersByKey: WorkflowSourceRuntimeState['waitersByKey'],
  name: string,
  revision: string,
): number {
  let byRevision = waitersByKey.get(name);
  if (byRevision === undefined) {
    byRevision = new Map();
    waitersByKey.set(name, byRevision);
  }
  const next = (byRevision.get(revision) ?? 0) + 1;
  byRevision.set(revision, next);
  return next;
}

/** Decrement the waiter count at `(name, revision)`, removing empty intermediate maps. Returns the new count (never negative). */
export function decrementWaiterCount(
  waitersByKey: WorkflowSourceRuntimeState['waitersByKey'],
  name: string,
  revision: string,
): number {
  const byRevision = waitersByKey.get(name);
  const current = byRevision?.get(revision) ?? 0;
  const next = Math.max(0, current - 1);
  if (byRevision === undefined) return next;
  if (next === 0) {
    byRevision.delete(revision);
    if (byRevision.size === 0) waitersByKey.delete(name);
  } else {
    byRevision.set(revision, next);
  }
  return next;
}
