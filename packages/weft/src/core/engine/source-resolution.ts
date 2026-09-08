/**
 * `resolveWorkflowSource()` — the async, single-flight entry point that
 * loads, validates, and installs one dynamic workflow source revision
 * (WFT-13/14).
 *
 * Single-flight per `(name, revision)`: the underlying load+validate+install
 * work is shared by every concurrent caller for the same key via
 * `internals.sourceResolutionsInFlight`, but each caller races that shared
 * work against its OWN per-call cancellation interest — a cancelled waiter
 * never aborts a load another waiter still needs, and the shared load
 * itself is never tied to any individual caller's lifetime. Disposal aborts
 * every outstanding waiter (rejecting each pending `resolveWorkflowSource()`
 * call) without touching the shared load, which keeps running to whatever
 * point it naturally settles.
 *
 * @module core/engine/source-resolution
 */

import type { WorkflowRevisionRecord } from '../catalog/index.ts';
import {
  resolveSourceModule,
  validateResolvedWorkflowSource,
  WorkflowSourceValidationError,
  type WorkflowSourceHandle,
} from '../source/index.ts';
import { ensureWorkflowCatalogReady, isWorkflowCatalogReady } from './catalog-readiness.ts';
import { EngineDisposedError } from './errors.ts';
import type { Engine } from './index.ts';
import { getInternals, getWorkflowCatalog, type EngineInternals } from './internals.ts';

/**
 * Options accepted by {@link resolveWorkflowSource}.
 *
 * @example
 * ```ts
 * import { Engine } from '@lostgradient/weft';
 * import type { ResolveWorkflowSourceOptions } from '@lostgradient/weft';
 *
 * declare const engine: Engine;
 * const options: ResolveWorkflowSourceOptions = { signal: AbortSignal.timeout(5_000) };
 * const record = await engine.resolveWorkflowSource('checkout', 'r1', options);
 * console.log(record.manifest.revision);
 * ```
 */
export type ResolveWorkflowSourceOptions = {
  /** When aborted, this caller's own `resolveWorkflowSource()` call rejects; a load already in flight for other callers is unaffected. */
  signal?: AbortSignal;
};

function toAbortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('resolveWorkflowSource() aborted');
}

/**
 * A promise that rejects once `signal` aborts — never resolves. Callers race
 * this against real work via `Promise.race`; the caller is responsible for
 * swallowing this promise's eventual rejection with a standalone
 * `.catch(() => {})` when the OTHER side of the race might win instead, so a
 * late abort after the race has already settled never surfaces as an
 * unhandled rejection.
 *
 * No "already aborted" pre-check: this module's only call site constructs
 * the promise synchronously, immediately after explicitly checking
 * `signal.aborted` itself (and throwing before ever reaching here) — with no
 * `await` between that check and this call, the signal cannot have aborted
 * in between (JS has no interleaving without a yield point). A pre-check
 * here would therefore be permanently unreachable, not a defensive branch.
 */
function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(toAbortError(signal)), { once: true });
  });
}

/**
 * Run the actual load -> validate -> install pipeline for one
 * `(name, revision)`, independent of any individual caller. Shared by every
 * concurrent {@link resolveWorkflowSource} call for the same key via
 * {@link getOrCreateSharedSourceLoad}.
 *
 * Re-checks `internals.disposed` once the (potentially slow, host-defined)
 * loader and validation have finished, immediately before the durable
 * `catalog.install()` write — closing most of the window where a load that
 * started before disposal would otherwise write through to already-closed
 * storage. A small window still exists between that check and
 * `catalog.install()`'s own internal write (the check-then-write is not
 * atomic): this is accepted rather than eliminated, because `install()`'s
 * write is a CAS through `storageConditionalBatch` — a write that lands
 * against storage the engine no longer considers open either applies
 * harmlessly (this repo's storage backends do not require an open
 * "session" to accept a write) or fails, and a failure here simply becomes
 * this shared promise's rejection like any other. Closing the window
 * completely would require `catalog.install()` itself to check
 * `internals.disposed` at its own call boundary, which is out of scope for
 * this batch — recorded as an explicit, accepted trade-off rather than a
 * silent gap.
 */
async function runSharedSourceLoad(
  engine: Engine,
  internals: EngineInternals,
  name: string,
  revision: string,
  handle: WorkflowSourceHandle,
): Promise<WorkflowRevisionRecord> {
  const resolved = await resolveSourceModule(handle.descriptor, handle);
  if (!resolved.ok) {
    throw new WorkflowSourceValidationError(name, revision, [resolved.reason]);
  }

  const outcome = await validateResolvedWorkflowSource(handle.descriptor, resolved.moduleValue);
  if (!outcome.ok) {
    throw new WorkflowSourceValidationError(name, revision, outcome.reasons);
  }

  if (internals.disposed) {
    throw new EngineDisposedError();
  }

  const catalog = getWorkflowCatalog(engine);
  const installed = await catalog.install(outcome.manifest, outcome.definition);

  let resolvedByRevision = internals.resolvedWorkflowSources.get(name);
  if (resolvedByRevision === undefined) {
    resolvedByRevision = new Map();
    internals.resolvedWorkflowSources.set(name, resolvedByRevision);
  }
  resolvedByRevision.set(revision, {
    definition: outcome.loadedDefinition,
    activityRegistry: outcome.activityRegistry,
  });

  return { manifest: installed.manifest, installedAt: installed.installedAt };
}

/**
 * Join the in-flight shared load for `(name, revision)`, or start one.
 * Self-removes from `internals.sourceResolutionsInFlight` once it settles,
 * guarded by reference identity (`byRevision.get(revision) === shared`) so
 * a disposal-triggered `clear()` racing a late settle can never delete a
 * successor load that has already taken this key's place — the exact
 * `catalogDrainPromise === drainPromise` guard `catalog-readiness.ts` uses
 * for its own single in-flight promise.
 */
function getOrCreateSharedSourceLoad(
  engine: Engine,
  internals: EngineInternals,
  name: string,
  revision: string,
  handle: WorkflowSourceHandle,
): Promise<WorkflowRevisionRecord> {
  let byRevision = internals.sourceResolutionsInFlight.get(name);
  if (byRevision === undefined) {
    byRevision = new Map();
    internals.sourceResolutionsInFlight.set(name, byRevision);
  }

  const existing = byRevision.get(revision);
  if (existing !== undefined) {
    return existing;
  }

  const shared: Promise<WorkflowRevisionRecord> = runSharedSourceLoad(
    engine,
    internals,
    name,
    revision,
    handle,
  ).finally(() => {
    const currentByRevision = internals.sourceResolutionsInFlight.get(name);
    if (currentByRevision?.get(revision) !== shared) return;
    currentByRevision.delete(revision);
    if (currentByRevision.size === 0) {
      internals.sourceResolutionsInFlight.delete(name);
    }
  });
  // Every real caller observes this same promise via `Promise.race` in
  // `resolveWorkflowSource` below. This standalone catch exists so that if
  // every waiter aborts before the shared load settles, its eventual
  // rejection (nobody left racing it) never surfaces as an unhandled
  // rejection.
  shared.catch(() => {});

  byRevision.set(revision, shared);
  return shared;
}

/**
 * Load, validate, and install one dynamic workflow source revision
 * previously recorded via `engine.registerSource()`. Returns the installed
 * {@link WorkflowRevisionRecord} immediately, without invoking the loader
 * at all, when `(name, revision)` is already durably installed — including
 * a revision installed by a different process. When that is the case,
 * `internals.resolvedWorkflowSources` is NOT populated for this key (there
 * is no locally-loaded `WorkflowDefinition` to stash — only the durable
 * manifest was ever read) even though the catalog itself considers the
 * revision installed; a later batch reading `resolvedWorkflowSources` must
 * account for that gap rather than assuming every installed revision has a
 * live definition available in this process.
 *
 * Single-flight per `(name, revision)` — see the module doc for the full
 * cancellation contract. Throws a plain `Error` when `registerSource()` was
 * never called for this exact key (a programmer error, not untrusted-input
 * rejection); throws {@link WorkflowSourceValidationError} when the loaded
 * module fails validation; throws {@link EngineDisposedError} when the
 * engine is disposed, either already or during the call; propagates
 * {@link import('../catalog/index.ts').WorkflowCatalogConflictError}
 * unwrapped on a genuine content conflict with an already-installed
 * revision.
 *
 * @example
 * ```ts
 * import { Engine, workflowSource } from '@lostgradient/weft';
 *
 * declare const engine: Engine;
 * declare const loadCheckout: () => Promise<{
 *   checkout: import('@lostgradient/weft').WorkflowDefinition<unknown, unknown, 'checkout'>;
 * }>;
 * engine.registerSource(
 *   workflowSource(
 *     { name: 'checkout', location: './checkout.ts', exportName: 'checkout', revision: 'r1' },
 *     loadCheckout,
 *   ),
 * );
 * const record = await engine.resolveWorkflowSource('checkout', 'r1');
 * console.log(record.manifest.revision);
 * ```
 */
/** A per-call waiter controller, forwarding an optional caller-supplied `AbortSignal` into a fresh controller disposal can also abort — plus the listener-detach cleanup for it. */
type WaiterAbort = {
  controller: AbortController;
  detach: () => void;
};

/**
 * Build this call's own `AbortController`, forwarding `options.signal`'s
 * abort into it (so either the caller's own cancellation OR engine
 * disposal — which aborts every controller in
 * `internals.sourceResolutionWaiterControllers` — cancels this specific
 * call). `detach()` removes the forwarding listener; callers must invoke it
 * exactly once, in a `finally`.
 */
function createWaiterAbort(options: ResolveWorkflowSourceOptions | undefined): WaiterAbort {
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort(options?.signal?.reason);
  if (options?.signal?.aborted) {
    forwardAbort();
  } else {
    options?.signal?.addEventListener('abort', forwardAbort, { once: true });
  }
  return { controller, detach: () => options?.signal?.removeEventListener('abort', forwardAbort) };
}

/**
 * Resolve `(name, revision)` against the already-installed catalog first
 * (the "repeating a resolve returns the cataloged revision" fast path,
 * requiring no loader invocation), and otherwise look up the registered
 * source handle to load — returned so the caller can thread the exact same
 * handle reference into {@link getOrCreateSharedSourceLoad} without a
 * second, potentially-racy re-lookup. Throws the documented plain `Error`
 * when no handle was ever registered for this key. Split out of
 * {@link resolveWorkflowSource} purely to keep that function's own
 * cyclomatic complexity under the repository's ceiling.
 */
async function resolveCachedOrHandle(
  engine: Engine,
  internals: EngineInternals,
  name: string,
  revision: string,
): Promise<
  | { cached: WorkflowRevisionRecord; handle?: never }
  | { cached?: never; handle: WorkflowSourceHandle }
> {
  if (!isWorkflowCatalogReady(engine)) {
    await ensureWorkflowCatalogReady(engine);
  }

  const catalog = getWorkflowCatalog(engine);
  const existing = await catalog.resolveEntry(name, revision);
  if (existing !== undefined) {
    return { cached: existing };
  }

  const handle = internals.workflowSourcesByName.get(name)?.get(revision);
  if (handle === undefined) {
    throw new Error(
      `resolveWorkflowSource("${name}", "${revision}") was called before registerSource() ` +
        'registered this exact (name, revision) — call engine.registerSource() first.',
    );
  }
  return { handle };
}

export async function resolveWorkflowSource(
  engine: Engine,
  name: string,
  revision: string,
  options?: ResolveWorkflowSourceOptions,
): Promise<WorkflowRevisionRecord> {
  const internals = getInternals(engine);
  const waiter = createWaiterAbort(options);

  // Checked before touching storage, the shared-load map, or
  // `internals.sourceResolutionWaiterControllers` — a pre-aborted signal on
  // the very first caller for a fresh `(name, revision)` must never invoke
  // the loader at all.
  if (waiter.controller.signal.aborted) {
    waiter.detach();
    throw toAbortError(waiter.controller.signal);
  }
  if (internals.disposed) {
    waiter.detach();
    throw new EngineDisposedError();
  }

  internals.sourceResolutionWaiterControllers.add(waiter.controller);
  try {
    const outcome = await resolveCachedOrHandle(engine, internals, name, revision);
    if (outcome.cached !== undefined) {
      return outcome.cached;
    }

    // An abort (caller-supplied, or engine disposal) can have landed while
    // the `await` above was in flight (catalog readiness, a durable
    // `resolveEntry` read) — checked explicitly here so a load nobody wants
    // any more never starts, rather than starting it and immediately racing
    // it against an abort that already fired.
    if (waiter.controller.signal.aborted) {
      throw toAbortError(waiter.controller.signal);
    }

    const shared = getOrCreateSharedSourceLoad(engine, internals, name, revision, outcome.handle);
    const waiterAbort = abortRejection(waiter.controller.signal);
    waiterAbort.catch(() => {});
    return await Promise.race([shared, waiterAbort]);
  } finally {
    waiter.detach();
    internals.sourceResolutionWaiterControllers.delete(waiter.controller);
  }
}
