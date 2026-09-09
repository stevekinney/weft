/**
 * `resolveWorkflowSource()` — the async, single-flight entry point that
 * loads, validates, and installs one dynamic workflow source revision
 * (WFT-13/14).
 *
 * Single-flight per `(name, revision)`: the underlying load+validate+install
 * work is shared by every concurrent caller for the same key via
 * `internals.sources.resolutionsInFlight`, but each caller races that shared
 * work against its OWN per-call cancellation interest — a cancelled waiter
 * never aborts a load another waiter still needs, and the shared load itself
 * is never tied to any individual caller's lifetime. Disposal aborts every
 * outstanding waiter (rejecting each pending `resolveWorkflowSource()` call)
 * without touching the shared load, which keeps running to its own settle.
 *
 * @module core/engine/source-resolution
 */

import type { WorkflowRevisionRecord } from '../catalog/index.ts';
import {
  checkWorkflowCompatibility,
  DEFAULT_WORKFLOW_COMPATIBILITY_POLICY,
} from '../contract/compatibility.ts';
import {
  buildExpectedManifest,
  resolveSourceModule,
  validateResolvedWorkflowSource,
  WorkflowSourceValidationError,
  type WorkflowSourceHandle,
} from '../source/index.ts';
import { ensureWorkflowCatalogReady, isWorkflowCatalogReady } from './catalog-readiness.ts';
import { WorkflowSourceNotRegisteredError } from './dynamic-source-errors.ts';
import { EngineDisposedError } from './errors.ts';
import type { Engine } from './index.ts';
import { getInternals, getWorkflowCatalog, type EngineInternals } from './internals.ts';
import {
  beginSourceWaiter,
  endSourceWaiterAndDispatchCancellation,
  recordSourceLoadFailedAndDispatch,
  recordSourceLoadReadyAndDispatch,
  recordSourceLoadStartedAndDispatch,
  reviveOrphanedSourceLoadDiagnostics,
  type SourceEventContext,
} from './source-diagnostics.ts';

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
 * silent gap. `internals.disposed` is re-checked a THIRD time after
 * `catalog.install()` resolves, guarding only the in-memory
 * `internals.sources.resolved` write (never the durable install itself,
 * already committed by then) — a disposed engine's internals stay fully
 * empty rather than accumulating state `disposeSourceResolutionState()`
 * already cleared and will never clear again.
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

  // Re-checked here, not just at the `internals.disposed` check immediately
  // above (before `catalog.install()`): disposal can land while that `await`
  // is in flight. `disposeSourceResolutionState()`
  // has already cleared `internals.sources.resolved` by the time this
  // resumes, and nothing will ever clear it again — writing into it here would
  // silently repopulate a disposed engine's internals with a definition and
  // activity registry nothing will read, rather than leaving them empty as
  // teardown intended. The durable install this promise resolves with already
  // succeeded either way; only the in-memory bookkeeping is skipped.
  if (!internals.disposed) {
    let resolvedByRevision = internals.sources.resolved.get(name);
    if (resolvedByRevision === undefined) {
      resolvedByRevision = new Map();
      internals.sources.resolved.set(name, resolvedByRevision);
    }
    resolvedByRevision.set(revision, {
      definition: outcome.loadedDefinition,
      activityRegistry: outcome.activityRegistry,
    });
  }

  return { manifest: installed.manifest, installedAt: installed.installedAt };
}

/**
 * Join the in-flight shared load for `(name, revision)` — reviving a
 * joining caller's orphaned `cancelled` diagnostics — or start one.
 * Self-removes once settled, guarded by reference identity.
 */
function getOrCreateSharedSourceLoad(
  engine: Engine,
  internals: EngineInternals,
  name: string,
  revision: string,
  handle: WorkflowSourceHandle,
): Promise<WorkflowRevisionRecord> {
  let byRevision = internals.sources.resolutionsInFlight.get(name);
  if (byRevision === undefined) {
    byRevision = new Map();
    internals.sources.resolutionsInFlight.set(name, byRevision);
  }

  const existing = byRevision.get(revision);
  if (existing !== undefined) {
    reviveOrphanedSourceLoadDiagnostics(internals, name, revision);
    return existing;
  }

  const eventContext: SourceEventContext = {
    engine,
    internals,
    name,
    revision,
    kind: handle.descriptor.kind,
  };
  recordSourceLoadStartedAndDispatch(eventContext, internals.options.getNow());

  const shared: Promise<WorkflowRevisionRecord> = runSharedSourceLoad(
    engine,
    internals,
    name,
    revision,
    handle,
  )
    .then(
      (record) => {
        recordSourceLoadReadyAndDispatch(eventContext, internals.options.getNow());
        return record;
      },
      (error: unknown) => {
        recordSourceLoadFailedAndDispatch(eventContext, internals.options.getNow(), error);
        throw error;
      },
    )
    .finally(() => {
      const currentByRevision = internals.sources.resolutionsInFlight.get(name);
      if (currentByRevision?.get(revision) !== shared) return;
      currentByRevision.delete(revision);
      if (currentByRevision.size === 0) {
        internals.sources.resolutionsInFlight.delete(name);
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

/** A per-call waiter controller, forwarding an optional caller-supplied `AbortSignal` into a fresh controller disposal can also abort — plus the listener-detach cleanup for it. */
type WaiterAbort = {
  controller: AbortController;
  detach: () => void;
};

/**
 * Build this call's own `AbortController`, forwarding `options.signal`'s
 * abort into it (so either the caller's own cancellation OR engine
 * disposal — which aborts every controller in
 * `internals.sources.waiterControllers` — cancels this specific
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
 * Look up the registered source handle for `(name, revision)` FIRST — this
 * engine must have called `registerSource()` for this exact key, or this
 * throws the documented plain `Error`, regardless of what the catalog holds
 * (a `(name, revision)` some other process durably installed does not, by
 * itself, give this engine standing to resolve it). Only once a handle is
 * found does this check the already-installed catalog (the "repeating a
 * resolve returns the cataloged revision" fast path, requiring no loader
 * invocation) — a cache hit whose registered handle pins
 * `workflowVersion`/`contractHash` is further validated against those pins
 * before being returned, exactly as a fresh load-and-validate would reject
 * a mismatch. The handle is returned (not just used) so the caller can
 * thread the exact same reference into {@link getOrCreateSharedSourceLoad}
 * without a second, potentially-racy re-lookup. Split out of
 * {@link resolveWorkflowSource} purely to keep that function's own
 * cyclomatic complexity under the repository's ceiling.
 */
async function resolveCachedOrHandle(
  engine: Engine,
  internals: EngineInternals,
  name: string,
  revision: string,
  requireLocalDefinition: boolean,
): Promise<
  | { cached: WorkflowRevisionRecord; handle?: never }
  | { cached?: never; handle: WorkflowSourceHandle }
> {
  // The handle is looked up FIRST, before any catalog read: `registerSource()`
  // is the only thing that gives this exact (name, revision) key standing to
  // resolve at all. Reversing the order — checking the catalog first, only
  // falling back to the handle lookup when nothing is cached — would let a
  // (name, revision) some OTHER process durably installed resolve
  // successfully here even though this engine never called `registerSource()`
  // for it, contradicting the documented programmer-error contract below.
  const handle = internals.sources.byName.get(name)?.get(revision);
  if (handle === undefined) {
    throw new WorkflowSourceNotRegisteredError(name, revision);
  }

  if (!isWorkflowCatalogReady(engine)) {
    await ensureWorkflowCatalogReady(engine);
  }

  const catalog = getWorkflowCatalog(engine);
  const existing = await catalog.resolveEntry(name, revision);
  if (existing !== undefined) {
    // The fast path still owes the descriptor's own pins an answer: a
    // registered handle that pins `workflowVersion`/`contractHash` must
    // reject a cached manifest that contradicts those pins exactly as a
    // fresh load-and-validate would (`validate.ts`'s own
    // `checkWorkflowCompatibility` call, reused verbatim here via the same
    // `buildExpectedManifest` helper), rather than silently returning
    // mismatched cached data just because it happened to already be
    // installed (by this engine, an earlier call, or another process).
    const expectedManifest = buildExpectedManifest(handle.descriptor, existing.manifest);
    const verdict = checkWorkflowCompatibility(
      expectedManifest,
      existing.manifest,
      DEFAULT_WORKFLOW_COMPATIBILITY_POLICY,
    );
    if (!verdict.compatible) {
      throw new WorkflowSourceValidationError(name, revision, verdict.reasons);
    }
    // Internal-only fallthrough (never reachable from the public
    // `engine.resolveWorkflowSource()` surface, which always passes
    // `requireLocalDefinition: false`): a caller that needs a LOCAL
    // `WorkflowDefinition` — not just the durable manifest — cannot be
    // satisfied by the cache hit alone when no prior resolve in THIS
    // process ever populated `internals.sources.resolved` for this
    // exact key (for example, a fresh process whose catalog already has
    // `(name, revision)` durably installed by a DIFFERENT process). Falling
    // through to `{ handle }` re-runs the full load -> validate -> install
    // pipeline via `runSharedSourceLoad`, which populates the local
    // resolved-definition cache as a side effect; `catalog.install()` is
    // idempotent on byte-identical content, so re-installing an
    // already-installed manifest never throws. Once resolved locally once,
    // subsequent calls in this same process take the ordinary cache-hit
    // return below without re-invoking the loader.
    if (
      requireLocalDefinition &&
      internals.sources.resolved.get(name)?.get(revision) === undefined
    ) {
      return { handle };
    }
    return { cached: existing };
  }

  return { handle };
}

/**
 * Load, validate, and install one dynamic workflow source revision
 * previously recorded via `engine.registerSource()`. Returns the installed
 * {@link WorkflowRevisionRecord} immediately, without invoking the loader
 * at all, when `(name, revision)` is already durably installed — including
 * a revision installed by a different process. When that is the case,
 * `internals.sources.resolved` is NOT populated for this key (there
 * is no locally-loaded `WorkflowDefinition` to stash — only the durable
 * manifest was ever read) even though the catalog itself considers the
 * revision installed; a caller reading `internals.sources.resolved` must
 * account for that gap rather than assuming every installed revision has a
 * live definition available in this process — see
 * {@link resolveWorkflowSourceForExecution} for the internal-only variant
 * that closes exactly this gap for callers that need a local definition.
 * This fast path still requires
 * `registerSource()` to have been called for this exact key first (see
 * {@link resolveCachedOrHandle}), and still validates a pinned
 * `workflowVersion`/`contractHash` against the cached manifest — the ONLY
 * thing it skips is re-invoking the loader and re-running
 * {@link import('../source/index.ts').validateResolvedWorkflowSource}.
 *
 * Single-flight per `(name, revision)` — see the module doc for the full
 * cancellation contract. Throws a plain `Error` when `registerSource()` was
 * never called for this exact key (a programmer error, not untrusted-input
 * rejection); throws {@link WorkflowSourceValidationError} when the loaded
 * module fails validation, OR when a cached manifest contradicts a pinned
 * `workflowVersion`/`contractHash`; throws {@link EngineDisposedError} when
 * the engine is disposed, either already or during the call; propagates
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
export async function resolveWorkflowSource(
  engine: Engine,
  name: string,
  revision: string,
  options?: ResolveWorkflowSourceOptions,
): Promise<WorkflowRevisionRecord> {
  return resolveWorkflowSourceCore(engine, name, revision, options, false);
}

/**
 * Internal-only variant of {@link resolveWorkflowSource} used exclusively by
 * `resolveExecutableRegistration()` (`dynamic-source-execution.ts`, WFT-15).
 * Identical cancellation, disposal, and single-flight contract, with one
 * difference: a cache hit whose local resolved-definition cache
 * (`internals.sources.resolved`) is still empty for this exact key falls
 * through to a real load instead of returning the cached manifest —
 * closing the cross-process-restart gap {@link resolveWorkflowSource}'s own
 * doc calls out. `catalog.install()` is idempotent on byte-identical
 * content, so re-installing an already-installed manifest never throws.
 * Not exported from the package root — reached only via
 * `resolveExecutableRegistration`.
 */
export async function resolveWorkflowSourceForExecution(
  engine: Engine,
  name: string,
  revision: string,
  options?: ResolveWorkflowSourceOptions,
): Promise<WorkflowRevisionRecord> {
  return resolveWorkflowSourceCore(engine, name, revision, options, true);
}

async function resolveWorkflowSourceCore(
  engine: Engine,
  name: string,
  revision: string,
  options: ResolveWorkflowSourceOptions | undefined,
  requireLocalDefinition: boolean,
): Promise<WorkflowRevisionRecord> {
  const internals = getInternals(engine);
  const waiter = createWaiterAbort(options);

  // Checked before touching storage, the shared-load map, or
  // `internals.sources.waiterControllers` — a pre-aborted signal on
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

  internals.sources.waiterControllers.add(waiter.controller);
  beginSourceWaiter(internals, name, revision);
  try {
    // Raced against this waiter's own abort signal, not just re-checked
    // after — `resolveCachedOrHandle()`'s awaits (catalog readiness, a
    // durable `resolveEntry` read, the pin-compatibility check) can stall
    // indefinitely on a slow storage backend; a `waiter.controller.signal
    // .aborted` check placed only AFTER that await would never run while
    // the await itself is still pending, leaving exactly the outstanding
    // waiter disposal promises to reject. Racing here settles this call the
    // moment the abort fires regardless of how long the catalog phase
    // takes — mirroring the identical race the shared-load phase below
    // already uses.
    const cachedOrHandle = resolveCachedOrHandle(
      engine,
      internals,
      name,
      revision,
      requireLocalDefinition,
    );
    const cachedOrHandleAbort = abortRejection(waiter.controller.signal);
    cachedOrHandleAbort.catch(() => {});
    let outcome: Awaited<typeof cachedOrHandle>;
    try {
      outcome = await Promise.race([cachedOrHandle, cachedOrHandleAbort]);
    } finally {
      // `resolveCachedOrHandle()` keeps running even when the abort side of
      // the race wins — swallow its eventual settle (fulfillment or
      // rejection) so a late one never surfaces as an unhandled rejection.
      cachedOrHandle.catch(() => {});
    }

    if (outcome.cached !== undefined) {
      return outcome.cached;
    }

    const shared = getOrCreateSharedSourceLoad(engine, internals, name, revision, outcome.handle);
    const waiterAbort = abortRejection(waiter.controller.signal);
    waiterAbort.catch(() => {});
    return await Promise.race([shared, waiterAbort]);
  } finally {
    waiter.detach();
    internals.sources.waiterControllers.delete(waiter.controller);
    endSourceWaiterAndDispatchCancellation(engine, internals, name, revision);
  }
}
