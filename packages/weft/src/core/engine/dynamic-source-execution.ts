/**
 * `resolveExecutableRegistration()` — the single async helper every
 * execution entry point that can launch or resume a workflow
 * (`start`/`startOrSignal`/`schedule`/`fork`/`resume`/recovery/bulk-retry)
 * funnels through to turn a workflow `type` into a `RegistrationEntry` it
 * can actually run (WFT-15/16).
 *
 * Fast path: an eagerly `engine.register()`-ed type resolves synchronously
 * from `internals.registrations` and never touches `internals.sources` —
 * this is what makes "starting the eager workflow does not import the lazy
 * module" true. Slow path: a `engine.registerSource()`-registered type is
 * resolved via `resolveWorkflowSourceForExecution()`, which awaits the
 * loader (single-flight, shared with any other concurrent caller for the
 * same key) and installs the result durably before this returns — so no
 * workflow handler ever runs while its definition is still a catalog
 * candidate.
 *
 * @module core/engine/dynamic-source-execution
 */

import type { WorkflowSourceHandle } from '../source/index.ts';
import { ensureWorkflowCatalogReady, getWorkflowCatalog } from './catalog-readiness.ts';
import { DynamicWorkflowSourceUnavailableError } from './dynamic-source-errors.ts';
import { EngineDisposedError, WorkflowNotRegisteredError } from './errors.ts';
import type { Engine } from './index.ts';
import type { EngineInternals } from './internals.ts';
import { assertConstraintsSupported, buildRegistrationEntry } from './registration.ts';
import { WorkflowRevisionUnavailableError } from './revision-errors.ts';
import { resolveWorkflowSourceForExecution } from './source-resolution.ts';

type RegistrationEntry =
  EngineInternals['registrations'] extends Map<string, infer Entry> ? Entry : never;

/** The outcome of {@link resolveExecutableRegistration}. */
export type ExecutableRegistration = {
  entry: RegistrationEntry;
  /** The dynamic source revision resolved, or `undefined` for an eager registration. */
  revision: string | undefined;
};

/**
 * Pick the target revision to resolve for a lazy `type` with two or more
 * `registerSource()`-registered candidates (the caller handles the
 * sole-candidate case itself, synchronously, before ever calling this — see
 * `resolveExecutableRegistration()`). Multiple registered candidates ARE
 * ambiguous without a pointer, so this reads the catalog's DURABLE active
 * pointer (`resolveActiveDurable()`, not the cached, sync `resolveActive()`)
 * — in a multi-engine `workflow-lease` deployment, a sibling engine can
 * durably activate a new revision after this engine's in-memory `#active`
 * cache last observed it, and only the durable read stays consistent with
 * that promotion. Throws {@link DynamicWorkflowSourceUnavailableError} with
 * `reason: 'ambiguous-revision'` without invoking either loader when no
 * pointer names one of the registered candidates.
 */
async function resolveActiveSourceRevision(
  engine: Engine,
  type: string,
  byRevision: ReadonlyMap<string, WorkflowSourceHandle>,
): Promise<string> {
  await ensureWorkflowCatalogReady(engine);
  const activePointer = await getWorkflowCatalog(engine).resolveActiveDurable(type);
  const activeRevision = activePointer?.revision;
  if (activeRevision !== undefined && byRevision.has(activeRevision)) {
    return activeRevision;
  }
  throw new DynamicWorkflowSourceUnavailableError(type, undefined, 'ambiguous-revision');
}

/**
 * Turn workflow `type` into an executable {@link RegistrationEntry}, awaiting
 * dynamic-source resolution when `type` is not eagerly registered. Throws
 * {@link WorkflowNotRegisteredError} when `type` is neither an eager
 * registration nor a registered source (the pre-existing error — see the
 * call site below for why); {@link DynamicWorkflowSourceUnavailableError}
 * when a registered source's target revision is ambiguous or its load
 * fails; {@link EngineDisposedError} unwrapped when the engine is disposed
 * during resolution.
 */
export async function resolveExecutableRegistration(
  engine: Engine,
  internals: EngineInternals,
  type: string,
  onRevisionChosen?: (revision: string) => void,
): Promise<ExecutableRegistration> {
  const eager = internals.registrations.get(type);
  if (eager !== undefined) {
    return { entry: eager, revision: undefined };
  }

  const byRevision = internals.sources.byName.get(type);
  if (byRevision === undefined) {
    // No eager registration AND no dynamic source at all for `type` — this
    // is byte-for-byte the same "nothing this engine could ever run" case
    // the pre-WFT-15/16 synchronous lookup covered, so it keeps throwing
    // the pre-existing `WorkflowNotRegisteredError` rather than the new
    // `WorkflowSourceNotRegisteredError` (reserved for a source that WAS
    // registered but whose specific requested revision was not — see
    // `dynamic-source-errors.ts`). This preserves the observable
    // `WorkflowNotRegisteredError` fault classification and wire code for
    // every start/startOrSignal/schedule/fork/resume caller unregistered
    // callers already depended on (client-contract.test-support.ts #465).
    throw new WorkflowNotRegisteredError(type);
  }

  // The sole-registered-revision case is unambiguous by construction and is
  // handled entirely synchronously here — no `await` between reading
  // `byRevision` and firing `onRevisionChosen` — so the reservation promise
  // documented on `resolveExecutableRegistration` above holds even for this
  // fast path. Routing it through the async `resolveActiveSourceRevision()`
  // instead would insert a microtask gap before `onRevisionChosen` fires,
  // reopening the exact concurrent-`removeWorkflowRevision()` window that
  // hook exists to close.
  let revision: string;
  if (byRevision.size === 1) {
    revision = [...byRevision.keys()][0]!;
    onRevisionChosen?.(revision);
  } else {
    revision = await resolveActiveSourceRevision(engine, type, byRevision);
    onRevisionChosen?.(revision);
  }

  return loadAndInstallSourceRevision(engine, internals, type, revision);
}

/**
 * Shared tail of {@link resolveExecutableRegistration} and
 * {@link resolveExecutableRegistrationForRevision}: await the load, then
 * install the resulting local definition into every registry a caller of
 * either function needs populated. Split out so both resolvers install a
 * newly-loaded dynamic source identically.
 */
async function loadAndInstallSourceRevision(
  engine: Engine,
  internals: EngineInternals,
  type: string,
  revision: string,
): Promise<ExecutableRegistration> {
  try {
    await resolveWorkflowSourceForExecution(engine, type, revision);
  } catch (error) {
    if (error instanceof EngineDisposedError) throw error;
    throw new DynamicWorkflowSourceUnavailableError(type, revision, 'load-failed', error);
  }

  const resolved = internals.sources.resolved.get(type)?.get(revision);
  if (resolved === undefined) {
    // Unreachable in practice: `resolveWorkflowSourceForExecution()`'s whole
    // contract is that a successful resolve populates
    // `internals.sources.resolved` for this exact key. Fail loud rather than
    // silently building a registration from nothing.
    throw new DynamicWorkflowSourceUnavailableError(
      type,
      revision,
      'load-failed',
      new Error('Dynamic workflow source resolved without populating a local definition'),
    );
  }

  assertConstraintsSupported(internals, type, resolved.definition);
  const entry = buildRegistrationEntry(type, resolved.definition);
  internals.activityRegistriesByWorkflow.set(type, resolved.activityRegistry);
  internals.workflowTypesByHandler.set(resolved.definition.handler, type);
  internals.sources.lastResolvedRevisionByName.set(type, revision);
  return { entry, revision };
}

/**
 * Resolve workflow `type` against its EXACT pinned `revision` — the
 * `WorkflowState.revision` a run persisted at start (WFT-17) — instead of
 * whichever revision the catalog currently considers active. This is the
 * resolver `resumeWorkflowFromStorage()` (`lifecycle/resume.ts`) uses for
 * EVERY resume (both `recoverAll()`'s batch and a standalone
 * `engine.resume(id)`), so "recovery never falls back from a missing exact
 * revision to the active revision" (WFT-17/WFT-18's acceptance criterion)
 * holds uniformly, not just inside the batch preflight.
 *
 * Classification:
 * - An eager registration is always resolved from `internals.registrations`
 *   regardless of `revision` — eager has no ambiguity to pin against (the
 *   process runs whatever code it has loaded), so a stale or absent pin on
 *   an eager type is harmless and must not block the common redeploy path.
 * - A dynamic source with `revision === undefined` (a legacy, pre-pinning
 *   record) falls through to the ordinary {@link resolveExecutableRegistration}
 *   active-pointer resolution when the type has at most one registered
 *   candidate (unambiguous by construction), or throws
 *   {@link WorkflowRevisionUnavailableError} with `reason: 'legacy-ambiguous'`
 *   when it has two or more (there is no way to tell which one the run
 *   actually started against).
 * - A dynamic source with a defined `revision` throws
 *   {@link WorkflowRevisionUnavailableError} with `reason: 'not-registered'`
 *   when that exact revision is not among this process's registered
 *   candidates (covers both "never registered at all" and "was the sole
 *   candidate, but a different one is registered now") — otherwise it is
 *   loaded and installed exactly like {@link resolveExecutableRegistration}'s
 *   own dynamic path.
 * - `type` with neither an eager registration nor any registered source
 *   throws the pre-existing {@link WorkflowNotRegisteredError}, matching
 *   {@link resolveExecutableRegistration}.
 */
export async function resolveExecutableRegistrationForRevision(
  engine: Engine,
  internals: EngineInternals,
  type: string,
  revision: string | undefined,
): Promise<ExecutableRegistration> {
  const eager = internals.registrations.get(type);
  if (eager !== undefined) {
    return { entry: eager, revision: undefined };
  }

  const byRevision = internals.sources.byName.get(type);
  if (byRevision === undefined) {
    throw new WorkflowNotRegisteredError(type);
  }

  if (revision === undefined) {
    if (byRevision.size <= 1) {
      return resolveExecutableRegistration(engine, internals, type);
    }
    throw new WorkflowRevisionUnavailableError(type, undefined, 'legacy-ambiguous');
  }

  if (!byRevision.has(revision)) {
    throw new WorkflowRevisionUnavailableError(type, revision, 'not-registered');
  }

  return loadAndInstallSourceRevision(engine, internals, type, revision);
}

/**
 * Wraps `callbacks.resolveExecutableRegistration(type)`, remapping ONLY the
 * "no source registered at all" case (a {@link WorkflowNotRegisteredError})
 * to `notFoundError` — a caller's own, more-specific "no workflow
 * registered" message (naming the workflow ID it was
 * resuming/forking/retrying, for example) instead of the generic one. Every
 * other error (including a source found but unresolvable) propagates
 * unwrapped. Shared by `resume.ts`, `transition.ts`'s `fork()`, and
 * `bulk-operations.ts`'s retry path so each keeps a single, low-complexity
 * call site instead of its own try/catch.
 */
export async function resolveExecutableRegistrationOrRenamedNotFound(
  resolve: (type: string) => Promise<ExecutableRegistration>,
  type: string,
  notFoundError: () => Error,
): Promise<ExecutableRegistration> {
  return resolve(type).catch((error: unknown) => {
    if (error instanceof WorkflowNotRegisteredError) {
      throw notFoundError();
    }
    throw error;
  });
}

/**
 * {@link resolveExecutableRegistrationOrRenamedNotFound}, pre-bound to
 * `bulk-operations.ts`'s retry-failed message shape. Kept here (with the
 * bulk of the logic off `bulk-operations.ts`, already at its own
 * oxlint `max-lines` ceiling) rather than inlined at that one call site.
 */
export async function resolveExecutableRegistrationForRetry(
  internals: EngineInternals,
  type: string,
  workflowId: string,
): Promise<ExecutableRegistration> {
  return resolveExecutableRegistrationOrRenamedNotFound(
    (t) => resolveExecutableRegistration(internals.engine as unknown as Engine, internals, t),
    type,
    () => new Error(`No workflow registered with name "${type}" (needed to retry "${workflowId}")`),
  );
}

/**
 * Sync-only fallback lookup for call sites that run after a workflow is
 * already executing and must never trigger a new resolve —
 * `termination/finalizer.ts` and `constraints.ts`. Reads the eager
 * registration first, then falls back to building a `RegistrationEntry`
 * from the most recently resolved dynamic-source definition for `type`
 * (`internals.sources.lastResolvedRevisionByName` /
 * `internals.sources.resolved`), matching the same last-resolved-revision-wins
 * rule {@link resolveExecutableRegistration} applies when writing those
 * fields. Returns `undefined` when neither source has an entry.
 */
export function getResolvedDynamicRegistration(
  internals: EngineInternals,
  type: string,
): RegistrationEntry | undefined {
  const eager = internals.registrations.get(type);
  if (eager !== undefined) return eager;

  const revision = internals.sources.lastResolvedRevisionByName.get(type);
  if (revision === undefined) return undefined;

  const resolved = internals.sources.resolved.get(type)?.get(revision);
  if (resolved === undefined) return undefined;

  return buildRegistrationEntry(type, resolved.definition);
}
