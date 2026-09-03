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
  incrementNestedRevisionCount,
  readNestedRevisionCount,
  totalWorkflowRevisionReferences,
  type WorkflowRevisionReferenceCounts,
} from '../catalog/index.ts';
import { WorkflowRevisionRemovedEvent } from '../events/catalog-events.ts';
import { ensureWorkflowCatalogReady, getWorkflowCatalog } from './catalog-readiness.ts';
import type { Engine } from './index.ts';
import { getInternals, type EngineInternals } from './internals.ts';

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
 */
export function reserveInFlightStart(internals: EngineInternals, type: string): string | undefined {
  const revision = internals.workflowCatalog?.resolveActive(type)?.revision;
  if (revision !== undefined) {
    incrementNestedRevisionCount(internals.inFlightStartsByRevision, type, revision);
  }
  return revision;
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
 * are real; the other five fields of {@link WorkflowRevisionReferenceCounts}
 * stay `0` until WFT-17 (see that type's own field-level docs).
 */
export async function countWorkflowRevisionReferences(
  engine: Engine,
  name: string,
  revision: string,
): Promise<WorkflowRevisionReferenceCounts> {
  const internals = getInternals(engine);
  return {
    registeredDefinitions: internals.registeredCatalogRevisions.get(name) === revision ? 1 : 0,
    inFlightStarts: readNestedRevisionCount(internals.inFlightStartsByRevision, name, revision),
    nonTerminalRuns: 0,
    pinnedSchedules: 0,
    pendingDispatches: 0,
    activeExecutionRealms: 0,
    retainedRecoveryRecords: 0,
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

  if (!(await catalog.hasInstalled(name, revision))) {
    return { removed: false, reason: 'not-found' };
  }

  const active = await catalog.resolveActiveDurable(name);
  if (active !== undefined && active.revision === revision) {
    return { removed: false, reason: 'active', activeRevision: active.revision };
  }

  const references = await countWorkflowRevisionReferences(engine, name, revision);
  if (totalWorkflowRevisionReferences(references) > 0) {
    return { removed: false, reason: 'referenced', references };
  }

  const result = await catalog.remove(name, revision);
  switch (result.outcome) {
    case 'removed':
      engine.dispatchEvent(new WorkflowRevisionRemovedEvent(name, revision));
      return { removed: true };
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

  return {
    name,
    revision,
    installed,
    active,
    ...(activePointer !== undefined ? { activeRevision: activePointer.revision } : {}),
    references,
    removable,
  };
}
