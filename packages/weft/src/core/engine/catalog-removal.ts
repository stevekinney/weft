/**
 * Reference accounting and removal for the durable workflow catalog
 * (WFT-12): counts in-process references to a `(name, revision)`,
 * decides whether removal is safe, and performs the removal itself —
 * dispatching `WorkflowRevisionRemovedEvent` on success.
 *
 * Also owns the two `EngineInternals.inFlightStartsByRevision` accessors
 * ({@link reserveInFlightStart}/{@link releaseInFlightStart}) that
 * `lifecycle/start.ts` rides alongside its existing `pendingStarts`
 * reservation try/finally, kept here rather than inline in `start.ts` to
 * stay well under that file's line-count ceiling.
 *
 * @module core/engine/catalog-removal
 */

import {
  decrementNestedRevisionCount,
  finalizeCatalogTombstone,
  incrementNestedRevisionCount,
  readNestedRevisionCount,
  restoreCatalogEntryFromTombstone,
  totalWorkflowRevisionReferences,
  type WorkflowRevisionReferenceCounts,
} from '../catalog/index.ts';
import { WorkflowRevisionRemovedEvent } from '../events/catalog-events.ts';
import type { WorkflowSourceKind } from '../source/index.ts';
import { ensureWorkflowCatalogReady, getWorkflowCatalog } from './catalog-readiness.ts';
import { resolveCatalogTombstoneIfPresent } from './catalog-tombstone-recovery.ts';
import type { Engine } from './index.ts';
import { getInternals, type EngineInternals } from './internals.ts';
import { countWorkflowStateRevisionsByStatus } from './nonterminal-revision-count.ts';
import { countPinnedSchedulesForRevision } from './pinned-schedule-revision-count.ts';
import { countTeardownDeadLettersForRevision } from './retained-recovery-record-count.ts';
import { readSourceLoadDiagnostics, readSourceWaiterCount } from './source-diagnostics.ts';
import type { SourceLoadDiagnostics } from './source-runtime-state.ts';

type RegistrationEntry =
  EngineInternals['registrations'] extends Map<string, infer Entry> ? Entry : never;

/**
 * Reserve one in-flight-start slot against `type`'s currently active
 * revision (if any), returning the revision reserved (or `undefined` when
 * `type` has no active revision yet — a start under a still-warming
 * catalog, which `Engine.start()`'s own `ensureWorkflowCatalogReady` await
 * prevents in practice). Called once, synchronously, before
 * `startWorkflow`'s `try` block; the returned value is captured by the
 * caller and passed back to {@link releaseInFlightStart} in its `finally` —
 * never re-resolved, so a concurrent activation moving the pointer
 * mid-start cannot decrement a different revision than was incremented.
 *
 * `revisionOverride` (WFT-15/16) is the revision `resolveExecutableRegistration()`
 * already resolved for a `registerSource()`-registered `type` — passed
 * through instead of re-deriving via `catalog.resolveActive(type)`, which
 * would read `undefined` for a dynamic source with no catalog active
 * pointer set (a source can resolve and install without ever being
 * `engine.workflows.activate()`-d), making `inFlightStarts` diagnostics
 * silently miss a lazy run in flight. `undefined` (the default) preserves
 * the eager-path behavior byte-for-byte.
 */
export function reserveInFlightStart(
  internals: EngineInternals,
  type: string,
  revisionOverride?: string,
): string | undefined {
  const revision = revisionOverride ?? internals.workflowCatalog?.resolveActive(type)?.revision;
  if (revision !== undefined) {
    incrementNestedRevisionCount(internals.inFlightStartsByRevision, type, revision);
  }
  return revision;
}

/**
 * `startWorkflow`'s combined "resolve `type`, reserve an `inFlightStarts`
 * slot for the resolved revision" step. Reserves EARLY — before the loader
 * is awaited, via `resolve()`'s `onRevisionChosen` hook — for a lazy type,
 * closing the window where a concurrent `removeWorkflowRevision()` could
 * observe zero references against a revision this call's own source load
 * is about to durably (re)install; reserves afterward for an eager type,
 * exactly as before WFT-15/16 (that path never invokes the hook). If the
 * loader then fails — `resolve()` rejects AFTER the hook already fired — the
 * early reservation is released here before rethrowing: `startWorkflow`
 * only assigns its own `inFlightRevision` on a successful return, so its
 * `finally` releases nothing on this path and the increment would otherwise
 * leak forever, permanently reporting the revision non-`removable`.
 *
 * `resolvedRevision` is the raw value `resolve()` itself returned —
 * `undefined` for an eager registration, the resolved candidate for a
 * dynamic source — distinct from `inFlightRevision`, which for an eager
 * type falls back to the catalog's cached ACTIVE pointer (see
 * {@link reserveInFlightStart}). A caller that needs "the exact revision of
 * the code this process is about to run" (WFT-17's `WorkflowState.revision`)
 * must use `resolvedRevision`, not `inFlightRevision` — the two intentionally
 * diverge for an eager type under a multi-engine deployment where this
 * process's own registration lags the durable active pointer.
 */
export async function resolveAndReserveExecutableRegistration(
  internals: EngineInternals,
  type: string,
  resolve: (
    type: string,
    onRevisionChosen?: (revision: string) => void,
  ) => Promise<{ entry: RegistrationEntry; revision: string | undefined }>,
): Promise<{
  registration: RegistrationEntry;
  inFlightRevision: string | undefined;
  resolvedRevision: string | undefined;
}> {
  let earlyReservation: string | undefined;
  try {
    const { entry: registration, revision } = await resolve(type, (chosen) => {
      earlyReservation = reserveInFlightStart(internals, type, chosen);
    });
    const inFlightRevision =
      earlyReservation !== undefined
        ? earlyReservation
        : reserveInFlightStart(internals, type, revision);
    return { registration, inFlightRevision, resolvedRevision: revision };
  } catch (error) {
    releaseInFlightStart(internals, type, earlyReservation);
    throw error;
  }
}

/** Release the slot {@link reserveInFlightStart} reserved; a no-op when `revision` is `undefined`. */
export function releaseInFlightStart(
  internals: EngineInternals,
  type: string,
  revision: string | undefined,
): void {
  if (revision !== undefined) {
    decrementNestedRevisionCount(internals.inFlightStartsByRevision, type, revision);
  }
}

/**
 * Count every in-process reference this batch wires to a real signal
 * against `(name, revision)`. `registeredDefinitions` and `inFlightStarts`
 * are in-memory, constant-time lookups; `nonTerminalRuns` (WFT-17 — see
 * {@link countNonTerminalRunsForRevision}) is an UNBOUNDED, full `wf:`-prefix
 * durable scan — the same shape `groupActiveWorkflowsByType` already uses
 * elsewhere for this class of diagnostic, so it's consistent with how this
 * codebase already pays for this, but it is O(n) in the total number of
 * workflow records, not bounded by `(name, revision)`. `removeWorkflowRevision()`
 * calls this TWICE per removal attempt (its own pre-check, and
 * {@link finalizeRevisionRemoval}'s post-check) — worth knowing before
 * wiring `removeWorkflowRevision()` into an automated cleanup path on a
 * large durable store, rather than the operator-triggered use this batch
 * assumes. `pinnedSchedules` is ALSO an unbounded, full `schedule:`-prefix
 * durable scan (WFT-20 — see {@link countPinnedSchedulesForRevision}), and
 * `retainedRecoveryRecords` (WFT-21) adds a THIRD unbounded scan (its
 * `TeardownDeadLetterRecord` component — see
 * {@link countTeardownDeadLettersForRevision}), while its OTHER component
 * (a terminal-but-unpurged `WorkflowState`) rides the same `wf:` scan
 * `nonTerminalRuns` already pays for — see
 * {@link countWorkflowStateRevisionsByStatus}, which returns both buckets
 * from one pass. The remaining two fields of
 * {@link WorkflowRevisionReferenceCounts} stay `0` — the dispatch ledger
 * and execution realms are out of this batch's scope.
 */
export async function countWorkflowRevisionReferences(
  engine: Engine,
  name: string,
  revision: string,
): Promise<WorkflowRevisionReferenceCounts> {
  const internals = getInternals(engine);
  const { nonTerminalRuns, terminalRuns } = await countWorkflowStateRevisionsByStatus(
    internals.storage,
    name,
    revision,
  );
  const pinnedSchedules = await countPinnedSchedulesForRevision(internals.storage, name, revision);
  const deadLetters = await countTeardownDeadLettersForRevision(internals.storage, name, revision);
  return {
    registeredDefinitions: internals.registeredCatalogRevisions.get(name) === revision ? 1 : 0,
    inFlightStarts: readNestedRevisionCount(internals.inFlightStartsByRevision, name, revision),
    nonTerminalRuns,
    pinnedSchedules,
    pendingDispatches: 0,
    activeExecutionRealms: 0,
    retainedRecoveryRecords: terminalRuns + deadLetters,
  };
}

/**
 * Outcome of {@link removeWorkflowRevision}.
 *
 * @example
 * ```ts
 * import type { WorkflowCatalogRemovalResult } from '@lostgradient/weft';
 *
 * function describe(result: WorkflowCatalogRemovalResult): string {
 *   return result.removed ? 'removed' : `kept: ${result.reason}`;
 * }
 * void describe;
 * ```
 */
export type WorkflowCatalogRemovalResult =
  | Readonly<{ removed: true }>
  | Readonly<{ removed: false; reason: 'not-found' }>
  | Readonly<{ removed: false; reason: 'active'; activeRevision: string }>
  | Readonly<{ removed: false; reason: 'referenced'; references: WorkflowRevisionReferenceCounts }>
  | Readonly<{ removed: false; reason: 'conflict' }>;

/**
 * Remove `(name, revision)` from the durable workflow catalog. Refuses when
 * the revision is not installed (`'not-found'`), is the currently active
 * revision (`'active'`), or is referenced by any nonzero count in
 * {@link countWorkflowRevisionReferences} (`'referenced'`, carrying the
 * full breakdown so a caller can report exactly what is still holding the
 * revision). Refuses with `'conflict'` when the durable delete's own
 * compare-and-swap loses to a concurrent writer — the caller may re-read
 * and retry. Dispatches `catalog:revision-removed` on success.
 *
 * Checks references BOTH before and after the durable delete (WFT-17,
 * Codex review on PR #958). The pre-check above is an OPTIMIZATION — it
 * refuses upfront in the common case, avoiding a needless delete-then-restore
 * round trip — but is not, on its own, the guarantee: a concurrent
 * `engine.start()` on a DIFFERENT process could read the entry as still
 * installed, and commit a NEW run pinned to `revision`, in the narrow
 * window between this function's pre-check scan and its own delete CAS
 * landing; the pre-check's zero-references snapshot would then be stale
 * by the time the delete actually commits. The POST-check closes this: it
 * is safe to trust because `start-commit.ts`'s own start batch fences on
 * this exact catalog entry's bytes (`buildCatalogEntryStartPrecondition`)
 * — `conditionalBatch`'s precondition is evaluated against LIVE storage
 * state at commit time, so ANY start whose commit lands after this
 * function's delete necessarily loses its own CAS and never creates the
 * reference at all. A nonzero post-delete count can therefore only be a
 * run that committed BEFORE the delete — this function restores the entry
 * and reports `'referenced'` rather than leaving a real, still-referenced
 * run pinned to a revision the catalog no longer carries.
 *
 * `catalog.remove()`'s delete and `finalizeRevisionRemoval`'s restore-or-
 * finalize used to be two SEPARATE commits (WFT-17/18, Codex review on PR
 * #958): a process crash between them left the revision durably uninstalled
 * with NO durable record of what was deleted, recoverable by no one. Both
 * halves of `removeCatalogEntry` (the delete) now land in ONE
 * `conditionalBatch` with a `catalog-tombstone:<name>:<revision>` record
 * (the exact deleted bytes) — see `core/catalog/removal.ts`'s module doc —
 * so this function's own restore-or-finalize below is itself a SECOND
 * atomic operation (not a bare `install()`/no-op), and a crash between the
 * two commits leaves a durable tombstone ANY process can resolve, not just
 * this one. `catalog-tombstone-recovery.ts`'s boot-time sweep and this
 * function's own targeted pre-check (below) both close that residual
 * window; see that module's doc for the full mechanism.
 *
 * @example
 * ```ts
 * import { Engine, removeWorkflowRevision, workflow } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.register(workflow({ name: 'checkout', version: '1.0.0' }).execute(
 *   async function* () { return 'ok'; },
 * ));
 * const result = await removeWorkflowRevision(engine, 'checkout', 'some-old-revision');
 * if (!result.removed) console.log('kept:', result.reason);
 * ```
 */
export async function removeWorkflowRevision(
  engine: Engine,
  name: string,
  revision: string,
): Promise<WorkflowCatalogRemovalResult> {
  await ensureWorkflowCatalogReady(engine);
  const catalog = getWorkflowCatalog(engine);
  const internals = getInternals(engine);

  // A stale tombstone from an EARLIER, unresolved removal of this EXACT
  // `(name, revision)` key (a peer process crashed after this engine's own
  // boot-time sweep already ran — see `catalog-tombstone-recovery.ts`)
  // would otherwise make `removeCatalogEntry`'s own CAS below fail closed
  // with `'conflict'` forever, since it requires the tombstone key absent.
  // Resolving it first — one extra `storage.get` on the common,
  // no-tombstone path — lets a fresh removal decision proceed normally.
  await resolveCatalogTombstoneIfPresent(internals.storage, name, revision);

  if (!(await catalog.hasInstalled(name, revision))) {
    return { removed: false, reason: 'not-found' };
  }

  const active = await catalog.resolveActiveDurable(name);
  if (active !== undefined && active.revision === revision) {
    return { removed: false, reason: 'active', activeRevision: active.revision };
  }

  const preReferences = await countWorkflowRevisionReferences(engine, name, revision);
  if (totalWorkflowRevisionReferences(preReferences) > 0) {
    return { removed: false, reason: 'referenced', references: preReferences };
  }

  const result = await catalog.remove(name, revision);
  switch (result.outcome) {
    case 'removed':
      return finalizeRevisionRemoval(engine, name, revision, result.tombstoneBytes);
    case 'not-found':
      return { removed: false, reason: 'not-found' };
    case 'active':
      return { removed: false, reason: 'active', activeRevision: result.activeRevision };
    case 'conflict':
      return { removed: false, reason: 'conflict' };
    default: {
      const exhaustive: never = result;
      throw new Error(`Unknown workflow catalog removal outcome: ${String(exhaustive)}`);
    }
  }
}

/**
 * The post-delete half of {@link removeWorkflowRevision}'s TOCTOU defense
 * (split out to keep that function under the complexity ceiling): re-counts
 * references now that `catalog.remove()` has actually committed, and — if a
 * reference appeared in the narrow window between the pre-check and this
 * commit (see the removal-race note above `removeWorkflowRevision`) —
 * atomically restores the just-tombstoned entry from `tombstoneBytes`
 * (`restoreCatalogEntryFromTombstone`) rather than leaving a real run
 * pinned to a revision the catalog no longer carries. Otherwise atomically
 * finalizes the tombstone (`finalizeCatalogTombstone`), completing the
 * removal. Either resolution losing its own CAS (a concurrent boot-time
 * sweep or another `removeWorkflowRevision` call already resolved this
 * exact tombstone first) is a harmless, already-consistent no-op — nothing
 * further to do either way.
 */
async function finalizeRevisionRemoval(
  engine: Engine,
  name: string,
  revision: string,
  tombstoneBytes: Uint8Array,
): Promise<WorkflowCatalogRemovalResult> {
  const internals = getInternals(engine);
  const postReferences = await countWorkflowRevisionReferences(engine, name, revision);
  if (totalWorkflowRevisionReferences(postReferences) > 0) {
    await restoreCatalogEntryFromTombstone(internals.storage, name, revision, tombstoneBytes);
    return { removed: false, reason: 'referenced', references: postReferences };
  }
  await finalizeCatalogTombstone(internals.storage, name, revision, tombstoneBytes);
  engine.dispatchEvent(new WorkflowRevisionRemovedEvent(name, revision));
  return { removed: true };
}

/**
 * Bounded diagnostics projection for one `(name, revision)`, backing
 * `weft.catalog.diagnostics` and `removeWorkflowRevision`'s own pre-check.
 *
 * @example
 * ```ts
 * import type { WorkflowRevisionDiagnostics } from '@lostgradient/weft';
 *
 * function isSafeToRemove(diagnostics: WorkflowRevisionDiagnostics): boolean {
 *   return diagnostics.removable;
 * }
 * void isSafeToRemove;
 * ```
 */
export type WorkflowRevisionDiagnostics = Readonly<{
  name: string;
  revision: string;
  installed: boolean;
  active: boolean;
  activeRevision?: string;
  references: WorkflowRevisionReferenceCounts;
  removable: boolean;
  /**
   * Dynamic-source load diagnostics (WFT-15/16), present only when `name`
   * has an entry in `internals.sources.byName` — i.e. `name` has ever been
   * `registerSource()`-registered on this engine. `undefined` for a purely
   * eager name, or a dynamic source this process has never heard of.
   */
  source?: {
    kind: import('../source/index.ts').WorkflowSourceKind;
    requestedRevision: string;
    state: import('./source-runtime-state.ts').SourceLoadState;
    loadDurationMs?: number;
    lastFailureCategory?: import('../types/identity.ts').FailureCategory;
    waiterCount: number;
  };
}>;

/**
 * Bounded diagnostics for one `(name, revision)`: whether it is installed,
 * whether it is the currently active revision (and what the active
 * revision is, when different), its full reference-count breakdown, and
 * whether {@link removeWorkflowRevision} would currently succeed against
 * it (`removable`). Never returns raw manifest or contract content — only
 * identity and counts.
 *
 * @example
 * ```ts
 * import { Engine, getWorkflowRevisionDiagnostics } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * const diagnostics = await getWorkflowRevisionDiagnostics(engine, 'checkout', 'some-revision');
 * console.log(diagnostics.installed, diagnostics.removable);
 * ```
 */
export async function getWorkflowRevisionDiagnostics(
  engine: Engine,
  name: string,
  revision: string,
): Promise<WorkflowRevisionDiagnostics> {
  await ensureWorkflowCatalogReady(engine);
  const catalog = getWorkflowCatalog(engine);

  const installed = await catalog.hasInstalled(name, revision);
  const activePointer = await catalog.resolveActiveDurable(name);
  const active = activePointer !== undefined && activePointer.revision === revision;
  const references = await countWorkflowRevisionReferences(engine, name, revision);
  const removable = installed && !active && totalWorkflowRevisionReferences(references) === 0;
  const source = buildSourceDiagnostics(getInternals(engine), name, revision);

  return {
    name,
    revision,
    installed,
    active,
    ...(activePointer !== undefined ? { activeRevision: activePointer.revision } : {}),
    references,
    removable,
    ...(source !== undefined ? { source } : {}),
  };
}

/**
 * The `kind` a {@link buildSourceDiagnostics} result reports: the live
 * diagnostics entry's kind once a load has started, else the registered
 * handle's own descriptor kind, else `'module'` — the only kind that
 * exists today — as a last-resort fallback for a name registered under a
 * different revision than the one requested.
 */
function resolveDiagnosticsSourceKind(
  diagnostics: SourceLoadDiagnostics | undefined,
  registeredRevisions: ReadonlyMap<string, { descriptor: { kind: WorkflowSourceKind } }>,
  revision: string,
): WorkflowSourceKind {
  if (diagnostics !== undefined) return diagnostics.kind;
  const registered = registeredRevisions.get(revision);
  return registered === undefined ? 'module' : registered.descriptor.kind;
}

/** The `source` field of {@link WorkflowRevisionDiagnostics}, or `undefined` when `name` was never `registerSource()`-registered on this engine. */
function buildSourceDiagnostics(
  internals: EngineInternals,
  name: string,
  revision: string,
): WorkflowRevisionDiagnostics['source'] {
  const registeredRevisions = internals.sources.byName.get(name);
  if (registeredRevisions === undefined) return undefined;

  const diagnostics = readSourceLoadDiagnostics(internals, name, revision);
  return {
    kind: resolveDiagnosticsSourceKind(diagnostics, registeredRevisions, revision),
    requestedRevision: revision,
    state: diagnostics === undefined ? 'idle' : diagnostics.state,
    ...(diagnostics?.loadDurationMs !== undefined && {
      loadDurationMs: diagnostics.loadDurationMs,
    }),
    ...(diagnostics?.lastFailureCategory !== undefined && {
      lastFailureCategory: diagnostics.lastFailureCategory,
    }),
    waiterCount: readSourceWaiterCount(internals, name, revision),
  };
}
